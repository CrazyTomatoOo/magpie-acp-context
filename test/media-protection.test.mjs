import { describe, expect, test } from "bun:test";
import { planFolds } from "../hooks.mjs";
import { adapterFor } from "../src/protocol.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);

/**
 * A fold is only safe when its stored original can give everything back. The store keeps
 * `{role, text}` and `decompress` returns that text, so a unit carrying an image, a file or
 * audio is gone the moment its range folds - the placeholder `[image]` is all that survives (#10).
 */
function history({ withImage = true, imageAt = 1, compressRange = "m00001–m00003" } = {}) {
  const raw = [
    ["user", filler(20), true, []],
    ["user", filler(10), true, []],
    ["assistant", filler(14), true, []],
    ["user", filler(12), true, []],
    [
      "assistant",
      "",
      false,
      [{ name: "compress", input: { content: `${compressRange} 早期\n读了几轮文件,结论是填充文本,不需要逐字保留,后来的人知道这一点就够继续了。` } }],
    ],
    ["tool", `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。`, false, []],
    ["user", "再", true, []],
    ["assistant", "最新", true, []],
    ["user", "现在", true, []],
  ];
  return raw.map(([role, text, stampable, toolCalls], index) => ({
    index,
    role,
    text,
    stampable,
    toolCalls,
    blockId: `b${index}`,
    ref: `m${String(index + 1).padStart(5, "0")}`,
    media: withImage && index === imageAt,
  }));
}

function plan(units) {
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns: 1, minRangeBytes: 40, maxSummaryChars: 20000 } });
}

describe("a range holding media is never folded (#10)", () => {
  test("the fold is refused and the reason names the media message", () => {
    const out = plan(history({ withImage: true }));
    expect(out.created).toHaveLength(0);
    expect(out.rejected.join("\n")).toContain("范围含媒体消息 m00002");
  });

  test("the same range folds once the media is gone", () => {
    const out = plan(history({ withImage: false }));
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].startRef).toBe("m00001");
  });

  test("negative control: text that merely contains `[image]` still folds", () => {
    const units = history({ withImage: false });
    units[2].text = `${filler(10)} [image] 和 [file] 只是这句话里的字。`;
    const out = plan(units);
    expect(out.created).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  test("a range that ENDS on the media unit is refused at its endpoint", () => {
    const out = plan(history({ withImage: true, compressRange: "m00001–m00002" }));
    expect(out.created).toHaveLength(0);
    expect(out.rejected.join("\n")).toContain("两端的消息不可折叠");
  });

  test("the advertised window starts after the newest media unit, so the offer can settle", () => {
    const units = history({ withImage: true, compressRange: "m00001–m00001" });
    const out = plan(units);
    expect(out.foldable).not.toBeNull();
    expect(units[out.foldable.from].media).toBe(false);
    expect(out.foldable.from).toBeGreaterThan(1);
    const offered = `${units[out.foldable.from].ref}–${units[out.foldable.to].ref}`;
    const applied = plan(history({ withImage: true, compressRange: offered }));
    expect(applied.rejected).toEqual([]);
    expect(applied.created).toHaveLength(1);
  });
});

describe("which payloads count as media", () => {
  const read = (protocol, body) => adapterFor(protocol).read(body);

  test("anthropic image block", () => {
    const units = read("anthropic", {
      messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image", source: { type: "base64", data: "AAAA" } }] }],
    });
    expect(units[0].media).toBe(true);
  });

  test("chat image_url part, and a tool result that carries one", () => {
    const units = read("chat", {
      messages: [
        { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "tool", tool_call_id: "c", content: [{ type: "text", text: "结果" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
      ],
    });
    expect(units[0].media).toBe(true);
    expect(units[1].media).toBe(true);
  });

  test("gemini inlineData", () => {
    const units = read("gemini", {
      contents: [{ role: "user", parts: [{ text: "看图" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] }],
    });
    expect(units[0].media).toBe(true);
  });

  test("plain text, tool calls and tool output stay foldable", () => {
    const units = read("chat", {
      messages: [
        { role: "user", content: "读一下 [image] 这个词" },
        { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c", content: "文件内容" },
      ],
    });
    expect(units.map((u) => u.media)).toEqual([false, false, false]);
  });
});
