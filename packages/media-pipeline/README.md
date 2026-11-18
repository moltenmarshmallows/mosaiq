# @vmp/media-pipeline

VMP media orchestration around **[SVT Encore](https://svt.github.io/encore/)** — watchfolder/TUS intake → distributed encode workers → Shaka HLS packaging → private B2/S3 → HMAC callback to `@vmp/api`.

## Deployment: two compose files

| File                             | Runs                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.coordinator.yml` | Redis, `encore-web` (API only — `POLL_DISABLED`), `encore-packager`, `tusd`, `vmp-supervisor` (dashboard/webhooks/metrics). Optional `observability` profile adds Prometheus + Grafana + redis-exporter.                                                                    |
| `docker-compose.worker.yml`      | `worker` image (`worker/Dockerfile`): probes real encodes NVENC → VAAPI → CPU, heartbeats the backend to the supervisor, polls the matching Encore queues. `--profile nvidia` / `--profile vaapi` variants pass the GPU device; `--profile packager` adds a local packager. |

### Minimal example (one host)

```bash
cd packages/media-pipeline
cp .env.example .env   # fill secrets + B2 values
# The media dirs below must exist + be writable by tusd (uid 1000) / supervisor:
echo "ENCORE_MEDIA_MOUNT=$PWD/media" >> .env
mkdir -p media/tus-uploads media/videos/inbox-fast-lane \
  media/videos/inbox-full-ladder media/tmp/video_pipeline
docker compose -f docker-compose.coordinator.yml --env-file .env up -d
docker compose -f docker-compose.worker.yml      --env-file .env up -d
```

Dashboard: `http://127.0.0.1:8788` (secret = `VMP_SUPERVISOR_DASHBOARD_SECRET`). Drop a `.mp4` into `media/videos/inbox-fast-lane/` and watch it flow.

### Scale out (LAN/cloud)

1. On the worker host, mount the **same media tree** at the host path in `ENCORE_MEDIA_MOUNT` (default `/mnt` — set `ENCORE_MEDIA_MOUNT=/media` if you mounted NFS there). It is bind-mounted to `/media` inside containers — same paths everywhere is the contract.
2. Copy `docker-compose.worker.yml` + `.env` over, set `VMP_COORDINATOR=<coordinator host/IP>` and `VMP_REDIS_BIND`/`VMP_UI_BIND` on the coordinator so Redis + supervisor are LAN-reachable.
3. `docker network create vmp-media` once, then `docker compose -f docker-compose.worker.yml --env-file .env --profile nvidia up -d` (or `vaapi`, or plain CPU `worker`).

Remote `--profile packager` instances need `PACKAGER_ENCORE_BASE_URL` + `PACKAGER_SUPERVISOR_BASE_URL` on the coordinator pointing at origins the worker host can resolve — with the Docker-name defaults they can only serve aggregate jobs.

Every worker registers in the dashboard's **Encode workers** table and immediately adds concurrency. GPU workers drain GPU-class jobs first, then CPU work; CPU workers can never take a GPU-profile job.

> **Deploy cutover:** swapping the coordinator stack does not migrate jobs already queued in the old Redis — drain the queue (dashboard queue depth → 0) or accept that in-flight jobs stay with the old stack until it is shut down. Workers are stateless and can be scaled/replaced anytime.

> **GPU fleet caveat:** jobs already queued on a GPU-class queue keep their target backend — a `*-gpu-vaapi` job will wait for a vaapi worker even if the fleet later becomes nvenc-only. Backend choice happens at submit time from the live registry.

> **Credentials on untrusted links:** the supervisor speaks plain HTTP — packager/tusd callbacks (`CALLBACK_URL`, `-hooks-http`) and worker heartbeats carry secrets in URLs/headers. Inside the `vmp-media` network that's fine, but if any callback crosses a host boundary over an untrusted network, put a TLS-terminating reverse proxy in front of the supervisor and point `PACKAGER_CALLBACK_URL`/hooks/`VMP_SUPERVISOR_URL` at `https://…`. Redis is protected by `VMP_REDIS_PASSWORD` but is not encrypted — same rule applies (`WORKER_REDIS_URI` can carry `rediss://` if you tunnel).

### How capability routing works

Encore's two priority queues become **capability classes** (`encorePriorities.ts`):

- priority ≥ 50 → **queue 0, GPU class** (polled only by GPU workers via `poll-higher-prio`)
- priority < 50 → **queue 1, CPU class** (all workers)

The pipeline asks the worker registry (`workerRegistry.ts`, Redis-backed heartbeats at `/api/workers/heartbeat`) which backends are **live right now**, then picks `*-gpu-nvenc` / `*-gpu-vaapi` profile variants only when a matching worker exists — otherwise the plain CPU profile. The coordinator's own GPU is irrelevant; profile choice always follows the fleet.

### `VMP_LADDER_SPLIT`

- `job` (default): one Encore job encodes the whole ABR ladder.
- `renditions`: one Encore job per resolution — 1080p/720p/480p can run on different workers concurrently. The supervisor serves a merged job document at `/vmp/api/encoreJobAggregate/:id` so the stock packager still sees one ladder.

### Intake

- **Watchfolders** — `INBOX_FAST_LANE_DIR` → fast-lane (720p preview first, then ladder), `INBOX_FULL_LADDER_DIR` → ladder only.
- **TUS resumable uploads** — `tusd` accepts uploads; the supervisor proxies `/vmp/uploads` (dashboard-secret auth) and `tusd`'s post-finish hook moves completed files into the same inboxes. `meta_data.pipelineMode=full_ladder|fast_lane`, optional `meta_data.videoId`. Clients upload with any tus client to `POST {supervisor}/vmp/uploads` + Bearer dashboard secret.
- **Remote uploads (B2 hop)** — admins upload browser-direct to B2 at `videos/{id}/source.{ext}` via `@vmp/api` multipart presigning (`POST /api/admin/videos/uploads…`). On completion the API calls `POST /vmp/api/ingest` (HMAC, `VMP_WEBHOOK_SECRET`); the supervisor fetches the file **through the API's `/api/video-proxy`** — B2→Cloudflare egress is free, so testing costs nothing — and drops it into the inbox like a NAS drop. The raw MP4 is playable via the same proxy while HLS encodes; the `fully_processed` callback deletes it.

### B2 bucket setup (one-time, `b2` CLI)

Backblaze isn't in Terraform — configure the bucket once:

```bash
b2 bucket update "$B2_BUCKET_NAME" allPrivate \
  --lifecycle-rules '[{"fileNamePrefix":"","daysFromStartingToCancelingUnfinishedLargeFiles":7}]' \
  --cors-rules '[{"corsRuleName":"mosaiq-browser-uploads","allowedOrigins":["https://staging.app.mosaiq.video","https://app.mosaiq.video"],"allowedOperations":["s3_put","s3_head","s3_get","s3_delete"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]'
```

- Lifecycle: `bucket update --lifecycle-rules` **replaces** the whole rule list — merge new rules with existing ones (`b2 bucket get`) instead of clobbering them. `daysFromStartingToCancelingUnfinishedLargeFiles` abandons multipart uploads after 7 days (the only leak presigning can leave). Reclaiming completed uploads: add `{"fileNamePrefix":"videos/","daysFromHidingToDeleting":N}` when your retention policy allows it — the `fully_processed` callback deletes current `source.*` objects, but **sweeping current object keys does not remove hidden versions**; only a hide→delete rule or deleting by version ID reclaims that storage.
- CORS: **required** for the browser PUTs to B2's S3 endpoint and for reading the `ETag` back. The rule is named (`corsRuleName: mosaiq-browser-uploads`) — keep the same name on updates or B2 appends a duplicate rule.

### Observability

- `GET /metrics` on the supervisor — Prometheus exposition: queue depth, active jobs by stage, workers by backend, Encore/Redis health, last TTP, process stats.
- Prometheus (scrape config in `observability/prometheus.yml`) + Grafana with a provisioned dashboard. `/metrics` requires `VMP_SUPERVISOR_DASHBOARD_SECRET` when set — create the token file first, then start detached:
  ```bash
  # Resolve through Compose so quoting/escaping matches what the supervisor
  # actually receives — a raw .env grep would write literal quotes into the
  # token file when the value is dotenv-quoted.
  secret=$(docker compose -f docker-compose.coordinator.yml --env-file .env config \
    | sed -n 's/^ *VMP_SUPERVISOR_DASHBOARD_SECRET: *//p' | head -1)
  secret=${secret%\"}; secret=${secret#\"}; secret=${secret%\'}; secret=${secret#\'}
  printf '%s' "${secret:?set VMP_SUPERVISOR_DASHBOARD_SECRET in .env first}" > observability/dashboard-token.txt
  docker compose -f docker-compose.coordinator.yml --env-file .env --profile observability up -d
  ```
- TTP events still land in the TTP JSONL log and DogStatsD (`DD_*`).

## Environment

See `.env.example` — every required var fails fast at `docker compose up`. Notables:

| Var                            | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `VMP_WORKER_TOKEN`             | Shared worker↔coordinator heartbeat auth                       |
| `VMP_COORDINATOR`              | Worker-side: coordinator host/IP (unset = same docker network) |
| `VMP_LADDER_SPLIT`             | `job` or `renditions`                                          |
| `VMP_FORCE_BACKEND`            | Worker entrypoint: skip probing, force `nvenc`/`vaapi`/`cpu`   |
| `PACKAGER_SUPERVISOR_BASE_URL` | Base URL packagers use for aggregate job docs                  |

## Image notes

- `vmp-supervisor` — built by `.github/workflows/media-pipeline-docker.yml` from `Dockerfile`.
- `vmp-encore-worker` — built by the same workflow from `worker/Dockerfile` (stock `encore-worker` binary + Ubuntu ffmpeg with NVENC/VAAPI/QSV + VA drivers). The stock SVT image has **no GPU-capable ffmpeg** — GPU profiles require this image.

## Related docs

- `ROADMAP.md` / `docs/plans/` — implementation checklist
- Encore docs: <https://svt.github.io/encore/>
- encore-packager: <https://github.com/Eyevinn/encore-packager>
