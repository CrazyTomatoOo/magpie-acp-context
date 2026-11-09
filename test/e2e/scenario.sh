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

# gates <phases>: the live proof for one group of phases, against the gateway as it is running
# now. The log IS the failure message: a phase that did not fire prints its own FAIL line, and
# the lane must not carry on past it.
gates() {
  local phases="$1" name="${2:-live-gates}" log
  log="$OUT/gates-${name//\//-}-${1//,/-}.log"
  if GW="http://127.0.0.1:$GW_PORT" MODEL=fake/fake-1 SESSION="$name" OUT="$OUT" \
    CAPTURE="$OUT/capture" PHASES="$phases" "$BUN" /live/gates.mjs >"$log" 2>&1; then
    sed 's/^/[e2e] /' "$log"
    say "  ok   live gates fired: $phases"
  else
    sed 's/^/[e2e] /' "$log"
    say "FAIL a live gate phase did not fire: $phases (log: $log)"
    exit 1
  fi
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

# The live proof (#15, #22, #24): the three refused ranges and the one good fold, the cap cutting
# one oversized unit, and the doubled floor where the model meets it. Every range is derived from
# the window the hook advertises, so this holds under this lane's KEEP_TURNS=1 as well as the
# shipped 3 - a hard-coded range would only be true for one of them.
gates default,cap,condensed

# The elision leg (#19, #23): a request over a KNOWN limit that nobody folded has its earliest
# whole turns swapped for a mechanical statement, a real fold clears the latch, and the count
# starts over. The limit is an env value, so the gateway is restarted to pick it up - the phase
# is meaningless without `fallback: full` and a declared ceiling.
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

# The same legs through the gate script (#22, #23): their own histories, their own sessions, the
# statement asserted on the bytes the provider received, the latch holding across an identical
# request, a real fold clearing it, and the count starting over.
gates elide,latch-cleared

# The nudge is a reminder, not a gate (#25): it stays here, and it is grepped across every body
# the provider received because the request that shows it depends on the history shape. It needs
# a foldable window big enough to clear the percentage of the context, which the elision phases
# have and a short conversation does not.
grep -q '上下文自上次折叠后增长了' "$OUT/capture/"*.body || { say "FAIL no nudge reached the provider"; exit 1; }
say "nudge reached the provider"

# The installed copy: every section above ran the mounted checkout, but a consumer gets a tarball.
# Pack it, install it into a clean project, hand the installed path to magpie instead, and fire the
# first gate phase again. Importing the installed hook resolves its whole module graph, so this is
# the one check that sees a tarball missing a file `hooks.mjs` imports -- the failure the mounted
# lane cannot see, and the one the install handoff would hit.
say "installing from a tarball"
PKG_SRC=/tmp/pack-src
PKG_OUT=/tmp/pack
CONSUMER=/tmp/consumer
VERSION="$("$BUN" -e 'console.log((await Bun.file("/opt/magpie-acp-context/package.json").json()).version)')"
mkdir -p "$PKG_SRC" "$PKG_OUT" "$CONSUMER"
# bun pm pack writes into the package directory, so the read-only mount cannot be packed in place;
# node_modules stays behind, it is not part of the tarball anyway.
tar -C /opt/magpie-acp-context --exclude=./node_modules -cf - . | tar -C "$PKG_SRC" -xf -
(cd "$PKG_SRC" && "$BUN" pm pack --destination "$PKG_OUT" >"$OUT/pack.log" 2>&1) \
  || { say "FAIL the tarball did not build"; sed 's/^/    /' "$OUT/pack.log"; exit 1; }
printf '{"name":"consumer","dependencies":{}}\n' >"$CONSUMER/package.json"
(cd "$CONSUMER" && "$BUN" add "file:$PKG_OUT/magpie-acp-context-$VERSION.tgz" >"$OUT/consumer-add.log" 2>&1) \
  || { say "FAIL the tarball did not install"; sed 's/^/    /' "$OUT/consumer-add.log"; exit 1; }
INSTALLED="$CONSUMER/node_modules/magpie-acp-context"
"$BUN" -e 'const m = await import(process.argv[1]); if (typeof m.onRequest !== "function") process.exit(1);' \
  "$INSTALLED/hooks.mjs" \
  || { say "FAIL the installed hook does not import (the tarball is missing a file it needs)"; exit 1; }
say "  ok   the tarball carries the hook and everything it imports ($(du -sh "$INSTALLED" | cut -f1))"

magpie plugin rm magpie-acp-context >"$OUT/plugin-rm.txt" 2>&1 || true
magpie plugin add "$INSTALLED" >"$OUT/plugin-installed.txt" 2>&1 || true
magpie plugin --json >"$OUT/plugin-installed.json" 2>&1 || true
grep -q 'consumer/node_modules/magpie-acp-context' "$OUT/plugin-installed.json" \
  || { say "FAIL the installed copy is not the registered plugin"; sed 's/^/    /' "$OUT/plugin-installed.json"; exit 1; }
grep -q '"loaded": *null' "$OUT/plugin-installed.json" \
  && { say "FAIL the installed hook did not load"; sed 's/^/    /' "$OUT/plugin-installed.json"; exit 1; }

# Back to the default fallback: the phase below sends a short history, and an elision at 4,000
# tokens would cut it where the phase expects a fold.
pkill -f 'magpie web --gateway' || true
i=0
while probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 80 ] && { say "FAIL gateway did not stop for the installed copy"; exit 1; }
  sleep 0.25
done
magpie web --gateway --no-open >>"$OUT/gateway.log" 2>&1 &
i=0
until probe "http://127.0.0.1:$GW_PORT/"; do
  i=$((i + 1)); [ "$i" -gt 240 ] && { say "FAIL gateway did not come back on the installed copy"; exit 1; }
  sleep 0.25
done
say "gateway running the installed copy"

# A fresh session name: the store keeps what the first `default` run folded, and the same session
# would see that range as already folded instead of advertising it.
gates default live-installed

say "OK"
