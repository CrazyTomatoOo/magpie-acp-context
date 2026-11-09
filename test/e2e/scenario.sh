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
bad() { say "  FAIL $*"; fail=1; }
check() {
  if grep -qF -- "$2" "$OUT/upstream-body.json"; then
    say "  ok   $1"
  else
    say "  FAIL $1 (missing: $2)"
    fail=1
  fi
}
check "fold marker reached the provider" '[acp] m00001–m00004'
check "summary text reached the provider" '用户要求读文件并总结'
check "the turn after the fold was stamped" '[m00005]'
check "system prompt kept its bytes" 'You are a careful agent.'
if grep -q '\[m00001\] You are' "$OUT/upstream-body.json"; then
  bad "system prompt was stamped with a ref"
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
if grep -q '\[m00001\]' "$OUT/gated-body.json"; then bad "a client that declares no tool of ours was stamped"; fi
if grep -q '\[acp\]' "$OUT/gated-body.json"; then bad "a client that declares no tool of ours got the note"; fi
[ "$fail" -eq 0 ] && say "  ok   tool gate: a client that declares no tool of ours is untouched"

"$BUN" /work/request.mjs --own-tools >/tmp/req.json
mkdir -p "$OUT/own"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/own" >/dev/null 2>&1 || true
OWN=$(latest_body)
[ -n "$OWN" ] || { say "FAIL the own-tools request never reached the provider"; exit 1; }
cp "$OWN" "$OUT/own-body.json"
grep -q '\[acp\] m00001–m00004' "$OUT/own-body.json" || bad "a client that declares our tool was not served"

"$BUN" /work/request.mjs --omp-tools >/tmp/req.json
mkdir -p "$OUT/omp"
"$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/omp" >/dev/null 2>&1 || true
OMP=$(latest_body)
[ -n "$OMP" ] || { say "FAIL the omp-shaped request never reached the provider"; exit 1; }
grep -q '\[acp\] m00001–m00004' "$OMP" || bad "omp reaches our tools through eval, so it must be served"
[ "$fail" -eq 0 ] && say "  ok   tool gate: our tool, or a code surface, is served"

if grep -qF "$(printf 'x%.0s' $(seq 1 200))" "$OUT/upstream-body.json"; then
  say "  FAIL the folded tool result was still sent"
  fail=1
else
  say "  ok   folded range removed from the wire"
fi

# The cap: nobody folds, and one unit is big enough to blow the request on its own. It sits in
# the turn being sent, so no amount of dropping history could have saved it; only cutting the
# unit can, and the cut must name an id `decompress` can still resolve.
"$BUN" /work/request.mjs --big >/tmp/req.json
mkdir -p "$OUT/cap"
ACS_SESSION=cap-check "$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/cap" >/dev/null 2>&1 || true
CAPBODY=$(latest_body)
cp "$CAPBODY" "$OUT/cap-body.json"
if grep -q '\[acp\] 已省略' "$OUT/cap-body.json"; then
  say "  ok   an oversized unit was clipped"
else
  say "  FAIL an oversized unit went out whole"
  fail=1
fi
if grep -q 'MIDDLE-SENTINEL' "$OUT/cap-body.json"; then
  say "  FAIL the clip kept the middle of the unit"
  fail=1
