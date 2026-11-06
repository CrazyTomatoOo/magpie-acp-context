import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideNudge, nudgeText, NUDGE_EMERGENCY, NUDGE_HINT, NUDGE_NONE } from "../src/nudge.mjs";
import { estimateTokens, readUsage } from "../src/usage.mjs";
import { cleanup } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { onRequest, onResponse } from "../hooks.mjs";
import acpTools from "../tools.mjs";

const store = () => mkdtempSync(join(tmpdir(), "acp-m2-"));
const cfgOf = (over = {}) => loadConfig({ enabled: true, ...over });

const chat = (n) => ({
  model: "x",
  messages: [
    { role: "user", content: "请把这个仓库的上下文压缩方案讲清楚。" },
    { role: "assistant", content: "讲清楚了。" },
    { role: "user", content: "再补充一些细节。".repeat(n) },
  ],
});

describe("usage", () => {
  test("reads each API's own shape", () => {
    expect(readUsage({ usage: { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }, "chat")).toEqual({
      input: 11,
      output: 2,
      cacheRead: 5,
      cacheWrite: 0,
    });
    expect(
      readUsage({ usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } }, "anthropic"),
    ).toEqual({ input: 9, output: 1, cacheRead: 4, cacheWrite: 2 });
    expect(readUsage({ usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 1 } } }, "responses")).toEqual({
      input: 7,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
    });
    expect(
      readUsage({ usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 4, cachedContentTokenCount: 8 } }, "gemini"),
    ).toEqual({ input: 21, output: 4, cacheRead: 8, cacheWrite: 0 });
  });

  test("a reply with no usage is null, not a zero bill", () => {
    expect(readUsage({ choices: [{ message: { content: "hi" } }] }, "chat")).toBeNull();
    expect(readUsage(null, "chat")).toBeNull();
  });

  test("estimates wide characters as roughly a token each", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("压缩")).toBe(2);
    expect(estimateTokens("ab压缩")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("nudge", () => {
  const cfg = cfgOf({ nudge: { windowTokens: 1000, minContextPct: 0.45, growthFloor: 100, growthRatio: 0.1, emergencyPct: 0.95 } });

  test("quiet below the floor", () => {
    expect(decideNudge({ cfg, contextTokens: 100 }).kind).toBe(NUDGE_NONE);
  });

  test("quiet when it is over the floor but has not grown", () => {
    const d = decideNudge({ cfg, contextTokens: 600, sinceGrowth: 50 });
    expect(d.kind).toBe(NUDGE_NONE);
  });

  test("a hint once the floor and the growth are both passed", () => {
    const d = decideNudge({ cfg, contextTokens: 700, sinceGrowth: 600 });
    expect(d.kind).toBe(NUDGE_HINT);
    expect(nudgeText({ ...d, range: "m00001–m00004" }, cfg)).toContain("上下文已用到 70%");
  });

  test("emergency near the window", () => {
    expect(decideNudge({ cfg, contextTokens: 990 }).kind).toBe(NUDGE_EMERGENCY);
  });

  test("a retry is suppressed only once the last nudge was answered", () => {
    const first = decideNudge({ cfg, contextTokens: 700, sinceGrowth: 600 });
    expect(first.repeat).toBe(false);
    const retry = decideNudge({ cfg, contextTokens: 700, sinceGrowth: 600, lastNudge: first, answeredSince: false });
    expect(retry.repeat).toBe(false);
    const late = decideNudge({ cfg, contextTokens: 700, sinceGrowth: 600, lastNudge: first, answeredSince: true });
    expect(late.repeat).toBe(true);
  });
});

describe("onResponse", () => {
  test("records the billed prompt of the reply into the session ledger", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir } };
    await onRequest(structuredClone(chat(2)), {
      protocol: "chat",
      origin: "local", session: "s1", options });
    await onResponse(
      { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 4321, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 4000 } } },
      {
      protocol: "chat",
      origin: "local", session: "s1", model: "x", options },
    );
    const state = JSON.parse(readFileSync(join(dir, "sessions", "s1.json"), "utf8"));
    expect(state.usage.at(-1)).toMatchObject({ input: 4321, output: 12, cacheRead: 4000 });
  });

  test("the nudge decides on the billed number, not on the estimate", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir }, nudge: { windowTokens: 1000, minContextPct: 0.45, growthFloor: 100, growthRatio: 0.1, emergencyPct: 0.95 } };
    const body = chat(1);
    await onRequest(structuredClone(body), {
      protocol: "chat",
      origin: "local", session: "s2", options });
    expect((await onRequest(structuredClone(body), {
      protocol: "chat",
      origin: "local", session: "s2", options })).messages.at(-1).content).not.toContain("上下文已用到");

    // the provider says this history is 700 tokens: now the same body is over the floor
    await onResponse({ usage: { prompt_tokens: 700, completion_tokens: 3 } }, {
      protocol: "chat",
      origin: "local", session: "s2", options });
    const next = await onRequest(structuredClone(body), {
      protocol: "chat",
      origin: "local", session: "s2", options });
    expect(next.messages.at(-1).content).toContain("上下文已用到 70%");

    // that nudge was delivered: its reply landed, so the same body again is a repeat
    await onResponse({ usage: { prompt_tokens: 700, completion_tokens: 3 } }, {
      protocol: "chat",
      origin: "local", session: "s2", options });
    const again = await onRequest(structuredClone(body), {
      protocol: "chat",
      origin: "local", session: "s2", options });
    expect(again.messages.at(-1).content).not.toContain("上下文已用到");
  });
});

describe("eviction", () => {
  test("drops the oldest block and marks the fold that held it", () => {
    const dir = store();
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    for (const [id, text] of [
      ["a".repeat(16), "old ".repeat(200)],
      ["b".repeat(16), "new ".repeat(200)],
    ]) {
      writeFileSync(join(dir, "blocks", `${id}.json`), JSON.stringify({ blockId: id, text, at: 0 }));
    }
    writeFileSync(
      join(dir, "sessions", "s1.json"),
      JSON.stringify({ v: 1, next: 3, refs: {}, folds: [{ id: "f1", blocks: ["a".repeat(16)], startBlock: "a".repeat(16), endBlock: "a".repeat(16) }] }),
    );

    const done = cleanup(dir, { maxBytes: 300 });
    expect(done.removed).toBe(2);
    expect(readdirSync(join(dir, "blocks"))).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(dir, "sessions", "s1.json"), "utf8"));
    expect(state.folds[0].evictedAt).toBeGreaterThan(0);
  });

  test("keeps blocks inside the budget and younger than the TTL", () => {
    const dir = store();
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(join(dir, "blocks", `${"c".repeat(16)}.json`), JSON.stringify({ text: "keep" }));
    expect(cleanup(dir, { maxBytes: 100000, ttlDays: 30 }).removed).toBe(0);
  });
});

describe("acp_status", () => {
  test("reports the store, the session and the billed tokens", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir } };
    await onRequest(structuredClone(chat(2)), {
      protocol: "chat",
      origin: "local", session: "s9", options });
    await onResponse({ usage: { prompt_tokens: 1234, completion_tokens: 5 } }, {
      protocol: "chat",
      origin: "local", session: "s9", options });

    const tool = (await acpTools({ directory: "/tmp" }, options)).tool.acp_status;
    const out = await tool.execute({ session: "s9" });
    expect(out).toContain("s9");
    expect(out).toContain("计费 prompt=1,234 tok");
    expect(out).toContain("窗口按 200,000 tokens 计");
  });
});
