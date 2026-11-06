#!/bin/sh
# Host-side driver for the containerised host-integration layer.
# Nothing here writes to the real magpie config, store or ports.
#
#   ./run.sh            # build + run, artifacts land in $OUT (temp dir)
#   PLUGIN_DIR=./plugin ./run.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR=${PLUGIN_DIR:-$HERE/plugin}
MAGPIE_VERSION=${MAGPIE_VERSION:-v0.1.2827}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/magpie-acp-test.XXXXXX")
OUT="$TMP/out"
mkdir -p "$OUT"

cleanup() {
  # The test owns $TMP; removing it is part of the contract. Nothing else is touched.
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

echo "== build image (magpie $MAGPIE_VERSION) =="
docker build -q -t magpie-acp-test \
  --build-arg "MAGPIE_VERSION=$MAGPIE_VERSION" \
  --build-arg "TARGETARCH=$(docker version --format '{{.Server.Arch}}' | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
  "$HERE"

echo "== run scenario (no network, read-only root, temp HOME) =="
set +e
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,size=128m \
  --tmpfs /home/runner:rw,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -e OUT=/out \
  -v "$PLUGIN_DIR:/work/plugin:ro" \
  -v "$HERE/upstream.mjs:/work/upstream.mjs:ro" \
  -v "$HERE/scenario.sh:/work/scenario.sh:ro" \
  -v "$OUT:/out:rw" \
  magpie-acp-test /bin/sh /work/scenario.sh
STATUS=$?
set -e

echo "== artifacts =="
ls -R "$OUT" | sed 's/^/  /'
if [ "$STATUS" -ne 0 ]; then
  echo "FAILED (exit $STATUS)"
  cp -r "$OUT" "${TMPDIR:-/tmp}/magpie-acp-test-failed-$$" || true
  echo "artifacts preserved at ${TMPDIR:-/tmp}/magpie-acp-test-failed-$$"
fi
exit "$STATUS"
