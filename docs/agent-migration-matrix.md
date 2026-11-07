# 从 bili 客户端插件迁到 magpie 插件:六个宿主逐个对照

对象:`pi`、`omp`、`dsh`、`opencode`、`claude-code`、`codex`。
左栏是 billion-context(v0.1.211,`ranxianglei/billion-context`)为每个宿主装的插件,右栏是本仓库(`magpie-acp-context`)在 magpie(`yetone/magpie`)里的对应物。行号对各自仓库当前 HEAD 逐行核对过;标〔未验证〕的是没有抓到真实流量、只凭源码推断的结论。

## 0. 结论:三档

| 档 | 内容 | 迁移时的动作 |
|---|---|---|
| **A 直接可用** | 请求路由:magpie 自己就是代理,`internal/agent/<host>.go` 已经把每个宿主指向网关;不需要任何客户端插件 | 只做一次 `magpie` 的首启接线 |
| **B 一步配置** | 工具面:插件的 `compress/decompress/search_context/acp_status` 由 magpie 自动登记进 Library,但**默认不给任何 agent**,要逐个授权 | 每个 agent 在 Library 里打开 `magpie-acp-context` 这个服务器 |
| **C 必然降级** | ① 客户端自己的压缩(我们不禁用)② 没有会话头的宿主的账本会按 `agent\|cwd` 合并 ③ bili 专有的 msgIds / 分叉血缘(我们按内容哈希,不需要也不可能有) | 接受,或按 §5 调参缓解 |

一句话:bili 的客户端插件做的四件事里,**路由和工具是 magpie 的原生职责**,身份与压缩控制是 bili 的私有缝,迁过来之后由「magpie 的会话头 + 我们的内容哈希」替代,退化是安全的,不是丢数据。

## 1. bili 客户端插件到底做了什么

四个宿主的插件形态不同,但都做同样四件事(源码统一称 "内外呼应"):

| # | 职责 | pi / omp | opencode | dsh | claude-code | codex |
|---|---|---|---|---|---|---|
| 1 | **路由**:把模型 API 请求改道到自己的代理 | 补 `globalThis.fetch`(`src/agent/native-intercept.ts:1056`),扩展自己被 `pi` 的 `packages[]`(`src/plugin-install.ts:6`)或 omp 的 `config.yml extensions:`(`:7`)载入 | 注册 `http.request` 钩子(`src/agent/opencode-native.ts:1-19`) | 补 `globalThis.fetch`(cordis 插件,`src/agent/dsh-native.ts:1-13`) | `SessionStart` hook 把 `ANTHROPIC_BASE_URL` 钉到稳定端口 48787(`src/claude-native-bootstrap.ts:8`)+ `claude mcp add` | `~/.codex/config.toml` 的 `[mcp_servers.bili]` |
| 2 | **身份**:在请求上盖章 | `x-bili-plugin-conversation/agent/model/context-window/turn`;body 里 `biliMsgIds`(`src/msgid-pin.ts:13`)、`biliLedgerSeqs`(`:21`) | 同左,msgId 取自 `experimental.chat.messages.transform` | 同左 + `x-deepseek-harness-compact` 语义 | 同左 | 同左 |
| 3 | **压制客户端自己的压缩** | — | 安装时写 `compaction.auto=false`(`src/plugin-install.ts:11`) | vendored 覆盖层把基础压缩标成 disabled(`src/agent/dsh-compaction-disable.ts:52`) | — | 自己的 compaction item 打哨兵并剥除(`src/codex-compact.ts:21`、`:164`) |
| 4 | **工具**:注册并回连代理执行 | 宿主内注册工具,执行时 `POST /__bili/plugin/tool` | 同左 | 同左 | MCP 服务器(代理地址) | MCP 服务器(代理地址) |

外加一个增量车道:宿主进程里维护 per-conversation ack(`src/agent/incremental-client.ts:5`、`:25` 的 `x-bili-plugin-turn`),探测 `GET /__bili/plugin/turn`,404 就退回全量重发。

## 2. magpie 的四个对应面

