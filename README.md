# magpie-acp-context

ACP-style context compression for [magpie](https://usemagpie.ai), built as **async gateway
hooks** — the only magpie surface with a filesystem, a network and a clock.

Status: **M3** — deterministic refs, fold replay, prompt injection, real-usage nudging, four
tools over magpie's own MCP server, and an operator CLI (`status`, `block`, `forget`, `unlock`,
`reconcile`) that repairs the store without touching the request path. On by default: installing
and restarting is enough, and a client that cannot call the tools is left untouched.

## Why hooks and not middleware

| | gateway middleware (moejs) | async hooks (Bun) | this plugin |
|---|---|---|---|
| rewrite the request | yes | yes | hooks |
| see the raw event stream | yes | no | — |
| read/write files | no | yes | hooks |
| keep state across requests | no | yes | hooks |
| network | no | yes | hooks |
| time budget | 250 ms / 50 ms per event | 1 s default, `gatewayTimeoutMs` | `min(2000, gatewayTimeoutMs-200)` |

Mid-stream injection is impossible on either surface: the client executes tools, and the
proxy rewrites bodies. That is the same split the community plugins
([powercontext](https://github.com/magpie-community/plugins/tree/main/packages/powercontext),
[magpie-openviking](https://github.com/MengXiangxi/magpie-openviking)) arrived at.

## What it does, per request

1. Skip the request when it declares tools, none of them is ours, and none of them is a code or
   shell surface that could call MCP anyway (`tools` absent = no way to tell, so the request is
   served). A client that cannot call `compress` would only get a note asking for something it
   cannot do, and a ledger row nobody can fold.
2. Hash every message into a **blockId** (`sha256(role + "\0" + text)[0:16]`) and hand out a
   monotonic **ref** (`m00001`) per blockId — refs never renumber when history shifts.
3. Find `compress` calls already present in the transcript, parse every legacy payload shape,
   and record them as **folds** (`refs` + summary + topic). The call is recognised under the
   name the client replays — `compress`, the served `magpie-acp-context_compress`, or the MCP
   wrapper a client adds around it (`mcp__magpie__magpie-acp-context_compress`).
4. Replay live folds: the folded range is replaced by one marker message
   `[acp] m00002–m00005 <topic>\n<summary>`; a fold dies as soon as an anchor leaves the
   history (the client compacted) or the range re-enters the recent window.
5. Stamp `[m00001] ` in front of prose turns, and append the compression note to the turn
   being sent.
6. Decide whether to nudge, using the **billed prompt tokens** the previous reply reported
   (`onResponse`), never our own estimate alone; nudge text goes into the same note.
7. Return `undefined` when nothing changed — a promise-resolved `undefined` sends the original
   bytes, so prompt caches survive untouched turns.

Safety rules: never touch the pending turn, never split a tool call from its result, never
fold without a real compress call, refuse ranges under `minRangeBytes`, neutralize ref-lookalike
text in summaries (`m00007` → `m#00007`, `[acp]` → `[acp ]`) so the model cannot forge a fold
boundary, and fail open on any error.

## Tools

`tools.mjs` is the package `main`, so magpie loads it as an OpenCode plugin and serves its tools
to every agent at `/mcp/magpie/tools`:

| MCP name | what it does |
|---|---|
| `<short>_compress` | parses the payload into ranges and tells the model what it wrote; the fold itself is settled by the hook on the next request |
| `<short>_decompress` | returns the original text of a folded block, by block id or by the ref it was shown under |
| `<short>_search_context` | substring + term-frequency search over folded originals |
| `<short>_acp_status` | store size, one line per session (refs, folds, growth since the last fold against the nudge line, billed prompt tokens, last nudge); `{evict:true}` runs eviction |

`<short>` is the plugin's short name — the folder name it was added from, capped at 24
characters. Install it as `magpie-acp-context` to get `magpie-acp-context_decompress`.

**What a client reads back is not that name.** Every hop renames the tool on its own terms — an
MCP client shows `mcp__magpie__magpie-acp-context_compress`, and magpie's own forwarding to omp
returns `_mcp__magpie_acp_context_compress` (leading underscore, dots and dashes folded to
underscores). A settle rule that matched the literal name therefore never fired on those clients:
the agent kept being told to compress while nothing was ever folded, with no error anywhere.
The rule now compares on a canonical form and only requires that the plugin's own prefix appears
somewhere in the name, so any rewrite that keeps the prefix still settles, while a foreign
`foo_compress` is still refused. `test/compress-names.test.mjs` pins both directions.

What each client actually writes, measured on a real gateway (the declaration it sends, and the
name it will accept back):

| Client | Declares our tool as | Accepts the call as |
|---|---|---|
| claude 2.1.318 | not at all (built-ins only, `Bash` among them) | `mcp__magpie__magpie-acp-context_compress` |
| codex 0.166 (Responses) | a `namespace` entry `mcp__magpie` with `magpie_acp_context_compress` nested | `magpie_acp_context_compress`; the hyphenated form is rejected as an unsupported call |
| pi 1.5 (`exposure: direct`) | `mcp__magpie__magpie_acp_context_compress` | the same underscored name; the hyphenated form is "not found" |
| pi 1.5 (default `codemode`) | nothing — callable only from `codemode` scripts | reached through `codemode`, not by name |
| omp | `_mcp__magpie_acp_context_compress` | the same flattened name |

Two shapes are declarations, not names: codex nests an MCP server's tools under a namespace entry,
and pi hides them behind `codemode` until a server opts into `exposure: direct`. Both made the
"can this client call ours at all?" question answer no for a client that could — which is why the
gate now reads nested names and counts a code surface (`eval`, `bash`, `exec_command`, `codemode`)
as a way in.

Tools run in the plugin host with Bun's full runtime (55 s cap), which is the half of ACP the
hook cannot do: the hook sees one request and one reply under a 1 s default budget, and nothing
it returns can inject a tool result into the stream. The client executes the tool; the result becomes an ordinary tool
message; the hook reads that message on the next turn and settles the fold.

## Operator CLI

`node cli.mjs <command>` (or `./cli.mjs`, Node >= 22, no dependencies). It reads the store
directly, so it works when magpie is not running:

| command | what it does |
|---|---|
| `status [--limit N] [--growth-floor N] [--json]` | the same lines `acp_status` prints for the agent |
| `block <id\|ref>` | the original text of one folded block |
| `forget <id\|ref>... [--yes]` | delete originals on purpose; dependent folds become holes, not lies |
| `unlock [session]` | remove a `*.lock` a killed hook left behind (hooks only wait 120 ms) |
| `reconcile [--apply] [--ttl-days N]` | report — and with `--apply` repair — folds whose original vanished, orphan blocks, and refs of dead sessions |
| `evict [--max-bytes N] [--ttl-days N]` | run eviction once |

`--store DIR` (or `MAGPIE_ACP_STORE`) picks the store; the default is the plugin's.

## Install

```sh
magpie plugin add github:crazytomatooo/magpie-acp-context    # the published path
magpie plugin add ./                                        # or a checkout, for development
```

Nothing to configure: the switch ships on, so a restart of the gateway is the whole install.
`magpie plugin off magpie-acp-context` turns it back off; per-session options
(`magpie plugin options magpie-acp-context '{"keepRecentTurns":3}'`) stay optional.

A client that cannot call the plugin's tools is left alone even with the switch on: when a
request declares tools, none of them reduces to this plugin's prefix, and none is a code/shell
surface, the request passes through untouched — no refs, no note, no ledger row. omp is the case
that shapes this rule: it declares `read`/`bash`/`eval` and reaches every MCP tool through
`eval`, so naming our tool is not the only way to be able to call it. A request that declares
no tools at all cannot be judged that way and is served as before.

The repository carries two kinds of tags and they mean different things: `magpie-plugin` is the
**install pointer** and always names the current build (it moves forward, so `magpie plugin
update` is enough to pick up fixes), while `vX.Y.Z` tags are immutable releases — pin one with
`github:crazytomatooo/magpie-acp-context#v0.1.1` if you want a frozen build.

The plugin's short name is its folder name capped at 24 characters, so install it as
`magpie-acp-context`: any shorter name renames the tools (`<short>_compress`, …).

Hooks are loaded at gateway start: after `plugin add`, `plugin update` or an option change the
plugin code itself only takes effect once magpie restarts. Options read from the environment or
from `magpie plugin options` do not need a restart.

### Is it working?

`enabled` ships `true`; restart the gateway after installing and the next session is served.
Nothing must be pinned per client — a client that declares none of the plugin's tools is skipped
by the tool gate, so an unrelated agent can share the same gateway untouched.

```sh
magpie plugin --json | grep loaded        # "loaded": null means the hooks loaded
```

In a session, ask the agent for `<short>_acp_status`: its first line names the switch, which
declared tools count as ours, and whether this caller passed the gate; the second line is a
staleness hint — `version 0.2.2 · latest 0.2.3` when the installed copy is behind the
`magpie-plugin` moving pointer, `version 0.2.2 · local build` when it is ahead of anything
published, `version 0.2.2` when it is current or a version on either side cannot be compared,
and nothing at all when the one unauthenticated check (3 s abort) could not answer.
`updateCheck: false` removes the line, the request, and the read of the cached answer — nothing
leaves the machine. Then one line per session
with refs, folds, the growth since the last fold against the 50,000-token nudge line, and the
billed prompt tokens the last reply reported. On disk, `<store.dir>/sessions/` gains one file per
session and `<store.dir>/blocks/` one file per folded message.

The nudge is the visible half: once a session has grown 50,000 tokens since its last fold, the
next request carries a note asking the model to fold — the same cadence billion-context uses, so
a mixed setup does not fold at two rhythms.

Options can also come from the environment, which is handy for tests:
`MAGPIE_ACP_ENABLED=1`, `MAGPIE_ACP_MODE`, `MAGPIE_ACP_STORE`, `MAGPIE_ACP_INJECT_STYLE`,
`MAGPIE_ACP_KEEP_TURNS`, `MAGPIE_ACP_MIN_BYTES`, `MAGPIE_ACP_GROWTH_FLOOR`, `MAGPIE_ACP_AGENTS`,
`MAGPIE_ACP_UPDATE_CHECK` (`1`/`true` on, `0`/`false` off — wins over the option both ways).

`MAGPIE_ACP_DEBUG=1` (or `debug: true`) prints, to the host's stderr, the fold decision of every
request — the foldable window, folds created, skipped ranges, ranges dropped as foreign — and the
stack of anything the hook swallowed. Use it when a compression the agent reported never showed up
on the wire.

| option | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch; `magpie plugin off` also works. Even when on, a client that declares no tool of ours is skipped |
| `agents` | `[]` | canary list: empty = every agent, otherwise only the named ones start the hook |
| `origins` | `["local","magpie-key"]` | callers served at all: magpie's own `local`/`magpie-key`; `gateway-key`, `remote` and an unknown origin are skipped |
| `mode` | `assist` | `assist` folds and nudges; `render` only renders existing folds |
| `injectStyle` | `append-user` | `append-user` or `system-suffix` |
| `refFormat` | `m%05d` | printf format for refs |
| `minRangeBytes` | `5000` | smallest range worth folding |
| `maxSummaryChars` | `20000` | summaries are truncated, never rejected |
| `keepRecentTurns` | `3` | trailing user turns kept verbatim |
| `nudge.growthFloor` | `50000` | growth (unfolded tail) since the last fold that triggers a nudge — the flat 50K billion-context uses for every window |
| `store.dir` | `~/.local/share/magpie-acp` | state + folded originals |
| `store.maxBytes` / `store.ttlDays` | `536870912` / `30` | eviction budget, applied on `acp_status {evict:true}` |
| `debug` | `false` | print each request's fold decision, and anything the hook swallowed, to the host's stderr (`MAGPIE_ACP_DEBUG=1`) |
| `updateCheck` | `true` | the staleness hint in `acp_status`: one unauthenticated GET a day. `false` removes the line, the request, and the cache read (`MAGPIE_ACP_UPDATE_CHECK=0`) |

## What lives on disk

`<store.dir>/sessions/<sessionKey>.json` — `{v, next, seq, refs: {blockId: ref}, folds: [...],
usage: [...], nudge, request}`, written under a `*.lock` file with tmp+rename. Losing it
degrades to "no compression", never to a wrong request. Folded originals live in one
content-addressed directory, `<store.dir>/blocks/<blockId>.json`, because a tool call has no
session of its own.

The staleness hint's answer is cached too: `<store.dir>/version-check.json` holds
`{latest, at}` for 24 h, so `acp_status` costs at most one request a day. A file that cannot be
read, parsed, or trusted is treated as no cache — the check runs afresh and rewrites it — and
eviction never touches it.

Eviction (`acp_status {"evict":true}`) deletes TTL-expired blocks first, then the oldest
referenced ones until the store fits `maxBytes`, and marks every fold that lost its original
with `evictedAt` so `decompress` reports a hole instead of inventing text.

## Keeping up with billion-context

This plugin never imports billion-context, so an upstream release cannot break it — it can only
make it stale. `parity/bili-<version>.json` pins the part we copied (default values, ref format,
tool schema, pipeline order, prompt hashes), read out of source text rather than line numbers:

```sh
git clone --depth 1 https://github.com/ranxianglei/billion-context ~/bc
node scripts/parity-check.mjs --repo ~/bc      # 0 = no drift, 1 = drift
```

Each difference is annotated with the option it affects (`parity/mapping.json`) or with the
reason we cannot follow it. Policy, the deliberate-divergence table and the per-release ritual:
[`docs/bili-parity.md`](docs/bili-parity.md).

## Switching from a billion-context session

Change where the client points; the history it already has goes out unchanged. Old `📦 [ACP]`
summaries and `<acp>` blocks are treated as plain text; bili's `m00182`-style refs are not
recognised, so a `compress` call citing them is skipped and the note on the wire says so —
nothing is ever folded at a shifted offset. System prompts take no ref, so they cannot be folded
at all.

The whole picture — bili's native mode per host, this plugin's mode, and the staged migration
with rollback and acceptance signals — is [`docs/plan-bili-to-magpie.md`](docs/plan-bili-to-magpie.md).

No client plugin is needed for any of this: magpie already carries every host's wiring
(`internal/agent/<host>.go`). What does need one step per agent is the tool surface — magpie
registers this plugin's MCP server in its Library but switches it on per agent, so
`compress`/`decompress`/`search_context` only reach a client once you authorise it there. The
per-host table, the session-identity mapping and what each host still loses (its own
compaction) are in [`docs/agent-migration-matrix.md`](docs/agent-migration-matrix.md).

To reclaim the space an old summary still occupies, fold it as part of a new range. To inherit
what bili folded away, import its store — the originals are still there, as plaintext JSON
keyed by content hash, including the 1,166 messages it marked retired:

```sh
node scripts/import-bili.mjs --db ~/.local/share/billion-context/sessions/index.db \
     --store ~/.local/share/magpie-acp --session <bili-session-id>   # or --all, --dry-run
```

Refs keep their numbers (`decompress m00021` still names the same message) and the folds come
back from bili's `blocks` table. Read-only on bili's side. See
[`docs/magpie-acp-plugin-design.md`](docs/magpie-acp-plugin-design.md) §19.4 for the schema
facts and the measured run.

## Tests

```sh
bun test test/                       # 85 unit tests: refs, folds, protocols, safety rules,
                                     # tools, usage shapes, nudge rules, eviction,
                                     # compaction, reconcile, CLI, inherited sessions,
                                     # and the tool-name shapes real wires send back
./test/e2e/run.sh                    # container end-to-end: 6,933 B request → 1,269 B on the wire,
                                     # a nudge on the wire, all four tools over MCP,
                                     # the billed prompt tokens landing in acp_status,
                                     # streamed usage reaching the ledger too,
                                     # the client's session header naming the ledger,
                                     # and the store surviving a restart
```

A real client has also been driven through a containerised magpie (omp v18.16.0, two turns over
one conversation, the fake upstream recording what magpie actually sent): the provider body fell
from 42,061 to 34,088 bytes once the fold settled (−19.0%, reproduced at −7,973 bytes on a second
run), the `[acp] m00001–m00001` marker replaced the original on the wire, `decompress` returned
the 8,629-byte original by ref, and the ref was unchanged on the next turn. That run is what
turned up the tool-name, block-array and single-message-range defects — none of them reachable
from the container e2e, which speaks the shapes this package itself emits.

`test/e2e` runs magpie and a fake provider inside `ubuntu:22.04` with `--network none`,
`--read-only`, `:ro` mounts and one output directory — nothing on the host is written. It
asserts on the body the fake upstream actually received, not on a CLI success message.

## Known limits

- Only prose can carry a ref; tool results and JSON arguments cannot, so `m00003` may be
  skipped. Refs are display handles, never addresses — folds are keyed by blockId.
- The nudge has one trigger: growth since the last fold, at the same flat 50K billion-context
  uses. Percentage-of-window gates were dropped rather than shipped guessed: a hook is never
  told the model's real window, so a percentage would be a number nobody measured.
- Usage is read from `onResponse`, which the gateway assembles from a bounded copy of the reply;
  verified for both whole-body and streamed replies in the container.
- Eviction and reconciliation are manual (`acp_status {evict:true}` or the CLI): nothing runs on
  a timer.
- `search_context` is substring + term frequency, not BM25.
- Eviction is whole-block, not per session.
- Refs survive a client compaction (blockId-keyed), but a fold whose anchors left the history is
  dropped silently — `acp_status` counts it as neither live nor evicted.
- A tool call has no session of its own, so tools resolve blocks by content-addressed id; refs
  are accepted only as a convenience lookup.
