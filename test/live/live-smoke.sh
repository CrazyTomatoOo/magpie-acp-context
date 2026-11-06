#!/usr/bin/env bash
# Live smoke test: a REAL model through a REAL gateway, still fully isolated.
# Runs inside the container (it needs to reach the provider, so NOT --network none).
# MUST run under bash: the port poll uses /dev/tcp, which dash does not have.
#
#   PROVIDER=deepseek PROVIDER_KEY=... docker run --rm -e PROVIDER -e PROVIDER_KEY \
#     -e MODEL=deepseek/deepseek-chat \
#     -v $CLI:/b/magpie-cli:ro -v $BUN:/z:ro -v ./probe:/work/plugin:ro \
#     ubuntu:22.04 bash -c 'cp /b/magpie-cli /tmp/m; chmod 755 /tmp/m; bash /work/live-smoke.sh'
#
# Two things must both hold for a pass (see docs/magpie-acp-plugin-design.md §14.4):
#   1. the model answered, and
#   2. the gateway log carries a [probe] line for that same turn.
set -euo pipefail

PROVIDER="${PROVIDER:-deepseek}"
MODEL="${MODEL:-$PROVIDER/deepseek-chat}"
MODELS="${MODELS:-}"          # optional: force model ids when the vendor's list endpoint is flaky
GW="${GW:-http://127.0.0.1:3425}"

command -v curl >/dev/null 2>&1 || { echo "[live] FAIL this image has no curl (install it; the Dockerfile does)"; exit 1; }
[ -n "${PROVIDER_KEY:-}" ] || { echo "[live] FAIL PROVIDER_KEY is not set in the container"; exit 1; }

export HOME=/tmp/h XDG_CONFIG_HOME=/tmp/c XDG_CACHE_HOME=/tmp/cache MAGPIE_NO_INSTALL=1
export MAGPIE_BUN="${MAGPIE_BUN:-/z/bun}"
mkdir -p "$HOME"

say() { echo "[live] $*"; }

say "provider add $PROVIDER"
magpie provider add "$PROVIDER" "$PROVIDER_KEY" 2>&1 | sed 's/^/    /'
[ -n "$MODELS" ] && { magpie provider models "$PROVIDER" $MODELS >/dev/null 2>&1 || true; }
magpie providers 2>&1 | sed 's/^/    /'

say "plugin add probe"
magpie plugin add /work/plugin 2>&1 | sed 's/^/    /'
magpie plugin --json 2>&1 | sed 's/^/    /'

say "start gateway"
magpie web --gateway --no-open >/tmp/gw.log 2>&1 &
poll=0
until (exec 3<>/dev/tcp/127.0.0.1/3425) 2>/dev/null; do
  poll=$((poll + 1))
  if [ "$poll" -gt 480 ]; then
    say "FAIL gateway never listened after 120s"
    say "listening sockets (hex ports):"
    awk 'NR>1 && $4=="0A" {print "    "$2}' /proc/net/tcp 2>/dev/null || true
    sed 's/^/    /' /tmp/gw.log
    exit 1
  fi
  sleep 0.25
done
say "gateway listening"

say "one real turn: model=$MODEL (retries=${RETRIES:-1})"
attempt=0; http=000
while : ; do
  attempt=$((attempt + 1))
  http=$(curl -sS --max-time 120 -o /out/answer.json -w '%{http_code}' \
    -X POST "$GW/v1/chat/completions" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer sk-anything' \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}" || echo 000)
  say "attempt $attempt → http=$http"
  case "$http" in 2*) break ;; esac
  [ "$attempt" -ge "${RETRIES:-1}" ] && break
  sleep 5
done
say "answer (raw, first 400 chars)"
cut -c1-400 /out/answer.json 2>/dev/null | sed 's/^/    /' || say "    no answer file"

say "gateway log (middleware lines only)"
if grep -F '[probe]' /tmp/gw.log >/tmp/probe.txt; then sed 's/^/    /' /tmp/probe.txt; hooked=yes; else say "    no [probe] line — hook did not fire"; hooked=no; fi

# A vendor busy/timeout is not our failure: judge the hook, report the model separately.
if [ "$hooked" = yes ]; then
  say "PASS hook fired (the seam works; upstream status was $http)"
  exit 0
fi
say "FAIL hook never ran"
exit 1
