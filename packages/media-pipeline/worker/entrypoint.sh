#!/bin/sh
# VMP Encore worker: detect hardware encode backend, heartbeat capabilities to
# the supervisor, then keep encore-worker alive (stock worker exits when the
# queue drains — see https://svt.github.io/encore/deployment/).
set -eu

ENCORE_BIN="${ENCORE_WORKER_BIN:-/usr/local/bin/encore-worker}"
IDLE_SLEEP="${ENCORE_WORKER_IDLE_SLEEP_S:-5}"
HEARTBEAT_S="${VMP_WORKER_HEARTBEAT_S:-30}"
SUPERVISOR_URL="${VMP_SUPERVISOR_URL:-http://vmp-supervisor:8788}"
WORKER_ID="${VMP_WORKER_ID:-$(hostname)}"
FFMPEG="${FFMPEG_BIN:-ffmpeg}"
VAAPI_DEVICE="${VAAPI_DEVICE:-/dev/dri/renderD128}"

# Cleartext warnings — tokens/passwords over plain http/redis:// are only sane
# inside the compose network or a trusted LAN/VPN.
case "$SUPERVISOR_URL" in
  http://vmp-supervisor*|http://localhost*|http://127.*|https://*) ;;
  http://*) echo "heartbeat: WARNING — worker token over cleartext http to $SUPERVISOR_URL; use https:// or a VPN for remote links" >&2 ;;
esac
case "${WORKER_REDIS_URI:-redis://redis:6379}" in
  redis://redis:*|redis://127.*|redis://localhost*|rediss://*|redis://*:6379) ;;
  redis://*) echo "heartbeat: WARNING — redis password over cleartext redis://; use a tunnel/terminator for remote links" >&2 ;;
esac

probe() { # probe <label> <ffmpeg args...>
  label="$1"; shift
  if "$FFMPEG" -hide_banner -loglevel error "$@" -f null - 2>/dev/null; then
    echo "probe ok: $label" >&2; return 0
  fi
  return 1
}

detect_backend() {
  # 1-frame real encodes — presence of an encoder in `ffmpeg -encoders` does not
  # prove driver support, so probe actual device init.
  if [ "${VMP_FORCE_BACKEND:-}" = "nvenc" ] || \
     probe nvenc -init_hw_device cuda=0 -f lavfi -i testsrc2=size=128x128:rate=30 \
       -frames:v 1 -filter_hw_device cuda -vf 'format=nv12,hwupload' -c:v h264_nvenc; then
    echo nvenc; return
  fi
  if [ -e "$VAAPI_DEVICE" ]; then
    # Covers AMD/Intel iGPU (i965/mesa) and Arc (iHD); QSV rides the VAAPI path.
    if [ "${VMP_FORCE_BACKEND:-}" = "vaapi" ] || \
       probe vaapi -init_hw_device "vaapi=va:$VAAPI_DEVICE" -filter_hw_device va \
         -f lavfi -i testsrc2=size=128x128:rate=30 -frames:v 1 \
         -vf 'format=nv12,hwupload' -c:v h264_vaapi; then
      echo vaapi; return
    fi
  fi
  if [ "${VMP_FORCE_BACKEND:-}" = "cpu" ]; then echo cpu; return; fi
  echo cpu
}

GPU_BACKEND="$(detect_backend)"

# Capability class routing (see encorePriorities.ts): prio>=50 jobs sit in queue
# 0. A worker polling queue 1 with higher-prio drains 0→1. CPU workers pin to
# queue 1 only, so GPU-profile jobs can never land on a CPU-only box.
if [ "$GPU_BACKEND" = "cpu" ]; then
  export ENCORE_SETTINGS_POLL_QUEUE="${ENCORE_SETTINGS_POLL_QUEUE:-1}"
  export ENCORE_SETTINGS_POLL_HIGHER_PRIO="${ENCORE_SETTINGS_POLL_HIGHER_PRIO:-false}"
