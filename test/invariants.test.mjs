import { describe, expect, test } from "bun:test";
import { planFolds } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);
const SHORT = "短句";

// Mirrors what the wire adapters produce: only a user/assistant text turn is stampable.
const unit = (role, text, { media = false, toolCalls = [] } = {}) => ({
  role,
  text,
  stampable: role !== "tool" && text.trim() !== "" && toolCalls.length === 0,
  media,
  toolCalls,
});

/**
 * Every fixture shares one skeleton so the window lands where it matters: indices 0-5 are the
 * variable part (the segment under test), 6-10 are a compress call and the protected tail.
 *
 * The property, once per history: whatever `planFolds` advertises as the foldable range must
 * settle when folded verbatim. #16 (a start on a tool result) and #10 (a range crossing media)
 * were both violations of it, and each was found by a bespoke test rather than by this one.
 */
function build(rows, range = "m00001–m00001", padText = filler(12)) {
  // Six variable units, so the window (which stops before the protected tail) contains them.
  const padded = [...rows];
  while (padded.length < 6) padded.push(unit(padded.length % 2 ? "assistant" : "user", padText));
  const raw = [
    ...padded,
    unit("assistant", "", { toolCalls: [{ name: "compress", input: { content: `${range} 早期\n读了几轮文件,结论是填充文本,不需要逐字保留,后来的人知道这一点就够继续了。` } }] }),
    unit("tool", `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。`),
    unit("user", "再"),
    unit("assistant", "最新"),
    unit("user", "现在"),
  ];
  return raw.map((u, index) => ({ ...u, index, blockId: `b${index}`, ref: `m${String(index + 1).padStart(5, "0")}` }));
}

function plan(units) {
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns: 1, minRangeBytes: 40, maxSummaryChars: 20000 } });
}

const ownRecord = () => [
  unit("assistant", "", { toolCalls: [{ name: "acp_status", input: {} }] }),
  unit("tool", "refs=12 folds=1"),
];
const mediaUnit = () => [{ ...unit("user", filler(6)), media: true }];

const CASES = [
  {
    name: "plain",
    rows: () => [unit("user", filler(20)), unit("user", filler(6)), unit("assistant", filler(8))],
  },
  {
    name: "own record at the head of the window",
    rows: () => [unit("user", filler(20)), ...ownRecord(), unit("user", filler(12))],
  },
  {
    name: "own record in the middle of the window",
    rows: () => [unit("user", filler(20)), unit("user", filler(6)), ...ownRecord(), unit("user", filler(10))],
  },
  {
    name: "media at the head of the window",
    rows: () => [unit("user", filler(20)), ...mediaUnit(), unit("assistant", filler(12))],
  },
  {
    name: "media in the middle of the window",
    rows: () => [unit("user", filler(20)), unit("user", filler(6)), ...mediaUnit(), unit("assistant", filler(10))],
  },
  {
    name: "media and our own record together",
    rows: () => [unit("user", filler(20)), ...mediaUnit(), ...ownRecord(), unit("user", filler(10))],
  },
];

describe("an advertised range always settles when folded verbatim", () => {
  let offers = 0;

  for (const { name, rows } of CASES) {
    test(name, () => {
      const probe = build(rows());
      const out = plan(probe);
      if (!out.foldable) return;
      offers += 1;
      const range = `${probe[out.foldable.from].ref}–${probe[out.foldable.to].ref}`;
      const applied = plan(build(rows(), range));
      expect(applied.rejected).toEqual([]);
      expect(applied.created).toHaveLength(1);
      expect(`${applied.created[0].startRef}–${applied.created[0].endRef}`).toBe(range);
    });
  }

  test("the matrix is not empty: most histories produce an offer", () => {
    expect(offers).toBeGreaterThanOrEqual(5);
  });
});

describe("a window under the fold floor advertises nothing at all", () => {
  test("short history, no offer rather than an offer that cannot settle", () => {
    const out = plan(build([unit("user", SHORT)], "m00001–m00001", SHORT));
    expect(out.foldable).toBeNull();
  });
});
