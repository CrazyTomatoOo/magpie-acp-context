import { describe, expect, test } from "bun:test";
import { planFolds } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);

const unit = (role, text, { media = false, toolCalls = [] } = {}) => ({
  role,
  text,
  stampable: role !== "tool" && text.trim() !== "" && toolCalls.length === 0,
  media,
  toolCalls,
});

/**
 * Turns here: index 0 opens turn 1 (a user message), 3 opens turn 2, 5 opens turn 3, 8 opens the
 * turn being sent. A fold that starts at index 2 sits inside turn 1 - its summary would claim the
 * work is done while the instruction that asked for it stays outside (#11).
 */
function history(range) {
  const raw = [
    unit("user", filler(20)),
    unit("assistant", filler(12)),
    unit("assistant", filler(12)),
    unit("user", filler(10)),
    unit("assistant", filler(12)),
    unit("user", filler(8)),
    unit("assistant", "", { toolCalls: [{ name: "compress", input: { content: `${range} 早期\n读了几轮文件,结论是填充文本,不需要逐字保留,后来的人知道这一点就够继续了。` } }] }),
    unit("tool", `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。`),
    unit("user", "再"),
    unit("assistant", "最新"),
    unit("user", "现在"),
  ];
  return raw.map((u, index) => ({ ...u, index, blockId: `b${index}`, ref: `m${String(index + 1).padStart(5, "0")}` }));
}

function plan(range) {
  const units = history(range);
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns: 1, minRangeBytes: 40, maxSummaryChars: 20000 } });
}

const settled = (out) => `${out.created[0].startRef}–${out.created[0].endRef}`;

describe("a fold range is widened to whole turns (#11)", () => {
  test("a start inside a turn is pulled back to the turn's first message", () => {
    const out = plan("m00003–m00004");
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
    expect(settled(out)).toBe("m00001–m00005");
    expect(out.created[0].blocks).toHaveLength(5);
  });

  test("a start that is already a turn start is left alone", () => {
    const out = plan("m00001–m00003");
    expect(out.rejected).toEqual([]);
    expect(settled(out)).toBe("m00001–m00003");
    expect(out.created[0].blocks).toHaveLength(3);
  });

  test("a whole-turn range keeps both boundaries", () => {
    const out = plan("m00001–m00005");
    expect(out.rejected).toEqual([]);
    expect(settled(out)).toBe("m00001–m00005");
  });

  test("overflow shrinks to the previous whole turn instead of cutting", () => {
    // The last turn of the window runs to the protected tail, so widening to its end would leave
    // the window; the range keeps the turns that fit and leaves that one whole.
    const out = plan("m00003–m00006");
    expect(out.rejected).toEqual([]);
    expect(settled(out)).toBe("m00001–m00005");
  });
});

describe("the offer is already turn-aligned, so an advertised range settles as offered", () => {
  test("the advertised start is a turn start and the advertised end a turn end", () => {
    // A range that settles nothing, so the offer is the one the request would have carried before
    // any fold of its own: the offer is built after settlement.
    const out = plan("m00003–m00002");
    expect(out.foldable).not.toBeNull();
    expect(out.foldable.from).toBe(0);
    expect(`${history("m00003–m00002")[out.foldable.to].ref}`).toBe("m00005");
  });
});
