import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { scanStore } from "../src/maintenance.mjs";
import { sessionReport } from "../src/report.mjs";
import { blockIdOf } from "../src/text.mjs";

const filler = (n) => "x".repeat(n);

function store() {
  return mkdtempSync(join(tmpdir(), "acp-cap-"));
}

/** Small numbers so a fixture can cross the cap without a megabyte of text. */
function opts(over = {}) {
  return {
    enabled: true,
    keepRecentTurns: 1,
    minRangeBytes: 1000,
    cap: { unitTokens: 100, keepChars: 50 },
    store: { dir: store() },
    ...over,
  };
}

const ctxOf = (options, extra = {}) => ({ protocol: "chat", origin: "local", session: "cap", options, ...extra });

/** One finished turn whose tool result is `size` bytes: the unit the cap exists for. */
function bigToolHistory(size = 40000, { content } = {}) {
  return {
    model: "x",
    messages: [
      { role: "user", content: "读一下那个大文件。" },
      { role: "assistant", content: "好。", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"big.log"}' } }] },
      { role: "tool", tool_call_id: "c1", content: content ?? filler(size) },
      { role: "assistant", content: "读完了,是一段填充文本。" },
      { role: "user", content: "继续" },
    ],
  };
}

const sessionOf = (options) => scanStore(options.store.dir).sessions[0];

describe("cap: one oversized unit", () => {
  test("clips it to head + marker + tail and keeps the original addressable by id", async () => {
    const options = opts();
    const body = bigToolHistory();
    const original = body.messages[2].content;
    const out = await onRequest(structuredClone(body), ctxOf(options));

    const clipped = out.messages[2].content;
    expect(clipped.startsWith(filler(50))).toBe(true);
    expect(clipped.endsWith(filler(50))).toBe(true);
    expect(clipped).toContain("[acp] 已省略");
    expect(clipped).toContain("可用 decompress 取回");
    expect(clipped.length).toBeLessThan(original.length);

    const id = blockIdOf(`tool\u0000${original}`);
    expect(clipped).toContain(id);
    const stored = JSON.parse(readFileSync(join(options.store.dir, "blocks", `${id}.json`), "utf8"));
    expect(stored.text).toBe(original);
    expect(stored.role).toBe("tool");
  });

  test("counts exactly what it left out", async () => {
    const options = opts();
    const body = bigToolHistory(40000);
    const out = await onRequest(structuredClone(body), ctxOf(options));
    const clipped = out.messages[2].content;
    const omitted = 40000 - 50 - 50;
    expect(clipped).toContain(`已省略 ${omitted.toLocaleString("en-US")} 字符`);
    expect(sessionOf(options).clips[0].beforeBytes).toBe(40000);
    // Bytes, not characters: the marker is Chinese and the report speaks in bytes.
    expect(sessionOf(options).clips[0].afterBytes).toBe(Buffer.byteLength(clipped, "utf8"));
  });

  test("is stable across requests: the same tool result is one clip, and the bytes do not drift", async () => {
    const options = opts();
    const body = bigToolHistory();
    const first = await onRequest(structuredClone(body), ctxOf(options));
    const second = await onRequest(structuredClone(body), ctxOf(options));
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect(sessionOf(options).clips.length).toBe(1);
  });

  test("negative control: a unit under the cap is byte-identical, and nothing is stored", async () => {
    const options = opts({ cap: { unitTokens: 32000, keepChars: 2000 } });
    const body = bigToolHistory(4000);
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[2].content).toBe(filler(4000));
    expect(existsSync(join(options.store.dir, "blocks"))).toBe(false);
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test('negative control: `fallback: "off"` leaves every request byte-identical', async () => {
    const options = opts({ fallback: "off" });
    const body = bigToolHistory();
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[2].content).toBe(filler(40000));
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test("a unit whose original cannot be written is left alone, and the failure is recorded", async () => {
    const options = opts();
    // A file where the blocks directory belongs: every store write fails, so no cut may happen.
    writeFileSync(join(options.store.dir, "blocks"), "");
    const body = bigToolHistory();
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[2].content).toBe(filler(40000));
    const session = sessionOf(options);
    expect(session.clips.length).toBe(0);
    expect(session.clipRefusals.length).toBe(1);
    expect(session.clipRefusals[0].reason).toContain("原文写不进存储");
    expect(sessionReport(session, { now: Date.now() }).join("\n")).toContain("超限没裁成");
  });
});

describe("cap: who it never touches", () => {
  test("media unit: a big text part beside an image is not clipped", async () => {
    const options = opts();
    const body = bigToolHistory(40000, {
      content: [
        { type: "text", text: filler(40000) },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[2].content[0].text).toBe(filler(40000));
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test("own record: a big assistant turn carrying our compress call is not clipped", async () => {
    const options = opts();
    const body = bigToolHistory(200);
    body.messages[3] = {
      role: "assistant",
      content: filler(40000),
      tool_calls: [{ id: "c2", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: "m00002–m00003 早期\n读完了。" }) } }],
    };
    const out = await onRequest(structuredClone(body), ctxOf(options));
    // It is stamped (assistant prose carries a ref) but never cut.
    expect(out.messages[3].content).toContain(filler(40000));
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test("marker: a long [acp] message is not clipped again", async () => {
    const options = opts();
    const body = bigToolHistory(200);
    body.messages[0] = { role: "user", content: `[acp] ${filler(40000)}` };
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[0].content).toContain(filler(40000));
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test("ref-bearing prose: a long user turn keeps its ref, so it is exempt", async () => {
    const options = opts();
    const body = bigToolHistory(200);
    body.messages[0] = { role: "user", content: filler(40000) };
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[0].content).toBe(`[m00001] ${filler(40000)}`);
    expect(sessionOf(options).clips.length).toBe(0);
  });

  test("a small tool result next to a big one is untouched: the gate is per unit", async () => {
    const options = opts();
    const body = bigToolHistory(200);
    body.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c3", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
    });
    body.messages.push({ role: "tool", tool_call_id: "c3", content: filler(2) });
    body.messages.push({ role: "tool", tool_call_id: "c3", content: filler(40000) });
    const out = await onRequest(structuredClone(body), ctxOf(options));
    expect(out.messages[6].content).toBe(filler(2));
    expect(out.messages[7].content).toContain("[acp] 已省略");
    expect(sessionOf(options).clips.length).toBe(1);
  });
});

describe("cap: what the operator is told", () => {
  test("acp_status reports the count, the bytes saved and the reason of the latest clip", async () => {
    const options = opts();
    await onRequest(structuredClone(bigToolHistory()), ctxOf(options));
    const session = sessionOf(options);
    const text = sessionReport(session, { now: Date.now() }).join("\n");
    const saved = 40000 - session.clips[0].afterBytes;
    expect(text).toContain("clips=1");
    expect(text).toContain("裁剪:1 条");
    expect(text).toContain(`原文省下 ${saved.toLocaleString("en-US")} 字节`);
    expect(text).toContain("cap");
    expect(text).toContain(String(session.clips[0].id));
  });
});
