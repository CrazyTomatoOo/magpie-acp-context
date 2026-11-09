import { describe, expect, test } from "bun:test";
import { buildNote } from "../hooks.mjs";
import { CONDENSED_SUMMARY_BYTES, MIN_SUMMARY_BYTES } from "../src/compress.mjs";
import { ACK, filler, foldInput, marker, pad, planOf, transcript } from "./fixtures.mjs";

/**
 * A summary of summaries (#14).
 *
 * Folds are ordinary messages, so a model may fold a range that is already mostly our own markers:
 * the first fold kept the prose, the second keeps prose about prose. Above half the span the floor
 * doubles and the note asks for the cross-range thread and a topic list.
 */
function history({ units, summary, range }) {
  return transcript([
    ...units,
    ["user", "把前面折掉。", true, []],
    ["assistant", "", true, [{ name: "compress", input: foldInput(range, summary) }]],
    ["tool", ACK, false, []],
    ["user", "再", true, []],
  ]);
}

const plan = (units) => planOf(units);

const material = () => `${filler(20)}${pad(120)}`;

/** One turn, three markers of four stamped units: 75% of the span is already a summary. */
const condensedUnits = () => [
  ["user", material(), true, []],
  ["assistant", marker("m00001", "m00004", material()), true, []],
  ["assistant", marker("m00005", "m00008", material()), true, []],
  ["assistant", marker("m00009", "m00012", material()), true, []],
];

/** One turn of ordinary prose: nothing here is a summary of anything. */
const plainUnits = () => [
  ["user", material(), true, []],
  ["assistant", material(), true, []],
  ["user", material(), true, []],
  ["assistant", material(), true, []],
];

describe("a range that is already mostly summaries", () => {
  test("refuses a summary under the doubled floor and says what to write instead", () => {
    const out = plan(history({ units: condensedUnits(), summary: pad(MIN_SUMMARY_BYTES + 2), range: "m00001–m00004" }));
    expect(out.created).toEqual([]);
    const reason = out.rejected.join(";");
    expect(reason).toContain(`至少要 ${CONDENSED_SUMMARY_BYTES} 字节`);
    expect(reason).toContain("跨段的主线");
    expect(reason).toContain("主题清单");
    expect(reason).toContain("75%");
  });

  test("the refusal names the earliest summary and where the range may start instead", () => {
    const out = plan(history({ units: condensedUnits(), summary: pad(MIN_SUMMARY_BYTES + 2), range: "m00001–m00004" }));
    const reason = out.rejected.join(";");
    // units[1] is the first marker, so the ledger numbers it m00002: a reader told only "80 字节"
    // cannot find the unit that raised the floor, and a range cannot shrink without a ref.
    expect(reason).toContain("最早一条是 m00002");
    expect(reason).toContain("就把范围收在 m00002 之后");
  });

  test("settles a summary that meets the doubled floor", () => {
    const body = pad(CONDENSED_SUMMARY_BYTES + 20);
    const out = plan(history({ units: condensedUnits(), summary: body, range: "m00001–m00004" }));
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].summaryBytes).toBeGreaterThanOrEqual(CONDENSED_SUMMARY_BYTES);
  });
});

describe("a range of ordinary text keeps the usual floor", () => {
  test("a summary just over the base floor settles", () => {
    const out = plan(history({ units: plainUnits(), summary: pad(MIN_SUMMARY_BYTES + 4), range: "m00001–m00004" }));
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].summaryBytes).toBeLessThan(CONDENSED_SUMMARY_BYTES);
  });
});

describe("what does not count as a summary", () => {
  test("a mechanical elision statement carries no digest", () => {
    const units = [
      ["user", material(), true, []],
      ["assistant", "[acp] 已省略 m00001–m00004 共 4 条(机械省略,没有摘要;每条原文都存着,可用 decompress 按 ref 取回)", true, []],
      ["user", material(), true, []],
      ["assistant", material(), true, []],
    ];
    const out = plan(history({ units, summary: pad(MIN_SUMMARY_BYTES + 4), range: "m00001–m00004" }));
    expect(out.rejected).toEqual([]);
    expect(out.created).toHaveLength(1);
  });

  test("a clip marker is a hole in one unit, not a summary", () => {
    const units = [
      ["user", material(), true, []],
      ["assistant", "[acp] 已省略 12,000 字符,原文 id 0419e37b71935130,可用 decompress 取回", true, []],
      ["user", material(), true, []],
      ["assistant", material(), true, []],
    ];
    const out = plan(history({ units, summary: pad(MIN_SUMMARY_BYTES + 4), range: "m00001–m00004" }));
    expect(out.created).toHaveLength(1);
  });

  test("exactly half is already mostly", () => {
    const units = [
      ["user", material(), true, []],
      ["assistant", marker("m00001", "m00004", material()), true, []],
    ];
    const out = plan(history({ units, summary: pad(MIN_SUMMARY_BYTES + 4), range: "m00001–m00002" }));
    expect(out.created).toEqual([]);
    expect(out.rejected.join(";")).toContain(`至少要 ${CONDENSED_SUMMARY_BYTES} 字节`);
  });

  test("tool traffic is neither counted nor demanded", () => {
    // Two markers of three stamped units: 67% condensed. Counting the tool units would drop it to
    // 40% and let a short summary through, so this row proves they are left out of the ratio.
    const units = [
      ["user", material(), true, []],
      ["assistant", marker("m00001", "m00004", material()), true, []],
      ["assistant", marker("m00005", "m00008", material()), true, []],
      ["assistant", "", true, [{ name: "read_file", input: { path: "a.txt" } }]],
      ["tool", material(), false, []],
    ];
    const out = plan(history({ units, summary: pad(MIN_SUMMARY_BYTES + 4), range: "m00001–m00004" }));
    expect(out.created).toEqual([]);
    expect(out.rejected.join(";")).toContain(`至少要 ${CONDENSED_SUMMARY_BYTES} 字节`);
  });
});

describe("the note asks for what a second fold would otherwise lose", () => {
  test("a condensed offer states the doubled floor and the thread", () => {
    const note = buildNote({ foldableFrom: "m00001", foldableTo: "m00008", minRangeBytes: 5000, condensed: 0.75 });
    expect(note).toContain(`摘要至少 ${CONDENSED_SUMMARY_BYTES} 字节`);
    expect(note).toContain("跨段的主线");
    expect(note).toContain("主题清单");
    expect(note).not.toContain(`摘要至少 ${MIN_SUMMARY_BYTES} 字节:被折叠的原文之后只剩摘要`);
  });

  test("an ordinary offer keeps the base sentence", () => {
    const note = buildNote({ foldableFrom: "m00001", foldableTo: "m00008", minRangeBytes: 5000, condensed: 0 });
    expect(note).toContain(`摘要至少 ${MIN_SUMMARY_BYTES} 字节:被折叠的原文之后只剩摘要`);
    expect(note).not.toContain("跨段的主线");
  });
});