| 面 | magpie 的实现 | 我们用它做什么 |
|---|---|---|
| 路由 | 每个宿主一个接线模块:`internal/agent/claude.go`(3,063 行)、`codex.go`(2,664)、`dsh.go`(2,775)、`omp.go`(862)、`pi.go`(174);写宿主自己的配置(如 claude 的 managed settings `env.ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`),并用 `wiringOff`/`whatsOff` 自检"有没有接上 magpie"(`internal/agent/claude.go:2390`) | 我们一行都不用写:网关就是入口 |
| 身份 | `internal/gateway/gateway.go`:优先 `X-Magpie-Session`(`:8618`),其次 `sessionHeaders`(`:8595`)里的 `x-opencode-session`、`x-claude-code-session-id`、`x-deepseek-harness-session-id`、`session_id`…;`sessionOf`(`:8628`)、`agentOf`(`:63`) | 拼账本键(`hooks.mjs:63-69`) |
| 工具 | `internal/library/plugin_tools.go:1-24`:提供 `tool` 钩子的插件自动成为 Library 里一个独立 MCP 服务器(`ToolsMCPOne<name>`),"switched on per agent",可单工具关、可走 hub(`<name>__<tool>`),且 "offered once" | 我们的四个工具靠它到达客户端 |
| 客户端压缩 | **只呈现,不禁用**:`internal/agent/codex_compact_held.go:12` "The value is the user's, so magpie never takes it out on its own" | 见 §5,只能检测不能阻止 |

## 3. 六客户端对照

| 客户端 | bili 装在哪 | magpie 接线 | 迁移后仍缺什么 | 迁移动作 |
|---|---|---|---|---|
| **claude-code** | `claude mcp add` → `~/.claude.json`;`SessionStart` hook 钉 48787 | `internal/agent/claude.go` | 无。会话头齐全(`x-claude-code-session-id`) | 先让 magpie 接管(否则 bili 的 48787 优先),再 `claude mcp remove bili`、撤 hook |
| **codex** | `~/.codex/config.toml` 的 `[mcp_servers.bili]` | `internal/agent/codex.go` | codex 自己的 `model_auto_compact_token_limit` 继续生效 → 它会在窗口 X% 自行压缩 | 删 `[mcp_servers.bili]`;是否设 `auto_compact` 由用户决定(magpie 不代劳) |
| **opencode** | `opencode.json{c}` 的 `mcp.bili` + native plugin 目录 + `compaction.auto=false` | `internal/agent/opencode*.go` | `compaction.auto` 卸载后回 `true`,opencode 会自行压缩 | 删 `mcp.bili`、删插件目录、决定是否保留 `compaction.auto=false` |
| **omp** | `~/.omp/agent/config.yml` 的 `extensions:` | `internal/agent/omp.go` | 会话头〔未验证〕;无头则账本按 `agent\|cwd` | 删 extensions 条目 |
| **pi** | `~/.pi/agent/settings.json` 的 `packages[]` | `internal/agent/pi.go` | 同上 | 删 packages 条目 |
| **dsh** | 无文件:`dsh plugin --profile <name> add` | `internal/agent/dsh.go` | 覆盖层卸掉后 dsh 原生基础压缩回来;`x-deepseek-harness-compact` 我们读不到(hooks 的 `ctx` 不含请求头) | `dsh plugin remove` |

## 4. 会话身份决定账本是否串台

| 客户端 | 自带会话头 | magpie 是否识别 | 我们的会话键 |
|---|---|---|---|
| claude-code | `x-claude-code-session-id` | 是 | 头值 |
| opencode | `x-opencode-session` | 是 | 头值 |
| dsh | `x-deepseek-harness-session-id` | 是 | 头值 |
| codex |〔未验证〕 | 仅当它发 `session_id`/`x-session-id` | 头值或 `agent\|cwd` |
| pi / omp |〔未验证〕 | 同上 | 头值或 `agent\|cwd` |

退化成 `agent|cwd` 的后果与界限:

- 同一目录的多个会话共用一个账本;**块按内容寻址**(`blockId = sha256(role‖text)[:16]`),所以不会互相污染内容;
- 折叠以锚点是否还在当前历史里为准,别的会话的折叠会被 `liveRanges` 丢弃,不会误删;
- 唯一代价是 ref 编号在会话间连续增长(`m00001` 之后跳到 `m00047` 之类),以及 `magpie-acp sessions` 里一个键对应多段历史。

补救:任何客户端都能显式发 `X-Magpie-Session: <稳定 id>`(magpie 原样透传成 `ctx.session`),e2e 已断言这条路径(§7)。

## 5. 客户端自己的压缩:只能检测,不能禁止

bili 用三种手段压住客户端压缩(§1 第 3 行),magpie 一个都不做(§2 第 4 行)。迁移后会看到:

