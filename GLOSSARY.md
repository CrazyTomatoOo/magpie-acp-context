# magpie-acp-context

A gateway hook that gives magpie's agents ACP-style context compression: the agent folds old
messages into summaries it can decompress later, and the hook settles those folds on the wire.

## Language

**Fold**:
Replacing a range of messages with one summary block that keeps the originals addressable by ref,
so the context shrinks without the conversation losing what it said.
_Avoid_: compress, compaction, truncation

**Ref**:
The short id (`m00001`) the model cites to read a folded range back. Assigned once, never reused.
_Avoid_: tag, id, marker

**Settle**:
Recording a fold the agent asked for, on the next request, once the tool result carrying the
summary is visible in the history.
_Avoid_: commit, apply, finalize

**Tool gate**:
The hook's check for whether a client can call this plugin's tools at all. No tool of ours and no
code surface that could reach MCP means the request is passed through untouched.
_Avoid_: capability check, permission

**发布指针 / moving pointer**:
The `magpie-plugin` git tag. It always points at the newest release commit, so installing it gets
whatever is current that day — and an install made last month keeps pointing where it was made.
_Avoid_: latest version, release tag (that is `vX.Y.Z`, which never moves)

**安装副本 / installed copy**:
What actually runs: the copy magpie places under `~/.config/magpie/plugins/node_modules/<pkg>/`.
It is not the developer's checkout, and `magpie plugin update` is the only thing that moves it.
_Avoid_: the plugin (ambiguous between the copy, the checkout, and the source)

**旧 / stale**:
An installed copy whose version is behind the version at the moving pointer. A checkout made from
the same commit is not stale even though nothing installed it.
_Avoid_: outdated, old (they name the feeling; this names the comparison)
