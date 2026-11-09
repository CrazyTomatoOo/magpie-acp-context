#!/usr/bin/env bash
# Host side of the end-to-end test. Everything the plugin can write lives in the container;
# the only host paths are read-only mounts plus one output directory.
#
#   MAGPIE_CLI=/path/to/linux/magpie-cli MAGPIE_BUN_HOST=/path/to/bun-linux-arm64 ./test/e2e/run.sh
#
# Isolation, in order of importance:
#   1. --network none        nothing can reach the network; the fake provider is loopback
#   2. --read-only           the container rootfs cannot be written at all
#   3. :ro mounts            the repo, the binaries and the scripts are read-only
#   4. one output dir        the only host path that receives bytes
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="${MAGPIE_CLI:-/tmp/mwdocker2/magpie-cli}"
BUN_DIR="${MAGPIE_BUN_HOST:-/tmp/mwbun/x/bun-linux-aarch64}"
OUT_DIR="${OUT_DIR:-$(mktemp -d)/out}"
IMAGE="${IMAGE:-magpie-e2e:22.04}"
mkdir -p "$OUT_DIR"

[ -x "$CLI" ] || { echo "[e2e] FAIL no linux magpie-cli at $CLI (set MAGPIE_CLI)"; exit 1; }
[ -x "$BUN_DIR/bun" ] || { echo "[e2e] FAIL no linux bun at $BUN_DIR (set MAGPIE_BUN_HOST)"; exit 1; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" "$HERE" >/dev/null

docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,size=128m \
  --tmpfs /home/runner:rw,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e HOME=/home/runner \
  -e XDG_CONFIG_HOME=/home/runner/.config \
  -e MAGPIE_ACP_KEEP_TURNS=1 \
  -e MAGPIE_ACP_MIN_BYTES=1000 \
  -e MAGPIE_ACP_STORE=/tmp/acp-store \
  -e MAGPIE_BUN=/tmp/bin/bun \
  -e OUT=/out \
  -v "$CLI":/b/magpie-cli:ro \
  -v "$BUN_DIR":/z:ro \
  -v "$ROOT":/opt/magpie-acp-context:ro \
  -v "$HERE":/work:ro \
  -v "$ROOT/test/host":/host:ro \
  -v "$ROOT/test/live":/live:ro \
  -v "$OUT_DIR":/out \
  -e PATH=/tmp/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$IMAGE" bash -c '
    set -e
    mkdir -p /tmp/bin                       # the rootfs is read-only; links live in /tmp
    ln -sf /b/magpie-cli /tmp/bin/magpie
    ln -sf /z/bun /tmp/bin/bun
    cp /work/scenario.sh /tmp/scenario.sh
    bash /tmp/scenario.sh
  ' 2>&1 | cat

echo "[e2e] artifacts: $OUT_DIR"
