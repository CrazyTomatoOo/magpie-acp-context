import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest, onResponse } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

const filler = (n) => "x".repeat(n);

function store() {
  return { dir: mkdtempSync(join(tmpdir(), "acp-")) };
}

function opts(over = {}) {
  return {
    enabled: true,
    keepRecentTurns: 1,
    minRangeBytes: 1000,
    store: store(),
    ...over,
  };
}

/** The shape a chat client sends after it executed our compress tool call. */
function chatHistory({ compress = "m00002–m00004 早期需求\n用户要求读文件并总结,已完成。", includeCompress = true } = {}) {
  const messages = [
    { role: "user", content: "请读一下这个文件并总结。" },
    {
      role: "assistant",
      content: "好的,我先读。",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: filler(6000) },
    { role: "assistant", content: "总结:内容是一段填充文本,内容是重复的,记住「他在测折叠链路」就够,不需要逐字保留。" },
    { role: "user", content: "把更早的细节压掉吧。" },
  ];
  if (includeCompress) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: compress }) } }],
    });
    messages.push({ role: "tool", tool_call_id: "call_2", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` });
  }
  messages.push({ role: "user", content: "继续" });
  return { model: "x", messages };
}

/** The shape an agentic host sends: one user turn, then a long run of tool steps. */
function agenticHistory({ exchanges = 12, reminders = 0, includeCompress = true, compress = "m00002–m00012 早期排查\n读了几轮文件,结论是填充文本,不需要逐字保留。" } = {}) {
  const messages = [{ role: "user", content: "查一下这个仓库为什么会话一直膨胀。" }];
  for (let i = 0; i < reminders; i += 1) messages.push({ role: "user", content: `<system-reminder>第 ${i} 条提醒</system-reminder>` });
  for (let i = 0; i < exchanges; i += 1) {
    messages.push({
      role: "assistant",
      content: `第 ${i} 次读文件`,
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${i}.txt"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `${i} ${filler(2000)}` });
  }
  if (includeCompress) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_c", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: compress }) } }],
    });
    messages.push({ role: "tool", tool_call_id: "call_c", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` });
  }
  messages.push({ role: "user", content: "继续" });
  return { model: "x", messages };
}

const ctxOf = (options, extra = {}) => ({
  protocol: "chat",
  origin: "local", session: "s1", options, ...extra });

describe("refs", () => {
  test("stamps a durable ref on prose and leaves tool turns alone", async () => {
    const options = opts();
    const body = chatHistory({ includeCompress: false });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[0].content.startsWith("[m00001] ")).toBe(true);
    expect(out.messages[3].content.startsWith("[m00004] ")).toBe(true);
    expect(out.messages[2].content).toBe(filler(6000)); // tool result untouched
  });

  test("a blank assistant turn keeps its blank content", async () => {
    const options = opts();
    const body = chatHistory({ includeCompress: false });
    body.messages[1].content = "";
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[1].content).toBe("");
    expect(out.messages[1].tool_calls[0].id).toBe("call_1");
  });

  test("same history in, same bytes out (prompt-cache rule)", async () => {
    const options = opts();
    const body = chatHistory();
    const a = await onRequest(structuredClone(body), ctxOf(options));
    const b = await onRequest(structuredClone(body), ctxOf(options));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("a new turn appends refs instead of renumbering the old ones", async () => {
    const options = opts();
    const body = chatHistory({ includeCompress: false });
    const first = await onRequest(structuredClone(body), ctxOf(options));
    const grown = structuredClone(body);
    grown.messages.push({ role: "assistant", content: "好的。" }, { role: "user", content: "再说一句" });
    const second = await onRequest(structuredClone(grown), ctxOf(options));
    expect(second.messages[0].content).toBe(first.messages[0].content);
    // the ledger, not the position, decides: the new turn continues the numbering
    const newTurn = second.messages.length - 2; // chatHistory always appends a pending user turn
    expect(second.messages[newTurn].content.startsWith("[m00007] ")).toBe(true);
  });
});

