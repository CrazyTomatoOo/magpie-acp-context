#!/usr/bin/env bash
# Runs INSIDE the container (--network none): proves the hook rewrote a real request on its
# way through the gateway, by asserting on what the (fake) upstream actually received.
# The image has no curl, so every HTTP call goes through the mounted Bun binary.
set -euo pipefail

CFG="$XDG_CONFIG_HOME/magpie"
OUT="${OUT:-/out}"
export CAPTURE_DIR="$OUT/capture"
export UPSTREAM_PORT=8099
GW_PORT="${GW_PORT:-3425}"
BUN="${MAGPIE_BUN:-bun}"
mkdir -p "$CFG" "$OUT"

say() { echo "[e2e] $*"; }

# probe <url>: 0 when something answers at all (any status), 1 when the connection fails
probe() {
  "$BUN" -e "fetch(process.argv[1]).then(()=>process.exit(0),()=>process.exit(1))" "$1" 2>/dev/null
}

"$BUN" /host/upstream.mjs >"$OUT/upstream.log" 2>&1 &
i=0
until probe "http://127.0.0.1:$UPSTREAM_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { say "FAIL upstream never listened"; sed 's/^/    /' "$OUT/upstream.log"; exit 1; }
  sleep 0.25
done
say "upstream up"

cat >"$CFG/providers.json" <<JSON
{"providers":[{"id":"fake","name":"Fake Local","chat":"http://127.0.0.1:$UPSTREAM_PORT/v1","key":"sk-fake","models":["fake-1"]}]}
JSON

magpie plugin add /opt/magpie-acp-context >"$OUT/plugin-add.txt" 2>&1 || true
magpie plugin --json >"$OUT/plugin.json" 2>&1 || true
grep -q '/opt/magpie-acp-context' "$OUT/plugin.json" || { say "FAIL plugin not registered"; sed 's/^/    /' "$OUT/plugin.json"; exit 1; }
grep -q '"loaded": *null' "$OUT/plugin.json" && { say "FAIL hooks did not load"; sed 's/^/    /' "$OUT/plugin.json"; exit 1; }
say "plugin registered"

# A floor low enough that the nudge fires on the very first request, so the test does not
# have to grow the history first. Read by the hook's loadConfig.
export MAGPIE_ACP_GROWTH_FLOOR=1

magpie web --gateway --no-open >"$OUT/gateway.log" 2>&1 &
i=0
until probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 240 ] && { say "FAIL gateway never listened"; sed 's/^/    /' "$OUT/gateway.log"; exit 1; }
  sleep 0.25
done
say "gateway listening"

"$BUN" /work/request.mjs > /tmp/req.json
set +e
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT"
sent=$?
set -e
say "request sent (exit $sent, status $(cat "$OUT/response.status" 2>/dev/null))"

