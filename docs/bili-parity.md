# billion-context 变了,这个插件怎么跟着变

## 0. 结论:没有运行时耦合,只有语义同步

插件不 import billion-context(`docs/magpie-acp-plugin-design.md` 的取舍),它是在 magpie 的缝里第二次实现同一套语义。所以:

- **bili 发新版不会弄坏插件** —— 没有依赖,没有版本范围,没有 API 会被删。
- **bili 发新版会让插件过期** —— 我们抄的是它的**默认值、提示词、工具 schema、引用与折叠语义**。这些一改,我们的行为就和它不一致了,而没有任何运行时错误提示你。

过期只有三类,处置方式各不相同:

| 类别 | 例子 | 变了会怎样 | 处理 |
|---|---|---|---|
| 语义默认值 | `minCompressRange`、`minContextLimitPct`、`emergencyThresholdPct` | 折叠门槛、提示时机和 bili 不一致 | 改我们的默认 + 测试,一次提交 |
| 提示词与工具 schema | `buildCompressSystemPrompt`、`COMPRESS_PARAMETERS`、`ACP_TOOL_NAMES` | 模型对压缩工具的用法改变,我们的解析器可能不认新形状 | 读一遍、必要时同步解析器 |
| 存储与引用语义 | ref 格式、分级蒸馏、CCR 阈值 | 用户看到的 ref、可解压范围语义漂移 | 多数是**结构上做不到**(见 §2 第三类) |

## 1. 契约快照 + 漂移检查

`parity/bili-0.1.211.json` 钉住了我们抄的那部分行为,全部**从源码文本里读值,不记行号** —— 上游只挪代码不会产生噪音,改语义才会。

快照内容(实测自 `3a2d051`,`package.json` `0.1.211`):

| 键 | 值 |
|---|---|
| `config.*` | 29 个数字/布尔:`tiers.*`、`nudge.*`、`compress.*`、`absorb.*`、`crush.*`、`ccr.*`、`preserveRecent*` |
| `refs` | `{"width": 5, "format": "m%05d"}` |
| `tools.names` | `acp_cache, acp_status, compress, decompress, search_context` |
| `tools.compressToolKeys` / `compressPropertyKeys` | `["type","properties"]` / `["content"]`(`#4252` 收窄后的形状) |
| `tools.advertisesTopic` / `advertisesAnyOf` | 都是 `false` |
| `pipeline` | 17 个节点,按执行顺序 |
| `marker` | `/^\p{So}(?:[ \t])?\[ACP\][^\n]*\n?/gmu` |
| `prompts.acpTags` / `prompts.systemPrompt` | 两段提示词正文的 sha256 前 16 位 |

用法:

```bash
git clone --depth 1 https://github.com/ranxianglei/billion-context ~/bc   # 或复用已有 checkout
node scripts/parity-check.mjs --repo ~/bc        # 退出码 0=无漂移 1=有漂移 2=没有快照/checkout
node scripts/parity-check.mjs --repo ~/bc --json # 机器可读
node scripts/parity-check.mjs --repo ~/bc --update   # 采纳之后重新钉快照
```

输出会把每处差异标到我们的选项上(`parity/mapping.json` 提供对照,支持 `config.tiers.*` 这样的通配):

```
pinned bili-0.1.211.json · checkout 0.1.212 · /tmp/bc-upstream
changed config.nudge.growthFloor: 50000 → 60000 → 本插件 nudge.growthFloor
changed config.tiers.tier2Trigger: 1000 → 4000 → 不对齐:分级蒸馏要代理侧改写历史，插件结构上做不到
changed version: 0.1.211 → 0.1.212
```

这两行是真的跑出来的:干净 checkout 报“上游契约未变”,把 `growthFloor` 改 60000、`tier2Trigger` 改 4000 之后就是上面这样。

## 2. 三种处置,不新增第四种

