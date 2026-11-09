import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { onRequest, onResponse } from "../hooks.mjs";
import {
  decideNudge,
  nudgeMinGain,
  NUDGE_HINT,
  NUDGE_NO_WINDOW,
  NUDGE_NONE,
  NUDGE_SMALL_WINDOW,
} from "../src/nudge.mjs";
import { sessionReport } from "../src/report.mjs";
import { compressAck as ack, compressCall as call, tempStore, wireOptions } from "./fixtures.mjs";

const FLOOR = 4000;
const opts = (over = {}) => wireOptions(tempStore("acp-nudge-"), { nudge: { growthFloor: FLOOR }, ...over });
const ctxOf = (options, session = "e") => ({ protocol: "chat", origin: "local", session, options });
const stateOf = (options) => JSON.parse(readFileSync(join(options.store.dir, "sessions", "e.json"), "utf8"));
const noteOf = (out) => String(out?.messages?.at(-1)?.content ?? "");
const NUDGE_SENTENCE = "上下文自上次折叠后增长了";

// Each turn holds ~250 tokens of CJK, so a window of a few turns is comfortably above the
// gate (10% of a 4 000-token floor) while the whole body stays under the floor.
const padding = (n = 8, tag = "") => {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    // Every line is unique: a repeated sentence shares its ref, and #17 makes that ref resolve
    // to the last copy — a range built from it would read backwards.
    const tail = `这一段${tag}背景写下来是为了让第 ${i + 1} 轮有内容可折,只有细节,读完就知道结论。`;
    rows.push({ role: "user", content: `第 ${i + 1} 轮${tag}的问题:${tail}${tail}` });
    rows.push({ role: "assistant", content: `第 ${i + 1} 轮${tag}的回答:${tail}${tail}` });
  }
  return rows;
};

/** A history with room to fold: one settled fold at the head, plenty left to advertise. */
function history() {
  return {
    model: "x",
    messages: [
      { role: "user", content: "需求:讲清楚这个方案。" },
      { role: "assistant", content: "方案讲清楚了。" },
      ...padding(),
      { role: "user", content: "把早期那两轮折掉。" },
      call("c1", "m00001–m00002"),
      ack("c1"),
      { role: "user", content: "继续" },
    ],
  };
}