else
  export ENCORE_SETTINGS_POLL_QUEUE="${ENCORE_SETTINGS_POLL_QUEUE:-1}"
  export ENCORE_SETTINGS_POLL_HIGHER_PRIO="${ENCORE_SETTINGS_POLL_HIGHER_PRIO:-true}"
fi
export ENCORE_SETTINGS_WORKER_DRAIN_QUEUE="${ENCORE_SETTINGS_WORKER_DRAIN_QUEUE:-true}"

echo "worker=$WORKER_ID backend=$GPU_BACKEND pollQueue=$ENCORE_SETTINGS_POLL_QUEUE higherPrio=$ENCORE_SETTINGS_POLL_HIGHER_PRIO" >&2

heartbeat_loop() {
  [ -n "${VMP_WORKER_TOKEN:-}" ] || { echo "heartbeat: VMP_WORKER_TOKEN unset — not registering" >&2; return; }
  while true; do
    # Register while an encore-worker process is alive OR right after a clean
    # exit — the stock worker is one-shot (exits when the queue drains), so
    # alive-only gating skips nearly every heartbeat while idle. A worker that
    # fails at startup exits non-zero and never writes WORKER_OK_FILE.
    if { [ -f "$WORKER_PID_FILE" ] && kill -0 "$(cat "$WORKER_PID_FILE")" 2>/dev/null; } \
      || [ -f "$WORKER_OK_FILE" ]; then
      # jq-encoded — a quote/backslash in WORKER_ID or VMP_WORKER_VERSION must
      # not break the JSON body (or inject fields).
      payload=$(jq -cn \
        --arg workerId "$WORKER_ID" \
        --arg hostname "$(hostname)" \
        --arg gpuBackend "$GPU_BACKEND" \
        --arg version "${VMP_WORKER_VERSION:-docker}" \
        --argjson pollQueue "$ENCORE_SETTINGS_POLL_QUEUE" \
        --argjson pollHigherPrio "$ENCORE_SETTINGS_POLL_HIGHER_PRIO" \
        '{workerId:$workerId,hostname:$hostname,gpuBackend:$gpuBackend,pollQueue:$pollQueue,pollHigherPrio:$pollHigherPrio,version:$version}') \
        || { echo "heartbeat: payload encode failed" >&2; sleep "$HEARTBEAT_S"; continue; }
      curl -sf -m 5 -X POST "$SUPERVISOR_URL/api/workers/heartbeat" \
        -H "x-vmp-worker-token: $VMP_WORKER_TOKEN" -H 'content-type: application/json' \
        -d "$payload" \
        >/dev/null 2>&1 || echo "heartbeat: supervisor unreachable" >&2
    fi
    sleep "$HEARTBEAT_S"
  done
}

WORKER_PID_FILE="${WORKER_PID_FILE:-/tmp/encore-worker.pid}"
WORKER_OK_FILE="${WORKER_OK_FILE:-/tmp/encore-worker.ok}"
# Drop a marker left by an earlier run before the first heartbeat.
rm -f "$WORKER_OK_FILE"
heartbeat_loop &

worker_pid=""
forward_signal() {
  [ -n "$worker_pid" ] && kill -TERM "$worker_pid" 2>/dev/null && wait "$worker_pid" 2>/dev/null
  exit 143
}
trap 'forward_signal' TERM INT

while true; do
  set +e
  "$ENCORE_BIN" &
  worker_pid=$!
  echo "$worker_pid" > "$WORKER_PID_FILE"
  wait "$worker_pid"
  code=$?
  worker_pid=""
  rm -f "$WORKER_PID_FILE"
  # Clean drain-exit → stay registered; crash loop → drop out of the registry.
  if [ "$code" -eq 0 ]; then touch "$WORKER_OK_FILE"; else rm -f "$WORKER_OK_FILE"; fi
  set -e
  echo "worker exited $code; restart in ${IDLE_SLEEP}s" >&2
  sleep "$IDLE_SLEEP"
done