fi
CAPID=$(sed -n 's/.*原文 id \([0-9a-f][0-9a-f]*\).*/\1/p' "$OUT/cap-body.json" | sed -n 1p)
if [ -n "$CAPID" ]; then
  mkdir -p "$OUT/cap-back"
  OUT="$OUT/cap-back" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" \
    magpie-acp-context_decompress "{\"id\":\"$CAPID\"}" >/dev/null 2>&1 || true
  if grep -q 'MIDDLE-SENTINEL' "$OUT/cap-back/mcp.json"; then
    say "  ok   the clipped original came back through decompress ($CAPID)"
  else
    say "  FAIL decompress could not restore the clipped original ($CAPID)"
    fail=1
  fi
else
  say "  FAIL the clip marker named no block id"
  fail=1
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
# The version line must come from the store's cache, never the network: the container has no
# route out at all, so a line that appears at all proves it rendered from <store>/version-check.json
# — the product's own cache path, seeded the way a recent successful check would have left it.
# 99.0.0 is far ahead of any release, so the line must carry "latest 99.0.0" rather than "local build".
VER=$("$BUN" -e 'console.log(JSON.parse(require("node:fs").readFileSync("/opt/magpie-acp-context/package.json","utf8")).version)')
STORE="${MAGPIE_ACP_STORE:-/tmp/acp-store}"
mkdir -p "$STORE"
printf '{"latest":"99.0.0","at":%s}\n' "$("$BUN" -e 'console.log(Date.now())')" >"$STORE/version-check.json"

"$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" magpie-acp-context_acp_status '{}' >"$OUT/status.log" 2>&1 || true
sed 's/^/[e2e] /' "$OUT/status.log"
mkdir -p "$OUT/status"
OUT="$OUT/status" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" magpie-acp-context_acp_status '{}' >>"$OUT/status.log" 2>&1 || true
grep -q '计费 prompt=1,234 tok' "$OUT/status/mcp.json" || { say "FAIL onResponse usage never reached the ledger"; exit 1; }
say "usage recorded from the reply"
# The line can only have come from the seeded cache — with the network sealed, a fetch would
# have failed and left no line at all.
grep -qF "version $VER · latest 99.0.0" "$OUT/status/mcp.json" || { say "FAIL the version line did not render from the seeded cache"; exit 1; }
say "version line served from the cache with the network sealed"

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

# The four-gate live proof (#15): one good range folds, three bad ranges are refused with
# their reasons, and acp_status shows all four. Every range is derived from the window the
# hook advertises, so this holds under this lane's KEEP_TURNS=1 as well as the shipped 3 -
# a hard-coded range would only be true for one of them.
GW="http://127.0.0.1:$GW_PORT" MODEL=fake/fake-1 SESSION=live-gates OUT="$OUT" \
  "$BUN" /live/gates.mjs >"$OUT/gates.log" 2>&1 || true
sed 's/^/[e2e] /' "$OUT/gates.log"
grep -q 'OK - one fold, three refusals, all four in acp_status' "$OUT/gates.log" || { say "FAIL the four-gate live proof"; exit 1; }
say "four gates fired live"

# The elision leg (#19): a request over a KNOWN limit that nobody folded has its earliest whole
# turns swapped for a mechanical statement — and every ref the statement names comes back through
# `decompress`. The limit is an env value, so the gateway is restarted to pick it up.
say "restarting with a known window"
pkill -f 'magpie web --gateway' || true
i=0
while probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 80 ] && { say "FAIL gateway did not stop"; exit 1; }
  sleep 0.25
done
MAGPIE_ACP_FALLBACK=full MAGPIE_ACP_CONTEXT_LIMIT=4000 magpie web --gateway --no-open >>"$OUT/gateway.log" 2>&1 &
i=0
until probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 240 ] && { say "FAIL gateway did not come back with the window"; exit 1; }
  sleep 0.25
done
"$BUN" /work/request.mjs --over >/tmp/req.json
mkdir -p "$OUT/elide"
ACS_SESSION=elide-check "$BUN" /work/post.mjs "http://127.0.0.1:$GW_PORT/v1/chat/completions" "$OUT/elide" >/dev/null 2>&1 || true
cp "$(latest_body)" "$OUT/elide-body.json"
if grep -qE '\[acp\] 已省略 m[0-9]+–m[0-9]+ 共 [0-9]+ 条\(机械省略,没有摘要' "$OUT/elide-body.json"; then
  say "  ok   the earliest turns were replaced by a mechanical statement"
else
  say "  FAIL the earliest turns went out whole"
  fail=1
fi
if grep -q '早期需求-1:uuuu' "$OUT/elide-body.json"; then
  say "  FAIL the earliest turn was still on the wire"
  fail=1
else
  say "  ok   the earliest turn left the wire"
fi
ELIDEFROM=$(sed -n 's/.*已省略 \(m[0-9]*\)–m[0-9]* 共 .*/\1/p' "$OUT/elide-body.json" | sed -n 1p)
ELIDETO=$(sed -n 's/.*已省略 m[0-9]*–\(m[0-9]*\) 共 .*/\1/p' "$OUT/elide-body.json" | sed -n 1p)
if [ -n "$ELIDEFROM" ] && [ "$ELIDEFROM" != "$ELIDETO" ]; then
  say "  ok   the statement names a range in history order ($ELIDEFROM–$ELIDETO)"
else
  say "  FAIL the statement named no range in history order ($ELIDEFROM–$ELIDETO)"
  fail=1
fi
mkdir -p "$OUT/elide-back"
OUT="$OUT/elide-back" "$BUN" /work/mcp.mjs "http://127.0.0.1:$GW_PORT" \
  magpie-acp-context_decompress "{\"id\":\"$ELIDEFROM\"}" >/dev/null 2>&1 || true
if grep -q '早期需求-1:uuuu' "$OUT/elide-back/mcp.json"; then
  say "  ok   the elided original came back through decompress ($ELIDEFROM)"
else
  say "  FAIL decompress could not restore the elided original ($ELIDEFROM)"
  fail=1
fi
[ "$fail" -eq 0 ] || { say "FAIL elision assertions"; exit 1; }
say "elision fired on a known window"

say "OK"
