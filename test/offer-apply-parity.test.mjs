import { describe, expect, test } from "bun:test";
import { planFolds } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);

/**
 * The advertised range must begin where apply would accept it (#16).
 *
 * This history puts the newest own-tool record inside the window as a call *and* its reply. The
 * reply is a tool result: a unit a fold can never begin on, so moving the window start "past the
 * record" by one index lands on it. Measured 2026-11-07: the note advertised such a start, the
 * model folded exactly it, apply refused with `两端的消息不可折叠`, and the next note advertised
 * the same impossible start again.
 */
function history({ compressRange = "m00001–m00001" } = {}) {
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

/** The same shape with no own-tool record: the window starts at the first message and stays there. */
function plainHistory({ compressRange = "m00001–m00001" } = {}) {
  const raw = [
    ["user", filler(20), true, []],
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
    blockId: `p${index}`,
    ref: `m${String(index + 1).padStart(5, "0")}`,
  }));
}

function plan(units) {
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns: 1, minRangeBytes: 40, maxSummaryChars: 20000 } });
}

const refs = (units, out) => `${units[out.foldable.from].ref}–${units[out.foldable.to].ref}`;

describe("the offer and the apply share one judgment about where a fold may start (#16)", () => {
  test("the advertised start is a unit apply accepts", () => {
    const units = history();
    const out = plan(units);
    expect(out.foldable).not.toBeNull();
    const start = units[out.foldable.from];
    expect(start.role).not.toBe("tool");
    expect(start.stampable).toBe(true);
  });

  test("the advertised range, folded verbatim, settles", () => {
    const probe = history();
    const offered = refs(probe, plan(probe));
    const out = plan(history({ compressRange: offered }));
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
    expect(`${out.created[0].startRef}–${out.created[0].endRef}`).toBe(offered);
  });

  test("negative control: a window already starting on a citable unit is unchanged", () => {
    const units = plainHistory();
    const out = plan(units);
    expect(out.foldable.from).toBe(0);
    const offered = refs(units, out);
    const applied = plan(plainHistory({ compressRange: offered }));
    expect(applied.created).toHaveLength(1);
    expect(`${applied.created[0].startRef}–${applied.created[0].endRef}`).toBe(offered);
  });

  test("the floor is measured from the shifted start, not from the unit it skipped", () => {
    // The tool result carries the bytes; the citable units after it do not. Starting on the
    // result would clear minRangeBytes and offer a range apply refuses; starting on the first
    // citable unit leaves too little to fold, so there is no offer at all.
    const raw = [
      ["user", filler(20), true, []],
      ["assistant", "", false, [{ name: "acp_status", input: {} }]],
      ["tool", filler(10), false, []],
      ["user", "短的", true, []],
      ["assistant", "也短", true, []],
      ["user", "再", true, []],
      ["user", "现在", true, []],
    ];
    const units = raw.map(([role, text, stampable, toolCalls], index) => ({
      index,
      role,
      text,
      stampable,
      toolCalls,
      blockId: `f${index}`,
      ref: `m${String(index + 1).padStart(5, "0")}`,
    }));
    const out = plan(units);
    expect(out.window.from).toBe(3);
    expect(out.foldable).toBeNull();
  });

  test("apply still refuses a hand-written range that begins on a tool result", () => {
    const units = history({ compressRange: "m00003–m00006" });
    const out = plan(units);
    expect(out.created).toHaveLength(0);
    expect(out.rejected.join("\n")).toContain("两端的消息不可折叠");
  });
});
