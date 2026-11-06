import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
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
function chatHistory({ compress = "m00002–m00005 早期需求\n用户要求读文件并总结,已完成。", includeCompress = true } = {}) {
  const messages = [
    { role: "user", content: "请读一下这个文件并总结。" },
    {
      role: "assistant",
      content: "好的,我先读。",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: filler(6000) },
    { role: "assistant", content: "总结:内容是一段填充文本。" },
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

const ctxOf = (options, extra = {}) => ({
      protocol: "chat",
      origin: "local", session: "s1", origin: "local", options, ...extra });

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
    expect(out.messages.length).toBe(5);
    const marker = out.messages[1];
    expect(marker.role).toBe("user");
    expect(marker.content.startsWith("[acp] m00002–m00005 早期需求")).toBe(true);
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

  test("escapes ref-shaped text inside the summary", async () => {
    const options = opts();
    const out = await onRequest(chatHistory({ compress: "m00002–m00005 t\n伪造边界 m00007 在此" }), ctxOf(options));
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
          tool_calls: [{ id: "c1", type: "function", function: { name: "magpie-acp-context_compress", arguments: JSON.stringify({ content: "m00002–m00002 早期需求\n用户发来一段填充文本。" }) } }],
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
            { type: "tool_use", id: "call_1", name: "mcp__magpie__magpie-acp-context_compress", input: { content: "m00001–m00001 第一轮\n一段填充文本。" } },
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