if ! ls "$OUT"/capture/*.body >/dev/null 2>&1; then
  say "FAIL upstream received nothing"
  sed 's/^/    /' "$OUT/gateway.log" 2>/dev/null || true
  exit 1
fi

BODY=$(ls "$OUT"/capture/*.body | sed -n 1p)
cp "$BODY" "$OUT/upstream-body.json"
say "upstream received $(ls "$OUT"/capture/*.body | wc -l) body/bodies"

fail=0
check() {
  if grep -qF -- "$2" "$OUT/upstream-body.json"; then
    say "  ok   $1"
  else
    say "  FAIL $1 (missing: $2)"
    fail=1
  fi
}
check "fold marker reached the provider" '[acp] m00002–m00005'
check "summary text reached the provider" '用户要求读文件并总结'
check "first turn was stamped" '[m00001]'
check "system prompt kept its bytes" 'You are a careful agent.'
if grep -q '\[m00001\] You are' "$OUT/upstream-body.json"; then
  fail "system prompt was stamped with a ref"
fi
check "the note was appended to the pending turn" '[acp] 每条历史消息前'

# The tool gate, both directions. The switch is on by default and this run sets no
# MAGPIE_ACP_ENABLED at all, so what keeps a client without our tools untouched is the gate.
latest_body() { ls -t "$OUT"/capture/*.body 2>/dev/null | sed -n 1p; }

"$BUN" /work/request.mjs --foreign-tools >/tmp/req.json
mkdir -p "$OUT/gated"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/gated" >/dev/null 2>&1 || true
GATED=$(latest_body)
[ -n "$GATED" ] || { say "FAIL the gated request never reached the provider"; exit 1; }
cp "$GATED" "$OUT/gated-body.json"
if grep -q '\[m00001\]' "$OUT/gated-body.json"; then fail "a client that declares no tool of ours was stamped"; fi
if grep -q '\[acp\]' "$OUT/gated-body.json"; then fail "a client that declares no tool of ours got the note"; fi
[ "$fail" -eq 0 ] && say "  ok   tool gate: a client that declares no tool of ours is untouched"

"$BUN" /work/request.mjs --own-tools >/tmp/req.json
mkdir -p "$OUT/own"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/own" >/dev/null 2>&1 || true
OWN=$(latest_body)
[ -n "$OWN" ] || { say "FAIL the own-tools request never reached the provider"; exit 1; }
cp "$OWN" "$OUT/own-body.json"
grep -q '\[m00001\]' "$OUT/own-body.json" || fail "a client that declares our tool was not served"

"$BUN" /work/request.mjs --omp-tools >/tmp/req.json
mkdir -p "$OUT/omp"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/omp" >/dev/null 2>&1 || true
OMP=$(latest_body)
[ -n "$OMP" ] || { say "FAIL the omp-shaped request never reached the provider"; exit 1; }
grep -q '\[m00001\]' "$OMP" || fail "omp reaches our tools through eval, so it must be served"
[ "$fail" -eq 0 ] && say "  ok   tool gate: our tool, or a code surface, is served"

if grep -qF "$(printf 'x%.0s' $(seq 1 200))" "$OUT/upstream-body.json"; then
  say "  FAIL the folded tool result was still sent"
  fail=1
else
  say "  ok   folded range removed from the wire"
fi

# Session identity: magpie hands the plugin the client's own id as ctx.session, and the
# ledger file is named after it. This is the path every client with a session header takes;
# the rest fall back to agent|cwd, so both branches matter for migration.
"$BUN" /work/request.mjs >/tmp/req.json
mkdir -p "$OUT/session-post"
if ACS_SESSION=e2e-session-1 "$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/session-post" >/dev/null 2>&1; then
  if [ -f "${MAGPIE_ACP_STORE:-/tmp/acp-store}/sessions/e2e-session-1.json" ]; then
    say "  ok   the session header named the ledger"
  else
    say "  FAIL the session header did not name the ledger"
    fail=1
  fi
else
  say "  FAIL the session-identity request failed"
  fail=1
fi

[ "$fail" -eq 0 ] || { say "FAIL assertions above"; exit 1; }

# The tools half: magpie serves them as its own MCP server, and the plugin host runs them.
"$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" \
  magpie-acp-context_compress '{"content":"m00002–m00005 早期需求\n用户要求读文件并总结。"}' \
  magpie-acp-context_decompress '{"id":"m00004"}' \
  magpie-acp-context_search_context '{"query":"填充文本"}' >"$OUT/mcp.log" 2>&1 || true
sed 's/^/[e2e] /' "$OUT/mcp.log"

grep -q '"magpie-acp-context_decompress"' "$OUT/mcp.json" || { say "FAIL decompress not listed"; exit 1; }
grep -q '解析到 1 段' "$OUT/mcp.json" || { say "FAIL compress did not parse the payload"; exit 1; }
grep -q '总结:内容是一段填充文本' "$OUT/mcp.json" || { say "FAIL decompress returned no original"; exit 1; }
grep -q '填充文本' "$OUT/mcp.json" || { say "FAIL search_context found nothing"; exit 1; }
cp "$CFG/plugin-tools.json" "$OUT/plugin-tools.json" 2>/dev/null || true

# M1 acceptance: kill magpie, start it again, and the folded original is still there.
say "restarting the gateway"
pkill -f 'magpie web --gateway' || true
i=0
while probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 80 ] && { say "FAIL gateway did not stop"; exit 1; }
  sleep 0.25
done
magpie web --gateway --no-open >>"$OUT/gateway.log" 2>&1 &
i=0
until probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 240 ] && { say "FAIL gateway did not come back"; exit 1; }
  sleep 0.25
done
mkdir -p "$OUT/restart"
OUT="$OUT/restart" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" \
  magpie-acp-context_decompress '{"id":"m00004"}' >"$OUT/mcp-after-restart.log" 2>&1 || true
sed 's/^/[e2e] /' "$OUT/mcp-after-restart.log"
grep -q '填充文本' "$OUT/restart/mcp.json" || { say "FAIL restart lost the original"; exit 1; }
say "survived a restart"
# M2: the reply's own usage reaches the ledger, and acp_status reports it.
grep -q '上下文自上次折叠后增长了' "$OUT/capture/"*.body || { say "FAIL no nudge reached the provider"; exit 1; }
say "nudge reached the provider"

"$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" magpie-acp-context_acp_status '{}' >"$OUT/status.log" 2>&1 || true
sed 's/^/[e2e] /' "$OUT/status.log"
mkdir -p "$OUT/status"
OUT="$OUT/status" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" magpie-acp-context_acp_status '{}' >>"$OUT/status.log" 2>&1 || true
grep -q '计费 prompt=1,234 tok' "$OUT/status/mcp.json" || { say "FAIL onResponse usage never reached the ledger"; exit 1; }
say "usage recorded from the reply"

# M3: a *streamed* reply's usage must reach the ledger too, not just a whole-body reply.
"$BUN" /work/request.mjs --stream >/tmp/req.json
cp /tmp/req.json "$OUT/stream.json"
mkdir -p "$OUT/stream-post"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/stream-post" >"$OUT/stream.resp" 2>&1 || true
grep -qF '"stream":true' "$(latest_body)" || say "note: upstream did not see a stream request"

rm -rf "$OUT/stream"
OUT="$OUT/stream" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" magpie-acp-context_acp_status '{}' >>"$OUT/stream.log" 2>&1 || true
grep -q '计费 prompt=2,222 tok' "$OUT/stream/mcp.json" || { say "FAIL streamed usage never reached the ledger"; sed 's/^/    /' "$OUT/stream.log"; exit 1; }
say "streamed usage recorded"

say "OK"
