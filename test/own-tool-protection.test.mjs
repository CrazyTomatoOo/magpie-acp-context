import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest, planFolds } from "../hooks.mjs";
import { COMPRESS_ACK, ownToolUnit } from "../src/compress.mjs";

const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);

/**
 * A history that already ran one of our tools (an `acp_status` call and its reply) in the middle,
 * and then made a compress call. Refs are handed out in order, so `m00002` is the status call.
 */
function history({ compressRange = "m00001–m00004" } = {}) {
  const raw = [
    ["user", filler(20), true, []],
    ["assistant", "", false, [{ name: "acp_status", input: {} }]],
    ["tool", "会话状态:refs=12 folds=1", false, []],
    ["user", filler(30), true, []],
    ["assistant", filler(15), true, []],
    ["user", filler(8), true, []],
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
  }));
}

function plan(units) {
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns: 1, minRangeBytes: 40, maxSummaryChars: 20000 } });
}

describe("the plugin's own tool records are never folded away (#9)", () => {
  test("a range that swallows our status call is refused, and the reason names it", () => {
    const out = plan(history({ compressRange: "m00001–m00004" }));
    expect(out.created).toHaveLength(0);
    expect(out.rejected.join("\n")).toContain("范围含插件自己的压缩记录 m00002");
  });

  test("the same history folds once the range sits after the record", () => {
    const out = plan(history({ compressRange: "m00004–m00005" }));
    expect(out.rejected).toHaveLength(0);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].startRef).toBe("m00004");
    expect(out.created[0].endRef).toBe("m00005");
  });

  test("the offered window starts after the newest record, so the offer can settle", () => {
    const units = history({ compressRange: "m00004–m00005" });
    const withRecord = plan(units);
    // Index 2 is the record's reply - a tool result, which apply refuses as an endpoint. Moving
    // past the record means moving past the pair, to the first citable unit after it (#16).
    expect(withRecord.foldable.from).toBe(3);
    expect(units[withRecord.foldable.from].role).not.toBe("tool");
    expect(withRecord.foldable).not.toBeNull();

    const without = history({ compressRange: "m00004–m00005" }).filter((u) => u.index !== 1 && u.index !== 2).map((u, i) => ({ ...u, index: i }));
    const bare = plan(without);
    expect(bare.foldable.from).toBe(0);
  });
});

describe("what counts as our own record", () => {
  test("a call to any of our tools, and a device call aimed at one", () => {
    expect(ownToolUnit({ text: "", toolCalls: [{ name: "compress", input: {} }] })).toBe(true);
    expect(ownToolUnit({ text: "", toolCalls: [{ name: "mcp__magpie-acp-context__decompress", input: {} }] })).toBe(true);
    expect(ownToolUnit({ text: "", toolCalls: [{ name: "write", input: { path: "xd://mcp__magpie_acp_context_compress", content: "{}" } }] })).toBe(true);
  });

  test("our reply, but not a transcript that merely quotes it", () => {
    expect(ownToolUnit({ text: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` })).toBe(true);
    expect(ownToolUnit({ text: "echo 解析到 1 段" })).toBe(false);
    expect(ownToolUnit({ text: "### `magpie-acp-context_decompress`" })).toBe(false);
  });

  test("another tool's traffic is not a barrier", () => {
    expect(ownToolUnit({ text: "读到的内容", toolCalls: [{ name: "read_file", input: {} }] })).toBe(false);
    expect(ownToolUnit({ text: "", toolCalls: [{ name: "write", input: { path: "/tmp/a.txt", content: "{}" } }] })).toBe(false);
  });
});

describe("the refusal reaches the model", () => {
  test("a fold that swallows a status call is announced in the note", async () => {
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "先看状态。" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "acp_status", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "refs=3 turns=2" },
        { role: "user", content: "读一下这个文件。" },
        { role: "assistant", content: filler(400), },
        { role: "user", content: "压掉早期细节。" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c2",
              type: "function",
              function: { name: "compress", arguments: JSON.stringify({ content: "m00001–m00004 早期\n读了几轮文件,结论是填充文本,不需要逐字保留,后来的人知道这一点就够继续了。" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c2", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
        { role: "user", content: "继续" },
      ],
    };
    const out = await onRequest(structuredClone(body), {
      session: "issue-9",
      protocol: "chat",
      origin: "local",
      options: { enabled: true, keepRecentTurns: 1, minRangeBytes: 40, store: { dir: mkdtempSync(join(tmpdir(), "acp-")) } },
    });
    expect(typeof out).toBe("object");
    expect(JSON.stringify(out)).toContain("范围含插件自己的压缩记录");
  });
});