describe("folding", () => {
  test("collapses the named range into one marker block", async () => {
    const options = opts();
    const out = await onRequest(chatHistory(), ctxOf(options));
    expect(out.messages.length).toBe(6);
    const marker = out.messages[1];
    expect(marker.role).toBe("user");
    expect(marker.content.startsWith("[acp] m00002–m00004 早期需求")).toBe(true);
    expect(marker.content).toContain("用户要求读文件并总结");
  });

  test("never folds the turn being sent", async () => {
    const options = opts();
    const out = await onRequest(chatHistory(), ctxOf(options));
    const last = out.messages[out.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("继续");
    expect(last.content).not.toContain("[acp] m");
  });

  test("keeps the tool call and its result on the same side of the cut", async () => {
    const options = opts();
    const out = await onRequest(chatHistory(), ctxOf(options));
    const text = JSON.stringify(out.messages);
    expect(text.includes('"tool_call_id":"call_1"')).toBe(false);
  });

  test("drops a fold whose anchors the client already compacted away", async () => {
    const options = opts();
    await onRequest(chatHistory(), ctxOf(options));
    const compacted = chatHistory({ includeCompress: true });
    compacted.messages.splice(1, 4); // the client's own compaction removed the block
    const out = await onRequest(compacted, ctxOf(options));
    expect(JSON.stringify(out.messages)).not.toContain("[acp] m00002");
  });

  test("ignores a range under minRangeBytes", async () => {
    const options = opts({ minRangeBytes: 999999 });
    const out = await onRequest(chatHistory(), ctxOf(options));
    expect(JSON.stringify(out.messages)).not.toContain("[acp] m00002");
  });

  test("no compress call in the transcript means no fold", async () => {
    const options = opts();
    const out = await onRequest(chatHistory({ includeCompress: false }), ctxOf(options));
    expect(JSON.stringify(out.messages)).not.toContain("[acp] m0000");
  });

  test("announces a foldable range in a session that has only one user turn", async () => {
    // Measured on omp 2026-11-07: one user turn, 3,500 units, zero folds. Keeping N trailing user
    // turns protected the whole history, so no range was ever announced, and the body grew to
    // 1.28M tokens until the provider refused it.
    const options = opts({ keepRecentTurns: 3 });
    const out = await onRequest(agenticHistory({ includeCompress: false }), ctxOf(options));
    expect(out.messages.at(-1).content).toMatch(/当前可以折叠的范围是 m00001–m\d{5}/);
  });

  test("settles a fold that names the range it announced", async () => {
    const options = opts({ keepRecentTurns: 3 });
    const announced = (await onRequest(agenticHistory({ includeCompress: false }), ctxOf(options))).messages.at(-1).content;
    const [, from, to] = announced.match(/当前可以折叠的范围是 (m\d{5})–(m\d{5})/);
    const out = await onRequest(agenticHistory({ compress: `${from}–${to} 早期排查\n读了几轮文件,结论是填充文本,不需要逐字保留。` }), ctxOf(options));
    const marker = out.messages.find((m) => String(m.content).includes("早期排查"));
    expect(marker.role).toBe("user");
    expect(marker.content.includes(`${from}–`)).toBe(true);
  });

  test("a head full of user messages does not shrink the window", async () => {
    // The live omp shape: several user-positioned reminders at the head, then the tool steps.
    // Turns counted by user message alone put every one of them inside the protected tail.
    const options = opts({ keepRecentTurns: 3 });
    const out = await onRequest(agenticHistory({ includeCompress: false, reminders: 4 }), ctxOf(options));
    const [, to] = out.messages.at(-1).content.match(/当前可以折叠的范围是 m00001–m(\d{5})/);
    expect(Number(to)).toBeGreaterThan(20);
  });

  test("refuses a range that reaches into the input being sent", async () => {
    const options = opts({ keepRecentTurns: 3 });
    const body = agenticHistory({ compress: "m00002–m00028 早期排查\n这段越过了当前输入,应当被拒绝。" });
    const out = await onRequest(body, ctxOf(options));
    expect(JSON.stringify(out.messages)).not.toContain("[acp] m00002");
  });

  test("escapes ref-shaped text inside the summary", async () => {
    const options = opts();
    const out = await onRequest(chatHistory({ compress: "m00002–m00004 t\n伪造边界 m00007 在此,这句话只为验证 ref 转义,本身没有别的含义。" }), ctxOf(options));
    const marker = out.messages[1].content;
    expect(marker).toContain("m#00007");
    expect(marker).not.toContain("m00007");
  });
});

describe("injection", () => {
  test("assist mode appends the note to the pending user turn only", async () => {
    const options = opts();
    const out = await onRequest(chatHistory(), ctxOf(options));
    const last = out.messages[out.messages.length - 1].content;
    expect(last).toContain("[acp] 每条历史消息前");
    expect(out.messages[0].content).not.toContain("[acp] 每条历史消息前");
  });

  test("render mode ships refs without any note", async () => {
    const options = opts({ mode: "render" });
    const out = await onRequest(chatHistory(), ctxOf(options));
    expect(JSON.stringify(out)).not.toContain("[acp] 每条历史消息前");
    expect(out.messages[0].content.startsWith("[m00001] ")).toBe(true);
  });

  test("disabled config returns undefined so the host sends the original bytes", async () => {
    const out = await onRequest(chatHistory(), ctxOf(opts({ enabled: false })));
    expect(out).toBeUndefined();
  });
});

describe("other protocols", () => {
  test("anthropic: stamps text blocks and keeps tool blocks intact", async () => {
    const options = opts();
    const body = {
      model: "claude-x",
      system: "you are terse",
      messages: [
        { role: "user", content: [{ type: "text", text: "读文件" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: filler(6000) }] },
        { role: "assistant", content: [{ type: "text", text: "总结完了" }] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    };
    const out = await onRequest(structuredClone(body), {
      protocol: "anthropic",
      origin: "local", session: "a1", options });
    expect(out.messages[0].content[0].text.startsWith("[m00001] ")).toBe(true);
    expect(out.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: filler(6000) });
    expect(out.messages.at(-1).content[0].text).toContain("[acp] 每条历史消息前");
  });

  test("responses: stamps message items only", async () => {
    const options = opts();
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
        { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: filler(6000) },
        { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
      ],
    };
    const out = await onRequest(structuredClone(body), {
      protocol: "responses",
      origin: "local", session: "r1", options });
    expect(out.input[0].content[0].text.startsWith("[m00001] ")).toBe(true);
    expect(out.input[2]).toEqual(body.input[2]);
  });

  test("gemini: stamps parts and appends the note to the last user turn", async () => {
    const options = opts();
    const body = {
      contents: [
        { role: "user", parts: [{ text: "你好" }] },
        { role: "model", parts: [{ text: "在" }] },
        { role: "user", parts: [{ text: "继续" }] },
      ],
      systemInstruction: { role: "system", parts: [{ text: "be brief" }] },
    };
    const out = await onRequest(structuredClone(body), {
      protocol: "gemini",
      origin: "local", session: "g1", options });
    expect(out.contents[0].parts[0].text.startsWith("[m00001] ")).toBe(true);
    expect(out.contents.at(-1).parts[0].text).toContain("[acp] 每条历史消息前");
    expect(out.systemInstruction.parts[0].text).toBe("be brief");
  });

  test("unknown protocol is left alone", async () => {
    const out = await onRequest({ anything: 1 }, {
      protocol: "weird",
      origin: "local", session: "w1", options: opts() });
    expect(out).toBeUndefined();
  });
});

describe("sessions inherited from another compressor", () => {
  const legacyMarker = "📦 [ACP] m00182–m00190 需求梳理\n用户要一份分层压缩的设计说明。";

  /** A history produced while the client talked to billion-context instead of magpie. */
  function legacyHistory(extra = []) {
    return {
      model: "x",
      messages: [
        { role: "system", content: "You are a careful agent." },
        { role: "user", content: "用户:读文件并总结" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "r1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
        },
        { role: "tool", tool_call_id: "r1", content: filler(6000) },
        { role: "assistant", content: legacyMarker },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c9",
              type: "function",
              function: { name: "compress", arguments: JSON.stringify({ content: "m00182–m00190 需求梳理\n用户要一份分层压缩的设计说明。" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c9", content: "已折叠 9 条" },
        { role: "user", content: "继续" },
        ...extra,
      ],
    };
  }

  test("system prompts take no ref, so the first message is m00001", async () => {
    const options = opts();
    const body = legacyHistory();
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(out.messages[0].content)).toBe("You are a careful agent.");
    expect(String(out.messages[1].content).startsWith("[m00001] ")).toBe(true);
  });

  test("a compress call citing refs we never issued is reported instead of silently dropped", async () => {
    const options = opts();
    const body = legacyHistory();
    const out = await onRequest(structuredClone(body), ctxOf(options));
    const note = String(out.messages.at(-1).content);
    expect(note).toContain("来自别的压缩器");
    expect(note).toContain("m00182–m00190");
    expect(out.messages.some((m) => String(m.content).startsWith("[acp] "))).toBe(false);
    expect(out.messages.length).toBe(body.messages.length);
  });

  // The spiky case at switchover: bili numbered the same history too, so a stale call can
  // name two prose refs that exist in OUR numbering while its summary describes bili s
  // range. Settling it pastes the wrong summary over the wrong messages, silently.
  test("a foreign call whose refs land on our prose is never adopted", async () => {
    const options = opts();
    const body = {
      model: "x",
      messages: [
        { role: "user", content: filler(900) },
        { role: "assistant", content: filler(900) },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c11",
              type: "function",
              function: { name: "compress", arguments: JSON.stringify({ content: "m00001–m00002 别的会话\n这段摘要描述的是 bili 当时看到的另外两条消息。" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c11", content: "已折叠 2 条" },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages.some((m) => String(m.content).startsWith("[acp] "))).toBe(false);
    expect(JSON.stringify(out.messages)).toContain(filler(900));
    expect(String(out.messages.at(-1).content)).toContain("来自别的压缩器");
  });

  test("the inherited history keeps folding once the model uses our refs", async () => {
    const options = opts();
    const body = legacyHistory([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c10", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: "m00001–m00004 读文件\n用户要求读 a.txt 并总结,旧摘要已并入。" }) } },
        ],
      },
      { role: "tool", tool_call_id: "c10", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
      { role: "user", content: "继续第二次" },
    ]);
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages.length).toBeLessThan(body.messages.length);
    expect(String(out.messages[1].content).startsWith("[acp] m00001–m00004")).toBe(true);
    expect(JSON.stringify(out.messages).includes(filler(6000))).toBe(false);
  });
});

describe("a lane whose replay shape nothing here knows", () => {
  // The failure this guard exists for was silent for a whole session: the tool answered
  // "解析到 1 段" every time and no fold ever settled (omp, 491 refs, 2026-11-07). A shape nobody
  // has taught the reader yet has to say its name out loud instead.
  const withShape = (name, args) => {
    const messages = [
      { role: "user", content: "把早期细节折掉。" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] },
      { role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
      { role: "user", content: "继续" },
    ];
    return { model: "x", messages };
  };

  test("names the shape and says the fold will not settle", async () => {
    const options = opts();
    const body = withShape("dispatch", JSON.stringify({ call: { server: "magpie-acp-context", tool: "compress" } }));
    const out = await onRequest(structuredClone(body), ctxOf(options));
    const note = String(out.messages.at(-1).content);
    expect(note).toContain("读不出对应的调用");
    expect(note).toContain("dispatch");
  });

  test("a readable call keeps the note quiet", async () => {
    const options = opts();
    const body = chatHistory();
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(out.messages.at(-1).content)).not.toContain("读不出对应的调用");
  });

  test("a call named like ours whose arguments are not a range is reported, not ignored", async () => {
    const options = opts();
    const body = withShape("mcp__magpie-acp-context__compress", '{"ranges":[]}');
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(out.messages.at(-1).content)).toContain("载荷读不出来");
  });
});

describe("a refusal that has been superseded", () => {
  test("is not re-announced once a later fold settled", async () => {
    const options = opts();
    const body = chatHistory();
    await onRequest(structuredClone(body), ctxOf(options));
    const after = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(after.messages.at(-1).content)).not.toContain("上一次折叠请求没有生效");
  });

  test("is still announced while nothing has settled", async () => {
    const options = opts();
    const body = chatHistory({ compress: "m00002–m00004 早期需求\n太短" });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(out.messages.at(-1).content)).toContain("上一次折叠请求没有生效");
  });
});

describe("a range a settled fold already covers", () => {
  // Measured 2026-11-07 on the omp lane: after m00387–m00421 folded, the earlier 28-byte attempt
  // for the same span kept announcing its refusal every turn, and a second call would have folded
  // the same span twice.
  const twice = (secondSummary) => {
    const body = chatHistory();
    const first = body.messages.find((m) => m.tool_calls?.some((c) => c.function.name === "compress"));
    const result = { role: "tool", tool_call_id: "call_2", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` };
    body.messages.push(
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_3", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: secondSummary }) } }],
      },
      { ...result, tool_call_id: "call_3" },
      { role: "user", content: "继续" },
    );
    expect(first).toBeTruthy();
    return body;
  };

  test("a later attempt on the same span is neither re-folded nor re-reported", async () => {
    const options = opts();
    const body = twice("m00002–m00004 早期需求\n太短");
    await onRequest(structuredClone(body), ctxOf(options));
    const after = await onRequest(structuredClone(body), ctxOf(options));
    const note = String(after.messages.at(-1).content);
    expect(note).not.toContain("上一次折叠请求没有生效");
    const session = JSON.parse(readFileSync(join(options.store.dir, "sessions", "s1.json"), "utf8"));
    expect(session.folds).toHaveLength(1);
  });
});

describe("a device call whose payload is not a range", () => {
  test("names the target so the shape is visible in one line", async () => {
    const options = opts();
    const body = chatHistory();
    const call = body.messages.find((m) => m.tool_calls?.some((c) => c.function.name === "compress")).tool_calls[0];
    call.function.name = "write";
    call.function.arguments = JSON.stringify({ path: "xd://mcp__magpie_acp_context_compress", content: "随便写点什么" });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(String(out.messages.at(-1).content)).toContain("xd://mcp__magpie_acp_context_compress");
  });
});

describe("the note a model reads before its first fold", () => {
  test("names the tool's real argument, not a shape the tool would reject", async () => {
    const out = await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctxOf(opts()));
    const note = String(out.messages.at(-1).content);
    expect(note).toContain("content");
    expect(note).not.toContain("startRef");
  });
});

describe("a host that reaches MCP through its generic device call", () => {
  // Measured on omp 2026-11-07 (the captured request body): the transcript replays a compress
  // call as `write {path:"xd://mcp__magpie_acp_context_compress", content:"{...}"}`. The wire
  // never names the tool, so the fold never settled in that lane while the reader looked for a
  // call named `compress`.
  const throughDevice = (body, { path = "xd://mcp__magpie_acp_context_compress" } = {}) => {
    const call = body.messages.find((m) => m.tool_calls?.some((c) => c.function.name === "compress")).tool_calls[0];
    call.function.name = "write";
    call.function.arguments = JSON.stringify({ path, i: "折叠", content: call.function.arguments });
    return body;
  };

  test("the fold settles", async () => {
    const options = opts();
    const body = throughDevice(chatHistory());
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages.length).toBeLessThan(body.messages.length);
    expect(String(out.messages[1].content).startsWith("[acp] m00002–m00004")).toBe(true);
  });

  test("a write to a file is not a fold", async () => {
    const options = opts();
    const body = throughDevice(chatHistory(), { path: "src/index.mjs" });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages.length).toBe(body.messages.length);
    expect(JSON.stringify(out.messages).includes(filler(6000))).toBe(true);
  });

  test("another server's compress is not ours", async () => {
    const options = opts();
    const body = throughDevice(chatHistory(), { path: "xd://mcp__other__compress" });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages.length).toBe(body.messages.length);
  });
});

describe("canary rollout", () => {
  // Replacing every window at once is the risky move this gate exists to avoid: with
  // `agents` naming one client, every other client's request leaves this hook untouched.
  test("an agent outside the list gets its request back untouched", async () => {
    const options = opts({ agents: ["omp"] });
    const body = chatHistory({ includeCompress: false });
    const out = await onRequest(structuredClone(body), ctxOf(options, { agent: "claude" }));
    expect(out).toBeUndefined();
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
  });

  test("an agent inside the list is handled", async () => {
    const options = opts({ agents: ["omp"] });
    const out = await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctxOf(options, { agent: "omp" }));
    expect(out?.messages?.length).toBeGreaterThan(0);
  });

  // onResponse is the other half of the gate: recording usage for a client the canary
  // excludes would still create that client's ledger file, which is a trace of a client
  // we promised to leave alone.
  test("a caller that is not the owner's is left alone", async () => {
    const options = opts();
    expect(await onRequest(structuredClone(chatHistory()), ctxOf(options, { origin: "remote" }))).toBeUndefined();
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
    await onResponse({ usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } }, ctxOf(options, { origin: "remote" }));
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
  });

  test("an unknown origin is not local", async () => {
    const options = opts();
    expect(await onRequest(structuredClone(chatHistory()), ctxOf(options, { origin: undefined }))).toBeUndefined();
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
  });

  test("the owner's own key is served", async () => {
    const options = opts();
    const out = await onRequest(structuredClone(chatHistory()), ctxOf(options, { origin: "magpie-key" }));
    expect(JSON.stringify(out)).toContain("[m00001]");
  });

  test("an agent outside the list leaves no usage record either", async () => {
    const options = opts({ agents: ["omp"] });
    await onResponse({ usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 } }, ctxOf(options, { agent: "claude" }));
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
  });

  test("an agent inside the list is recorded, once its request has been served", async () => {
    const options = opts({ agents: ["omp"] });
    const reply = { usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 } };
    const sessionFiles = () =>
      existsSync(join(options.store.dir, "sessions"))
        ? readdirSync(join(options.store.dir, "sessions")).filter((n) => n.endsWith(".json"))
        : [];
    // A reply alone is not evidence that this plugin serves the client: a ledger written
    // from a reply nobody served would be a trace of a request that never reached the hook.
    await onResponse(reply, ctxOf(options, { agent: "omp" }));
    expect(sessionFiles().length).toBe(0);
    await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctxOf(options, { agent: "omp" }));
    await onResponse(reply, ctxOf(options, { agent: "omp" }));
    expect(sessionFiles().length).toBe(1);
  });

  test("an empty list means every agent, and disabled means nobody", async () => {
    const body = chatHistory({ includeCompress: false });
    expect(await onRequest(structuredClone(body), ctxOf(opts({ agents: [] }), { agent: "pi" }))).toBeDefined();
    expect(await onRequest(structuredClone(body), ctxOf(opts({ enabled: false }), { agent: "pi" }))).toBeUndefined();
  });
});

describe("session identity", () => {
  // Which ledger a request lands in is the only thing deciding whether two
  // conversations mix. magpie hands us the client's own id as ctx.session; when a
  // client sends no session header we fall back to agent|cwd, which must still be
  // a usable file name (a cwd is full of slashes).
  test("ctx.session names the ledger", async () => {
    const options = opts();
    await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctxOf(options, { session: "ses_abc" }));
    expect(existsSync(join(options.store.dir, "sessions", "ses_abc.json"))).toBe(true);
  });

  test("without a session header the key is the sanitized agent|cwd", async () => {
    const options = opts();
    const ctx = { protocol: "chat", origin: "local", agent: "omp", cwd: "/Volumes/work/proj", options };
    await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctx);
    expect(existsSync(join(options.store.dir, "sessions", "omp__Volumes_work_proj.json"))).toBe(true);
  });

  test("a hostile session id stays inside the sessions folder", async () => {
    const options = opts();
    await onRequest(structuredClone(chatHistory({ includeCompress: false })), ctxOf(options, { session: "../../etc/passwd" }));
    const names = readdirSync(join(options.store.dir, "sessions")).filter((n) => n.endsWith(".json"));
    expect(names.length).toBe(1);
    expect(names[0]).not.toContain("/");
    expect(names[0].endsWith(".json")).toBe(true);
    expect(existsSync(join(options.store.dir, "sessions", names[0]))).toBe(true);
  });
});

describe("folds a real client actually sends", () => {
  test("a one-message range folds instead of being dropped", async () => {
    const options = opts();
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "读一下。" },
        { role: "assistant", content: filler(6000) },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "magpie-acp-context_compress", arguments: JSON.stringify({ content: "m00002–m00002 早期需求\n用户发来一段填充文本,重复内容,记住「他在测折叠」就够,不需要原文。" }) } }],
        },
        { role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[1].content.startsWith("[acp] m00002–m00002 早期需求")).toBe(true);
    expect(out.messages[1].content).toContain("用户发来一段填充文本");
    expect(JSON.stringify(out.messages)).not.toContain(filler(6000));
  });

  test("a tool_result handed back as blocks still reads as acknowledged", async () => {
    const options = opts();
    const body = {
      model: "claude-x",
      system: [{ type: "text", text: "you are terse" }],
      messages: [
        { role: "user", content: [{ type: "text", text: filler(6000) }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "收到。" },
            { type: "tool_use", id: "call_1", name: "mcp__magpie__magpie-acp-context_compress", input: { content: "m00001–m00001 第一轮\n一段填充文本,内容是重复的,记住「他在测折叠链路」就够,不需要逐字保留。" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
                { type: "text", text: "<system-reminder>\n<total_tokens>1 tokens left</total_tokens>\n</system-reminder>" },
              ],
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "No response requested." }] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(options, { protocol: "anthropic" }));
    expect(out.messages[0].content[0].text.startsWith("[acp] m00001–m00001 第一轮")).toBe(true);
    expect(JSON.stringify(out.messages)).not.toContain(filler(6000));
  });
});

describe("a fold written inside codex's exec script settles", () => {
  test("the script's call is read on the responses wire and folded", async () => {
    const options = opts({ minRangeBytes: 1000 });
    const script = `const r = await tools.mcp__magpie_acp_context__compress({content:${JSON.stringify("m00001–m00001 第一轮\n用户第一轮只要求做一件事,结论已记下,原文不必再保留。")}}); text(r)`;
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: `第一轮 ${filler(2000)}` }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] },
        { type: "custom_tool_call", call_id: "c1", name: "exec", input: script },
        { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
      ],
    };
    const out = await onRequest(structuredClone(body), { protocol: "responses", origin: "local", session: "codex1", options });
    const text = JSON.stringify(out.input);
    expect(text).toContain("acp]");
    expect(text).not.toContain(filler(2000));
  });
});

describe("the nudge names a range a fold can actually cite", () => {
  test("a history that opens with a system prompt starts the window at the first ref", async () => {
    // Measured on codex 2026-11-07: the window began at index 0, the system prompt, which never
    // gets a ref, so the nudge told the model `可折叠范围是 undefined–m00008`.
    const options = opts({ nudge: { growthFloor: 1 } });
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "你是助手。" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: filler(3000) }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
      ],
    };
    const out = await onRequest(structuredClone(body), { protocol: "responses", origin: "local", session: "w1", options });
    const text = JSON.stringify(out.input);
    expect(text).toContain("可折叠范围是 m00001–");
    expect(text).not.toContain("undefined");
  });
});

describe("a fold that cannot settle says why", () => {
  test("a range under the floor is reported, not silently dropped", async () => {
    const body = {
      model: "x",
      messages: [
        { role: "user", content: filler(20) },
        { role: "assistant", content: "ok" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "magpie-acp-context_compress", arguments: JSON.stringify({ content: "m00001–m00001 小段\n前面那句是小段原文,这里写摘要正文,长度足够替换它。" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(opts({ minRangeBytes: 5000 })));
    const note = JSON.stringify(out.messages);
    expect(note).toContain("上一次折叠请求没有生效");
    expect(note).toContain("低于 minRangeBytes=5000");
  });

  test("a summary too short to replace the range is refused", async () => {
    const body = {
      model: "x",
      messages: [
        { role: "user", content: filler(4000) },
        { role: "assistant", content: "ok" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "magpie-acp-context_compress", arguments: JSON.stringify({ content: "m00001–m00002 填充\n填充" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(opts({ minRangeBytes: 100 })));
    const note = JSON.stringify(out.messages);
    expect(note).toContain("摘要只有 6 字节,至少要 40 字节");
    expect(note).not.toContain("填充填充");
  });

  test("the same range settles once the summary is long enough", async () => {
    const summary = "这一段是填充文本,内容重复,记住「用户在测折叠」即可,不需要原文。";
    const body = {
      model: "x",
      messages: [
        { role: "user", content: filler(4000) },
        { role: "assistant", content: "ok" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "magpie-acp-context_compress", arguments: JSON.stringify({ content: `m00001–m00002 填充\n${summary}` }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), ctxOf(opts({ minRangeBytes: 100 })));
    const wire = JSON.stringify(out.messages);
    expect(wire).toContain(summary);
    expect(wire).not.toContain("上一次折叠请求没有生效");
  });

  test("nothing refused means the note stays quiet about refusals", async () => {
    const out = await onRequest(
      { model: "x", messages: [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }, { role: "user", content: "继续" }] },
      ctxOf(opts()),
    );
    expect(JSON.stringify(out.messages)).not.toContain("上一次折叠请求没有生效");
  });
});