describe("the epoch: growth moves the numbers, only a fold moves the alarm", () => {
  const base = () => ({
    model: "x",
    messages: [
      { role: "user", content: "需求:讲清楚这个方案。" },
      { role: "assistant", content: "方案讲清楚了。" },
      ...padding(),
      { role: "user", content: "继续" },
    ],
  });

  test("one alert, then silence through 500 more tokens, then exactly one new alert after a fold", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const body = base();

    // The body alone is under the floor: nothing is asked until the provider bills more.
    const first = await onRequest(structuredClone(body), ctx);
    expect(noteOf(first)).not.toContain(NUDGE_SENTENCE);
    expect(stateOf(options).folds.length).toBe(0);

    await onResponse({ usage: { prompt_tokens: 5000, completion_tokens: 2 } }, ctx);
    const asked = await onRequest(structuredClone(body), ctx);
    expect(noteOf(asked)).toMatch(/上下文自上次折叠后增长了 [\d,]{5,} tokens/);
    expect(stateOf(options).nudge.fingerprint).toBe(`hint:${FLOOR}:0`);

    // Answered, so a retry of the same body is a repeat, not a second ask.
    await onResponse({ usage: { prompt_tokens: 5000, completion_tokens: 2 } }, ctx);
    const retry = await onRequest(structuredClone(body), ctx);
    expect(noteOf(retry)).not.toContain(NUDGE_SENTENCE);

    // 500 tokens of further growth without a fold: the numbers moved, the epoch did not.
    await onResponse({ usage: { prompt_tokens: 5500, completion_tokens: 2 } }, ctx);
    const grown = await onRequest(structuredClone(body), ctx);
    expect(noteOf(grown)).not.toContain(NUDGE_SENTENCE);
    expect(stateOf(options).nudge.fingerprint).toBe(`hint:${FLOOR}:0`);

    // A fold over the advertised range settles, and ends the foldable history: nothing is left
    // to point at, so the session is not asked again.
    const { foldableFrom, foldableTo } = stateOf(options).request;
    expect(foldableFrom).toBeTruthy();
    const body1 = structuredClone(body);
    body1.messages.splice(
      body1.messages.length - 1,
      0,
      { role: "user", content: "把窗口里那些轮折掉。" },
      call("c1", `${foldableFrom}–${foldableTo}`),
      ack("c1"),
    );
    const folded = await onRequest(structuredClone(body1), ctx);
    expect(stateOf(options).folds.length).toBe(1);
    // The fold ends the foldable history: what is left is a couple of units, well under the gate,
    // and the offer is built after settlement so it cannot point back at the span just folded.
    // This request is held, not asked — the reason is recorded.
    expect(noteOf(folded)).not.toContain(NUDGE_SENTENCE);
    expect(stateOf(options).request.nudgeHeld?.reason).toBe(NUDGE_SMALL_WINDOW);
    expect(stateOf(options).nudge.fingerprint).toBe(`hint:${FLOOR}:0`);

    // The conversation continues and the context grows again by 18 000 tokens. Under the old
    // fingerprint every one of those steps re-alarmed; here the fold started a new epoch and this
    // is the single alert it buys.
    await onResponse({ usage: { prompt_tokens: 20000, completion_tokens: 2 } }, ctx);
    const body2 = structuredClone(body1);
    body2.messages.push(
      { role: "user", content: "再补充几轮背景。" },
      ...padding(4, "补充"),
      { role: "user", content: "继续" },
    );
    const afterFold = await onRequest(structuredClone(body2), ctx);
    expect(noteOf(afterFold)).toContain(NUDGE_SENTENCE);
    expect(stateOf(options).nudge.fingerprint).toBe(`hint:${FLOOR}:1`);

    // And still silent after the answer: one alert per epoch, not one per request.
    await onResponse({ usage: { prompt_tokens: 20000, completion_tokens: 2 } }, ctx);
    const quiet = await onRequest(structuredClone(body2), ctx);
    expect(noteOf(quiet)).not.toContain(NUDGE_SENTENCE);
  });

  test("unit: the fingerprint is the floor and the fold count, nothing else", () => {
    const cfg = { nudge: { growthFloor: 50000 } };
    const a = decideNudge({ cfg, sinceGrowth: 50000, reclaimable: 20000, contextTokens: 60000 });
    const b = decideNudge({ cfg, sinceGrowth: 50499, reclaimable: 20000, contextTokens: 60000 });
    expect(a.kind).toBe(NUDGE_HINT);
    expect(b.fingerprint).toBe(a.fingerprint);

    const folded = decideNudge({
      cfg,
      sinceGrowth: 50499,
      reclaimable: 20000,
      folds: 1,
      lastNudge: a,
      answeredSince: true,
      contextTokens: 60000,
    });
    expect(folded.repeat).toBe(false);
    expect(folded.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("the minimum-benefit gate: an ask nobody can act on is not made", () => {
  test("nothing foldable in the window: no nudge, and the reason is on the record", async () => {
    // Our own tool traffic is a barrier, so a history made only of it has no window at all.
    const options = opts();
    const ctx = ctxOf(options);
    const body = { model: "x", messages: [call("c0", "m00001–m00002"), ack("c0"), { role: "user", content: "继续" }] };
    await onRequest(structuredClone(body), ctx);
    await onResponse({ usage: { prompt_tokens: 9000, completion_tokens: 2 } }, ctx);
    const out = await onRequest(structuredClone(body), ctx);

    expect(noteOf(out)).not.toContain(NUDGE_SENTENCE);
    expect(stateOf(options).request.nudgeHeld).toMatchObject({ reason: NUDGE_NO_WINDOW, reclaimable: 0 });
    const state = stateOf(options);
    const report = sessionReport({ ...state, key: "e", foldList: state.folds ?? [] }, { growthFloor: FLOOR }).join("\n");
    expect(report).toContain("提醒被压下");
    expect(report).toContain("没有可折的范围");
  });

  test("a window too small to be worth folding: held with both numbers", async () => {
    // The context is huge, so the gate is 1% of it; the window is one short turn.
    const options = opts();
    const ctx = ctxOf(options);
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "一句话。" },
        { role: "assistant", content: "一句回答。" },
        { role: "user", content: "继续" },
      ],
    };
    await onRequest(structuredClone(body), ctx);
    await onResponse({ usage: { prompt_tokens: 100000, completion_tokens: 2 } }, ctx);
    const out = await onRequest(structuredClone(body), ctx);

    expect(noteOf(out)).not.toContain(NUDGE_SENTENCE);
    const held = stateOf(options).request.nudgeHeld;
    expect(held.reason).toBe(NUDGE_SMALL_WINDOW);
    expect(held.minGain).toBe(1000);
    expect(held.reclaimable).toBeGreaterThan(0);
    expect(held.reclaimable).toBeLessThan(held.minGain);
  });

  test("unit: the gate lands on 5 000 at the shipped floor and scales down with it", () => {
    expect(nudgeMinGain({ growthFloor: 50000, contextTokens: 60000 })).toBe(5000);
    expect(nudgeMinGain({ growthFloor: 50000, contextTokens: 900000 })).toBe(9000);
    expect(nudgeMinGain({ growthFloor: 100, contextTokens: 700 })).toBe(10);
    const cfg = { nudge: { growthFloor: 100 } };
    const held = decideNudge({ cfg, sinceGrowth: 700, reclaimable: 9, contextTokens: 700 });
    expect(held.kind).toBe(NUDGE_NONE);
    expect(held.reason).toBe(NUDGE_SMALL_WINDOW);
    expect(decideNudge({ cfg, sinceGrowth: 700, reclaimable: 10, contextTokens: 700 }).kind).toBe(NUDGE_HINT);
  });
});

describe("the alert never moves a byte of the fold", () => {
  test("a nudged request and a held request differ in the nudge sentence and nothing else", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const body = history();

    await onRequest(structuredClone(body), ctx);
    await onResponse({ usage: { prompt_tokens: 5000, completion_tokens: 2 } }, ctx);
    const nudged = await onRequest(structuredClone(body), ctx);
    await onResponse({ usage: { prompt_tokens: 5000, completion_tokens: 2 } }, ctx);
    const held = await onRequest(structuredClone(body), ctx);

    expect(noteOf(nudged)).toContain(NUDGE_SENTENCE);
    expect(noteOf(held)).not.toContain(NUDGE_SENTENCE);

    // The note is the only thing that differs; stamps and fold markers are untouched.
    const withoutNudge = (out) => {
      const copy = structuredClone(out);
      const last = copy.messages[copy.messages.length - 1];
      last.content = String(last.content)
        .split("\n")
        .filter((line) => !line.startsWith("[acp] 上下文自上次折叠后增长了"))
        .join("\n");
      return copy;
    };
    expect(JSON.stringify(withoutNudge(nudged))).toBe(JSON.stringify(withoutNudge(held)));
    expect(JSON.stringify(nudged.messages)).toContain("[acp] m00001–m00002");
  });
});
