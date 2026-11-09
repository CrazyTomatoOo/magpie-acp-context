import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { findBlock } from "../src/blocks.mjs";
import { adapterFor } from "../src/protocol.mjs";
import { elideBlocker, planElide } from "../src/fallback.mjs";
import { scanStore } from "../src/maintenance.mjs";

const filler = (n, tag = "") => `${tag}${"x".repeat(n)}`;
const store = () => mkdtempSync(join(tmpdir(), "acp-elide-"));

/** `full` and a limit small enough that a fixture of a few turns crosses it. */
function opts(over = {}) {
  return {
    enabled: true,
    keepRecentTurns: 1,
    minRangeBytes: 1,
    fallback: "full",
    contextLimit: 4000,
    store: { dir: store() },
    ...over,
  };
}

const ctxOf = (options, extra = {}) => ({ protocol: "chat", origin: "local", session: "elide", options, ...extra });
const request = (options) => scanStore(options.store.dir).sessions[0].request;

/** `turns` finished turns, the fixture`s extra units after turn `at`, then the line being answered. */
function body(turns = 5, { size = 4000, extra = [], at = turns, last = "继续,把结论写出来。" } = {}) {
  const messages = [];
  for (let i = 1; i <= turns; i += 1) {
    messages.push({ role: "user", content: filler(size, `问${i}:`) }, { role: "assistant", content: filler(size, `答${i}:`) });
    if (i === at) messages.push(...extra);
  }
  messages.push({ role: "user", content: last });
  return { model: "x", messages };
}

const textOf = (message) => (typeof message?.content === "string" ? message.content : "");
const statementOf = (out) => out.messages.map(textOf).find((text) => /^\[acp\] 已省略 m\d+–m\d+ 共 \d+ 条/.test(text));
const lastLine = (out) => textOf(out.messages[out.messages.length - 1]);

function spanOf({ from, to }) {
  const first = Number(String(from).slice(1));
  const last = Number(String(to).slice(1));
  return Array.from({ length: last - first + 1 }, (_, i) => `m${String(first + i).padStart(5, "0")}`);
}

const COMPRESS_CALL = (range, id = "c1") => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "compress", arguments: JSON.stringify({ content: `${range} 早期需求\n这段是早期需求,已经做完,用来说明范围的用法。` }) } }],
});
const ACK = (id = "c1") => ({ role: "tool", tool_call_id: id, content: "解析到 1 段;折叠会在下一次请求时按历史里真实的 ref 结算(本工具不写历史)" });

describe("elide: the oldest whole turns leave a known-over request", () => {
  test("the turns go, the statement names them in history order, and every ref comes back", async () => {
    const options = opts();
    const input = body();
    const out = await onRequest(structuredClone(input), ctxOf(options));
    const rec = request(options);

    expect(rec.overLimit).toBe(true);
    expect(rec.limit).toBe(4000);
    expect(rec.elided).not.toBeNull();
    expect(rec.elided.from).toBe("m00001");
    expect(Number(rec.elided.to.slice(1))).toBeGreaterThan(Number(rec.elided.from.slice(1)));
    expect(rec.elided.turns).toBeGreaterThan(0);
    expect(out.messages.length).toBe(input.messages.length - rec.elided.count + 1);

    const statement = statementOf(out);
    expect(statement).toBeDefined();
    expect(statement).toContain(`${rec.elided.from}–${rec.elided.to}`);
    expect(statement).toContain(`共 ${rec.elided.count} 条`);
    // mechanical, and honest about it: no summary, and the way back is named
    expect(statement).toContain("机械省略,没有摘要");
    expect(statement).toContain("decompress");

    for (const ref of spanOf(rec.elided)) {
      const block = findBlock(options.store.dir, ref);
      expect(block).not.toBeNull();
      expect(block.ref).toBe(ref);
      expect(block.text.length).toBeGreaterThan(4000);
      expect(block.text).toMatch(/^[问答]\d:/);
    }
  });

  test("nothing moves under the ratio, and nothing moves when no limit is known", async () => {
    const input = body();
    const off = await onRequest(structuredClone(input), ctxOf(opts({ fallback: "cap" })));
    const under = await onRequest(structuredClone(input), ctxOf(opts({ contextLimit: 1000000 })));
    const unknown = await onRequest(structuredClone(input), ctxOf(opts({ contextLimit: 0 })));

    expect(JSON.stringify(under)).toBe(JSON.stringify(off));
    expect(JSON.stringify(unknown)).toBe(JSON.stringify(off));
  });

  test("the same history elided twice is the same bytes", async () => {
    const options = opts();
    const input = body();
    const first = await onRequest(structuredClone(input), ctxOf(options));
    const second = await onRequest(structuredClone(input), ctxOf(options));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(scanStore(options.store.dir).sessions[0].elisions.length).toBe(1);
  });
});

