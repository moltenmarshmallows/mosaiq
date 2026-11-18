# VMP Encore worker — stock encore-worker binary on a hardware-encode ffmpeg.
#
# The published ghcr.io/svt/encore-worker image ships a native binary on a base
# without an NVENC/VAAPI/QSV-capable ffmpeg. This image carries the same binary
# onto Ubuntu ffmpeg (compiled with nvenc/vaapi/qsv/v4l2) plus VA/QSV drivers, so
# the -gpu-* profiles in /profiles actually run. The entrypoint probe-encodes a
# test clip per backend and registers the result with the supervisor — the host
# only needs the GPU device passed through (nvidia runtime or /dev/dri).

FROM ghcr.io/svt/encore-worker:latest AS encore-worker

FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    jq \
    vainfo \
    mesa-va-drivers \
    intel-media-va-driver-non-free \
    libmfx1 \
    libmfx-gen1.2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=encore-worker /app/encore-worker /usr/local/bin/encore-worker
COPY encore/profiles /profiles
COPY worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
