#!/bin/sh
# Runs INSIDE the container. Every assertion is backed by a file we can read from
# the mounted /out afterwards; no CLI success message is trusted.
set -eu

CFG="$XDG_CONFIG_HOME/magpie"
OUT="${OUT:-/out}"
export CAPTURE_DIR="$OUT/capture"
export UPSTREAM_PORT=8099
GW_PORT="${GW_PORT:-3425}"
mkdir -p "$CFG" "$OUT"

say() { echo "[scenario] $*"; }

# 1. fake upstream: the only network a --network none container has is loopback
bun /work/upstream.mjs >"$OUT/upstream.log" 2>&1 &
i=0
until curl -fsS --noproxy '*' -o /dev/null "http://127.0.0.1:$UPSTREAM_PORT/" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 40 ] && { say "FAIL upstream never listened"; exit 1; }
  sleep 0.25
done
say "upstream up"

# 2. provider pointing at it
cat >"$CFG/providers.json" <<JSON
{"providers":[{"id":"fake","name":"Fake Local","chat":"http://127.0.0.1:$UPSTREAM_PORT/v1","key":"sk-fake","models":["fake-1"]}]}
JSON
magpie providers >"$OUT/providers.txt" 2>&1 || true

# 3. install the plugin from the read-only mount, then read the registry JSON —
#    plugins.yml only lists built-in plugins, user specs live here.
magpie plugin add /work/plugin >"$OUT/plugin-add.txt" 2>&1 || true
magpie plugin --json >"$OUT/plugin.json" 2>&1 || true
grep -q '/work/plugin' "$OUT/plugin.json" || { say "FAIL plugin not registered"; exit 1; }
if grep -q '"loaded": *null' "$OUT/plugin.json"; then
  say "FAIL hooks did not load (Bun missing? see upstream of MAGPIE_BUN)"; exit 1
fi
say "plugin registered and loaded"

# 4. gateway: poll the port, never a log line
magpie web --gateway --no-open >"$OUT/gateway.log" 2>&1 &
i=0
until (exec 3<>"/dev/tcp/127.0.0.1/$GW_PORT") 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { say "FAIL gateway never listened on $GW_PORT"; cat "$OUT/gateway.log"; exit 1; }
  sleep 0.25
done
say "gateway listening on $GW_PORT"
cp "$CFG/settings.json" "$OUT/settings.json" 2>/dev/null || true

# 5. one Anthropic-format turn through the gateway
curl -sS --noproxy '*' -o "$OUT/response.json" -w '%{http_code}' \
  -X POST "http://127.0.0.1:$GW_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'x-api-key: sk-test' \
  -d '{"model":"fake-1","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}' \
  >"$OUT/response.status" 2>&1 || true
say "request sent, status $(cat "$OUT/response.status" 2>/dev/null)"

# 6. assertion on captured upstream traffic
ls "$OUT"/capture/*.body >"$OUT/capture-files.txt" 2>/dev/null || true
if ! ls "$OUT"/capture/*.body >/dev/null 2>&1; then
  say "FAIL upstream received nothing"
  cat "$OUT/response.status" "$OUT/response.json" 2>/dev/null || true
  exit 1
fi
say "upstream received $(ls "$OUT"/capture/*.body | wc -l) body/bodies"
say "OK"
