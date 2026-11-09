import { describe, expect, test } from "bun:test";
import { ACK, compressCall, planOf, transcript, unit } from "./fixtures.mjs";

describe("the shared history skeleton", () => {
  test("refuses a history that opens on an assistant turn", () => {
    // The guard is the whole reason this file exists: such a history has no turn start at index 0,
    // so `alignToTurns` snaps the requested range forward and the test measures another range.
    expect(() => transcript([["assistant", "早期", true, []]])).toThrow("must open on a user turn");
  });

  test("numbers refs in ledger order and treats an absent media flag as false", () => {
    const units = transcript([
      ["user", "一", true, []],
      ["assistant", "二", true, []],
    ]);
    expect(units.map((u) => u.ref)).toEqual(["m00001", "m00002"]);
    expect(units.map((u) => u.media)).toEqual([false, false]);
  });

  test("derives stampable the way the wires do", () => {
    expect(unit("assistant", "", { toolCalls: [{ name: "acp_status", input: {} }] }).stampable).toBe(false);
    expect(unit("tool", "文件内容").stampable).toBe(false);
    expect(unit("user", "读一下").stampable).toBe(true);
  });

  test("the shared pieces agree with the wire the model actually writes", () => {
    const units = transcript([
      ["user", "填充文本,内容重复,记住结论就够。".repeat(20), true, []],
      ["assistant", ACK, false, []],
    ]);
    expect(compressCall("c1", "m00001–m00001").tool_calls[0].function.arguments).toContain("m00001–m00001 早期");
    expect(planOf(units).created).toEqual([]);
  });
});