| 客户端 | 迁移后 | 我们的行为 |
|---|---|---|
| opencode | `compaction.auto` 回 `true`,会话长了它自己压缩 | 锚点消失 → 相应折叠被丢弃(`docs/magpie-acp-plugin-design.md` §19);已折叠的原文仍在我们的 store 里,`decompress` 仍可取 |
| codex | `model_auto_compact_token_limit` 照旧,codex 自己压缩 | 同上 |
| dsh | 原生基础压缩回来 | 同上 |
| claude-code / pi / omp | 本来就由 bili 之外的机制管(claude 有 `/compact`) | 同上 |

真要避免打架,只能靠调参,而不是写宿主配置(改写宿主配置是 magpie 的职责,插件不该越权):

- 把 `nudge.growthFloor` 调低(例如 30000),让我们的折叠在客户端压缩之前发生;
- 或按客户端保留它自己的 `compaction.auto=false`(用户手写,我们不写)。

## 6. 迁移清单(顺序不能颠倒)

1. **备份**:`~/.local/share/billion-context`、各宿主配置(`~/.claude.json`、`~/.codex/config.toml`、`opencode.json`、`~/.omp/agent/config.yml`、`~/.pi/agent/settings.json`)。
2. **导入旧账本**:`node scripts/import-bili.mjs --all --store ~/.local/share/magpie-acp`(或按宿主 `--namespace claude|codex|opencode|omp|pi|dsh|proxy`),抽三条 `decompress` 验证。
3. **magpie 首启接线**:确认每个宿主的 `wiringOff`/`whatsOff` 自检为"已接上";claude 特别注意 bili 的 48787 必须让位。
4. **装插件**:`magpie plugin add <本仓库>`,并确认 `enabled: true`(默认 `false`,不打开什么都不做)。
5. **授权工具**:Library 里给每个 agent 打开 `magpie-acp-context` 服务器(B 档)。
6. **逐宿主验收**(§7),通过一个再迁下一个。
7. **卸 bili 插件**(§3 最后一列),再观察一周,最后才删 `~/.local/share/billion-context`。

## 6.1 分阶段切换(不要一次性全换)

一次全换是唯一有破坏性的做法。三个事实让它不必要:

1. **装 magpie 与插件不改任何客户端配置。** 客户端配置只在 `POST /api/agents/{action}/{id}` 里被写(`internal/gui/api.go:1272-1290`,动作 `connect`/`disconnect`/`reapply`/`keep`),也就是面板上按“连接”的那一刻。启动、装插件、重启网关都不会自动接管宿主。
2. **插件对名单外的 agent 是零操作。** `agents` 是灰度白名单,不在名单里的请求在进入 store 之前就 `return undefined`,magpie 按原字节转发(§7 的 `canary rollout` 三例断言,含「未创建的 store 目录」)。
3. **bili 与 magpie 是两个端口,互不影响。** 没有改 base URL、没有卸 bili 插件、没有删 bili 库的窗口,继续按原样工作。

阶段:

| 阶段 | 配置 | 观察什么 | 回滚 |
|---|---|---|---|
| 0 影子 | `enabled:false`(安装即默认) | `magpie plugin --json` 能看到 hooks 被登记;`calls` 计数为 0 | 无 |
| 1 单客户端 | `{"enabled":true,"agents":["omp"]}` | 只有 omp 的请求带 `[mNNNNN]`;其余客户端的请求字节不变 | 删 `agents` 或 `enabled:false`,下个请求即生效 |
| 2 逐个加 | 每加一个客户端观察 2–3 天 | 该客户端的折叠率、`acp_status` 的 `evicted`、客户端自身压缩是否打架 | 同上 |
| 3 卸 bili | 只对该阶段已验收的客户端 | — | 恢复客户端配置(§3 最后一列) |

唯一能打扰“正在进行的其他窗口”的动作是:**对 bili 当前占着的客户端按下 magpie 的“连接”**——那一刻配置从 bili 转到 magpie。所以按下前先确认该窗口空闲,并且它不在灰度之外。

## 7. 验收矩阵

每个宿主四条,任一不过就不要往下迁:

| # | 检查 | 怎么做 |
|---|---|---|
| 1 | 折叠生效 | 上游收到的 body 里有 `[acp] mNNNNN–mNNNNN` 或 `[mNNNNN]` 戳记(本仓库 e2e 的第一组断言) |
| 2 | 会话绑定正确 | 发一次带 `X-Magpie-Session: <id>` 的请求,`$MAGPIE_ACP_STORE/sessions/<id>.json` 出现(e2e 已断言) |
| 3 | 重启可回溯 | 重启网关后 `decompress {"id":"mNNNNN"}` 仍返回原文(e2e 已断言) |
| 4 | 客户端压缩后不炸 | 让客户端自行压缩一次,`acp_status` 仍可读,折叠标记 `evicted` 而不是报错 |