1. **采纳** —— 改 `src/config.mjs` 的 `DEFAULTS`(或提示词),同步测试,`--update` 重新钉快照,`CHANGELOG` 记一行。
2. **忽略** —— 在 `mapping.json` 写明为什么不跟(例:`growthCap` 我们不封顶)。忽略也要记,否则下一个人会以为漏了。
3. **结构上做不到** —— 引用 `docs/magpie-middleware-feasibility.md` §3 的三条硬约束:`onEvent` 不能插入新事件、异步钩子没有 fs/网络/定时器之外的执行权、没有跨请求存储。分级蒸馏、`📦` 标记、代理内执行工具都属于这一类。**这类差异不该每次都被重新争论一遍**,表格里写死原因即可。

## 3. 已知且有意偏离的清单

| bili 的做法 | 我们的做法 | 原因 |
|---|---|---|
| ref 由会话级账本单调分配 | ref 是显示层,折叠键是内容哈希 `blockId` | 插件没有跨请求存储,客户端一压缩历史就对不上;按内容对齐则同样的内容得回同样的 ref,新内容永不复用旧 ref(`test/m3.test.mjs`) |
| 折叠可以延后到下一轮结算 | 必须在 compress 调用出现的那一轮结算完 | 下一轮那几条消息可能已经被客户端剪掉 |
| 分级蒸馏(tier2/tier3)、`preserveRecent*` 之外的保留策略 | 不做 | 需要代理侧改写历史并长期记账 |
| 紧急截断 `truncate.threshold` | 请求到上限 95%、且上限已知时,丢最老的整轮(并临时把单单元门槛降到 2,000 tokens),丢到 75%;换成一句机械声明,原文先落盘 | 采纳的是机制,不是它的时机表:我们只在**有数**的时候动手(上游报过的 ceiling → `contextLimit` → 观察到的 `usage.input` 峰值),没有数就一年不动。上限从哪来、以及为什么不用猜的窗口,见 §7「知道窗口上限才丢整轮」(#19) |
| CCR 的 `minToolTokens` 阈值 | 原文一律落盘 | 没有阈值,但也没法在代理侧做引用替换 |
| 提示词是 bili 自己的 ACP 文本 | 我们自写在 `src/nudge.mjs` / `src/config.mjs` | 语境是 magpie 的 MCP 工具,不是 bili 的 5 个工具 |
| `ALWAYS_PROTECTED_TOOLS` 保护 `compress`/`acp_rule` 的调用记录 | 保护本插件自己的工具调用与回复(含设备调用形状),但 `[acp]` marker 摘要本身仍可再折 | 守的是同一个契约:摘要即历史,「折过哪些段」这句话要留在上下文里;差别是二级折叠在这里合法,摘要之摘要的质量由另一道门管(#9) |

## 4. 许可

bili 是 **MIT**(`LICENSE` 首行 `MIT License`, `Copyright (c) 2026 ranxianglei`),所以**可以**直接 vendored 拷贝它的提示词或工具 schema,只要保留版权声明。目前我们没拷,自写反而更快;真要拷,放 `vendor/bili/<version>/`,在 `mapping.json` 里标注来源版本,并在文件头留 MIT 声明。

## 5. 节奏

每次 bili 发版走同一条线,十分钟内能走完:

1. `git -C ~/bc pull --depth 1`(或 codeload 一份新的);
2. `node scripts/parity-check.mjs --repo ~/bc`;
3. 有 diff:按 §2 逐条处置;没有 diff:什么都不做;
4. 处置完 `--update` 重钉快照,`CHANGELOG` 写一行「同步 bili x.y.z:<有没有语义变化>」。

建议**只在你真的采纳之后**才 `--update`。想留观察记录就用 `--json` 把报告存进 `parity/reports/`。

## 6. 这套机制的边界

- **上游重构文件布局**时,`parity/extract.mjs` 的 `SOURCES` 要跟着改。改漏了不会静默:对应的值会变成 `null`/空,`diff` 里以 `removed` 形式出现。
- **提示词哈希对格式敏感**:改一个空格也会变。所以它只当“这一段我读过一遍了”的信号,不是失败条件 —— 提示词变了不等于必须跟。
- 快照只覆盖**语义**,不覆盖 bug 修复。上游修了个折叠边界 bug,`diff` 看不见;这类要靠 `CHANGELOG.md` 的 `[Unreleased]` 段落人工扫(它把 `#4252`、`#3769` 这类编号都记着)。