describe("elide: three passes that stay over say it once", () => {
  test("the new-session line lands on the third pass and not again", async () => {
    const options = opts();
    // The turn being answered is too big to drop, so eliding everything elidable still leaves
    // the request over the ratio.
    const input = body(5, { last: `继续,这段必须留下:${filler(40000)}` });
    const pass = async () => {
      const out = await onRequest(structuredClone(input), ctxOf(options));
      return { out, rec: request(options) };
    };

    const first = await pass();
    expect(first.rec.overLimit).toBe(true);
    expect(first.rec.elided).not.toBeNull();
    expect(first.rec.elideStreak).toBe(1);
    expect(first.rec.newSession).toBe(false);
    expect(lastLine(first.out)).not.toContain("请开一个新会话");

    await pass();
    const third = await pass();
    expect(third.rec.elideStreak).toBe(3);
    expect(third.rec.newSession).toBe(true);
    expect(lastLine(third.out)).toContain("请开一个新会话");
    expect(lastLine(third.out).split("请开一个新会话").length - 1).toBe(1);

    const fourth = await pass();
    expect(fourth.rec.elideStreak).toBe(4);
    expect(fourth.rec.newSession).toBe(false);
    expect(lastLine(fourth.out)).not.toContain("请开一个新会话");
  });

  test("a real fold answers the same pressure and starts the count over", async () => {
    const options = opts();
    // The same history, first with nobody folding, then with a call that folds the first turns.
    const tail = { role: "user", content: `继续,这段必须留下:${filler(40000)}` };
    const plain = body(5, { last: tail.content });
    const folded = body(5, {
      extra: [{ role: "user", content: "把最前面那几轮折掉。" }, COMPRESS_CALL("m00001–m00004"), ACK()],
      last: tail.content,
    });

    await onRequest(structuredClone(plain), ctxOf(options));
    expect(request(options).overLimit).toBe(true);
    expect(request(options).elideStreak).toBe(1);
    expect(scanStore(options.store.dir).sessions[0].elide).not.toBeNull();

    const out = await onRequest(structuredClone(folded), ctxOf(options));
    expect(request(options).applied).toBeGreaterThan(0);
    expect(request(options).elided).toBeNull();
    expect(request(options).elideStreak).toBe(0);
    expect(scanStore(options.store.dir).sessions[0].elide).toBeNull();
    expect(lastLine(out)).not.toContain("请开一个新会话");
  });
});

describe("elide: the barriers hold in this leg too", () => {
  test("a media turn ends the sweep and is never dropped", async () => {
    const options = opts();
    const media = {
      role: "user",
      content: [
        { type: "text", text: "看一下这张图。" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    };
    const input = body(5, { extra: [media], at: 2 });
    const out = await onRequest(structuredClone(input), ctxOf(options));
    const rec = request(options);

    // the window is trimmed past the newest barrier, so nothing above the media
    // unit can leave: the sweep starts after it instead of crossing it.
    expect(rec.elided).not.toBeNull();
    expect(Number(rec.elided.from.slice(1))).toBeGreaterThan(4);
    const kept = out.messages.filter((m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url"));
    expect(kept.length).toBe(1);
  });

  test("the plugin's own record ends the sweep", async () => {
    const options = opts();
    const input = body(5, { extra: [COMPRESS_CALL("m00002–m00001"), ACK()], at: 2 });
    const out = await onRequest(structuredClone(input), ctxOf(options));
    const rec = request(options);

    expect(rec.elided).not.toBeNull();
    // same rule for our own record: the sweep begins past it, never across it
    expect(Number(rec.elided.from.slice(1))).toBeGreaterThan(5);
    const wire = out.messages.map(textOf).join("\n");
    expect(wire).toContain("折叠会在下一次请求时按历史里真实的 ref 结算");
    expect(wire).toContain("问1:");
    expect(wire).toContain("答2:");
  });

  test("a statement already on the wire is not elided again", async () => {
    const options = opts();
    const already = { role: "user", content: "[acp] 已省略 m00001–m00004 共 4 条(机械省略,没有摘要;每条原文都存着,可用 decompress 按 ref 取回)" };
    const input = body(5, { extra: [already], at: 2 });
    const out = await onRequest(structuredClone(input), ctxOf(options));
    const rec = request(options);

    expect(rec.elided).not.toBeNull();
    expect(rec.elided.to).toBe("m00004");
    // a client resends a statement stamped, so the count has to tolerate the stamp
    const statements = out.messages.map(textOf).filter((text) => /^(\[m\d+\] )?\[acp\] 已省略/.test(text));
    expect(statements.length).toBe(2);
  });
});

describe("elide: the sweep itself refuses to cross a barrier", () => {
  /** The hook trims the window past the newest barrier, so the sweep keeps its own guard for callers that do not. */
  const unitsOf = (messages) => adapterFor("chat").read({ model: "x", messages });
  const turnsOf = (units) => units.map((unit, i) => (unit.role === "user" ? i : -1)).filter((i) => i >= 0);

  test("a media unit stops the walk where it stands", () => {
    const units = unitsOf([
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
    ]);
    expect(elideBlocker(units[2])).toBe("媒体单元");
    const plan = planElide({ units, turns: turnsOf(units), from: 0, to: 4, tokens: 9000, target: 0 });
    expect(plan.to).toBe(1);
  });

  test("our own record stops the walk the same way", () => {
    const units = unitsOf([
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
      COMPRESS_CALL("m00002–m00001"),
      ACK(),
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
    ]);
    const at = units.findIndex((unit) => unit.role === "assistant" && unit.toolCalls?.length);
    expect(elideBlocker(units[at])).toBe("本插件自己的记录");
    // turn 1 goes, the turn holding the record is where the walk stops
    expect(planElide({ units, turns: turnsOf(units), from: 0, to: units.length - 1, tokens: 20000, target: 0 }).to).toBe(1);
  });

  test("a statement already on the wire is a barrier too", () => {
    const units = unitsOf([
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
      { role: "user", content: "[acp] 已省略 m00001–m00002 共 2 条(机械省略)" },
      { role: "user", content: filler(4000) },
      { role: "assistant", content: filler(4000) },
    ]);
    expect(elideBlocker(units[2])).toBe("已经是 [acp] 标记");
    expect(planElide({ units, turns: turnsOf(units), from: 0, to: 4, tokens: 9000, target: 0 }).to).toBe(1);
  });
});