自动化部分:`bun test test/`(69 个用例,含 3 个会话身份用例)与 `./test/e2e/run.sh`(容器内真网关 + 真 MCP + 重启 + 流式 usage + 会话头)。

## 8. 能保证与不能保证

能保证:

- 不需要任何客户端插件:magpie 自己就是代理,接线由 `internal/agent/*.go` 负责;
- 旧窗口的历史照常折叠,不需要迁移"压缩状态"(bili 的折叠从不写回客户端历史,见 `docs/billion-context-how-it-works.md` §19 与实测);
- 旧 bili 的原文可导入后由我们的 `decompress`/`search_context` 读回;
- 四个工具经 magpie 自己的 MCP 服务器提供,不需要我们监听端口。

不能保证:

- 客户端自己的压缩时机与内容(我们不写宿主配置);
- bili 的 msgId 级增量车道与分叉血缘(我们按内容哈希;分叉的旧分支会被当成新块,不会错折叠);
- pi / codex 是否发会话头未逐条验证;omp 已实测发(store 键是宿主 UUID),dsh 实测不发(键退化成 `dsh|`)。

## 9. 实测结果(真机,非源码推断)

判定口径只有两条:**折叠真的结算了**(store 里有 fold 记录、原文可取回),以及**宿主是怎么把调用交上来的**(线上形态决定我们要不要多认一种写法)。全部在 `0.3.2` 上跑。

| 宿主 | 线 | 会话键 | 调用形态 | 结果 |
|---|---|---|---|---|
| omp | chat | 宿主自己的 UUID(有会话头) | 重放成设备调用 `write {path:"xd://mcp__magpie_acp_context_compress"}` | ✅ 本会话 `folds` 多条,最大一次 m00422–m00709 252,523 字节 |
| codex | responses | 宿主会话 id | 原生 MCP 工具名,可直接读 | ✅ 一次 `created:1` 折 m00001 5,037 字节;一次被 5,000 字节下限拒(正常) |
| omo | chat | 宿主会话 id | 原生 MCP 工具名 | ✅ 折 m00001–m00003 共 8,267 字节,原文 `decompress` 可取回 |
| opencode | chat | 宿主会话 id | exec 脚本 `tools[...].compress` | ⏳ 见下 |
| claude | anthropic | 宿主会话 id(`x-claude-code-session-id`) | 原生 `mcp__magpie-acp-context__compress` | ✅ 6 轮 `--resume` 探针,折 m00001–m00013:原文 142,047 字节 → 摘要 502 字节(会话 35 units / 281,074 字节) |
| dsh(headless)| chat | **无会话头**,退化成 `dsh\|`(所有 dsh 会话共用一个 ref 空间) | 原生 MCP 工具名,可直接读 | ✅ 5 轮探针,末轮折 m00016–m00022:原文 15,321 字节 → 摘要 1,149 字节;首次只写 m00016–m00017(626 字节)被下限拒,模型自己看到拒因后改正 |

四条与源码推断不同的实测结论:

1. **omp 在线上根本没有工具名**。它把 MCP 调用重放成「往 `xd://<tool>` 写 JSON」的设备调用,所以任何按工具名单匹配的实现都认不出。已在 `deviceCompressPayload` 里认这种形态(目标 scheme 是 `xd://` 或含 `/mcp/`、末段过工具名判定、载荷取设备的 `content`;写普通文件与别家 `compress` 不算)。
2. **omp 确实发会话头**(store 键是宿主 UUID),`pi / omp / codex 是否发会话头` 这条疑虑对 omp 已解除;dsh 明确不发,键退化成 `dsh|`。
3. **codex 的默认审批策略会静默吃掉 MCP 调用**(`never` 下直接拒),表现为「模型想折但没折」。验收 codex 车道时必须带 `--dangerously-bypass-approvals-and-sandbox`。
4. **dsh headless 确实重发历史** —— 先前「headless 不重发、窗口永远为空」是误判:那次读到的 350 计费 token 属于一个辅助请求,同一会话的真实回合是 `units 44 / 204,988 字节 / 计费 56,058 token`。headless 缺的是**会话头**,不是上下文;`keepRecentTurns=3` 在 ≥4 轮之后照常放出窗口,折叠因此可以结算。

仍未实测:`opencode compaction.auto` 恢复后的行为;dsh 的 `x-deepseek-harness-compact` 我们确实读不到(magpie hooks 的 `ctx` 不含请求头);`dsh-tui`(交互 only,`--help` 都起 TUI)与 headless 是否共用同一 `dsh|` 键有待在交互会话里确认。
