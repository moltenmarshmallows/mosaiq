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
docker compose -f docker-compose.coordinator.yml --env-file .env up -d
docker compose -f docker-compose.worker.yml      --env-file .env up -d
```

Dashboard: `http://127.0.0.1:8788` (secret = `VMP_SUPERVISOR_DASHBOARD_SECRET`). Drop a `.mp4` into `$ENCORE_MEDIA_MOUNT/videos/inbox-fast-lane/` and watch it flow.

### Scale out (LAN/cloud)

1. On the worker host, mount the **same media tree** at `/media` (NFS export of the coordinator's media dir — same paths everywhere is the contract).
2. Copy `docker-compose.worker.yml` + `.env` over, set `VMP_COORDINATOR=<coordinator host/IP>` and `VMP_REDIS_BIND`/`VMP_UI_BIND` on the coordinator so Redis + supervisor are LAN-reachable.
3. `docker network create vmp-media` once, then `docker compose -f docker-compose.worker.yml --env-file .env --profile nvidia up -d` (or `vaapi`, or plain CPU `worker`).

Every worker registers in the dashboard's **Encode workers** table and immediately adds concurrency. GPU workers drain GPU-class jobs first, then CPU work; CPU workers can never take a GPU-profile job.

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
  --lifecycleRules '[{"fileNamePrefix":"","daysFromStartingToCancelingUnfinishedLargeFiles":7}]' \
  --corsRules '[{"allowedOrigins":["https://staging.app.mosaiq.video","https://app.mosaiq.video"],"allowedOperations":["s3_put","s3_head","s3_get","s3_delete"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]'
```

- Lifecycle: `bucket update --lifecycleRules` **replaces** the whole rule list — merge new rules with existing ones (`b2 bucket get`) instead of clobbering them. `daysFromStartingToCancelingUnfinishedLargeFiles` abandons multipart uploads after 7 days (the only leak presigning can leave). Reclaiming completed uploads: add `{"fileNamePrefix":"videos/","daysFromHidingToDeleting":N}` when your retention policy allows it — the `fully_processed` callback deletes current `source.*` objects, but **sweeping current object keys does not remove hidden versions**; only a hide→delete rule or deleting by version ID reclaims that storage.
- CORS: **required** for the browser PUTs to B2's S3 endpoint and for reading the `ETag` back. If you name the rule (`corsRuleName`) via `b2 update bucket …`, keep the same name on updates or B2 appends a duplicate rule.

### Observability

- `GET /metrics` on the supervisor — Prometheus exposition: queue depth, active jobs by stage, workers by backend, Encore/Redis health, last TTP, process stats.
- Prometheus (scrape config in `observability/prometheus.yml`) + Grafana with a provisioned dashboard. `/metrics` requires `VMP_SUPERVISOR_DASHBOARD_SECRET` when set — create the token file first, then start detached:
  ```bash
  printf '%s' "$VMP_SUPERVISOR_DASHBOARD_SECRET" > observability/dashboard-token.txt
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
