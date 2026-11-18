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
    # Register only while an encore-worker process is alive — a worker that
    # fails at startup must not advertise GPU capacity it cannot use. The
    # registry TTL drops us once heartbeats stop.
    if [ -f "$WORKER_PID_FILE" ] && kill -0 "$(cat "$WORKER_PID_FILE")" 2>/dev/null; then
      curl -sf -m 5 -X POST "$SUPERVISOR_URL/api/workers/heartbeat" \
        -H "x-vmp-worker-token: $VMP_WORKER_TOKEN" -H 'content-type: application/json' \
        -d "{\"workerId\":\"$WORKER_ID\",\"hostname\":\"$(hostname)\",\"gpuBackend\":\"$GPU_BACKEND\",\"pollQueue\":$ENCORE_SETTINGS_POLL_QUEUE,\"pollHigherPrio\":$ENCORE_SETTINGS_POLL_HIGHER_PRIO,\"version\":\"${VMP_WORKER_VERSION:-docker}\"}" \
        >/dev/null 2>&1 || echo "heartbeat: supervisor unreachable" >&2
    fi
    sleep "$HEARTBEAT_S"
  done
}

WORKER_PID_FILE="${WORKER_PID_FILE:-/tmp/encore-worker.pid}"
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
  set -e
  echo "worker exited $code; restart in ${IDLE_SLEEP}s" >&2
  sleep "$IDLE_SLEEP"
done
