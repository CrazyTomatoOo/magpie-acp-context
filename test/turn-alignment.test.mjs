import { describe, expect, test } from "bun:test";
import { sessionReport } from "../src/report.mjs";
import { ACK, SUMMARY_FILLER, foldInput, planOf, transcript, unit, filler } from "./fixtures.mjs";

/**
 * Turns here: index 0 opens turn 1 (a user message), 3 opens turn 2, 5 opens turn 3, 8 opens the
 * turn being sent. A fold that starts at index 2 sits inside turn 1 - its summary would claim the
 * work is done while the instruction that asked for it stays outside (#11).
 */
function history(range) {
  return transcript([
    unit("user", filler(20)),
    unit("assistant", filler(12)),
    unit("assistant", filler(12)),
    unit("user", filler(10)),
    unit("assistant", filler(12)),
    unit("user", filler(8)),
    unit("assistant", "", { toolCalls: [{ name: "compress", input: foldInput(range, SUMMARY_FILLER) }] }),
    unit("tool", ACK),
    unit("user", "再"),
    unit("assistant", "最新"),
    unit("user", "现在"),
  ]);
}

function plan(range) {
  return planOf(history(range));
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

describe("a widening is recorded, because nothing else shows it", () => {
  test("the fold keeps the range the model asked for", () => {
    // The marker the model reads back says m00001–m00005; only the record can say it asked for
    // m00003–m00004 and was widened, which is what tells a reader the turns did the widening.
    const out = plan("m00003–m00004");
    expect(out.created[0].asked).toEqual({ from: "m00003", to: "m00004" });
  });

  test("a range the turns already covered records nothing", () => {
    expect(plan("m00001–m00005").created[0].asked).toBeUndefined();
  });

  test("the report shows the request next to the span that settled", () => {
    const out = plan("m00003–m00004");
    const text = sessionReport({ folds: () => [], foldList: out.created, refs: 5 }).join("\n");
    expect(text).toContain("m00001–m00005 (请求 m00003–m00004)");
  });
});
