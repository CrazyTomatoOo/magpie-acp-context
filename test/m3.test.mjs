import { describe, expect, test } from "bun:test";
import { COMPRESS_ACK } from "../src/compress.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { onRequest, onResponse } from "../hooks.mjs";
import { openSession } from "../src/store.mjs";
import { forget, reconcile, renderStatus, scanStore, unlock } from "../src/maintenance.mjs";

const store = () => mkdtempSync(join(tmpdir(), "acp-m3-"));
const NL = "\n";

function chatHistory({ padded = 4000, extra = "" } = {}) {
  return {
    model: "x",
    messages: [
      { role: "user", content: "把这个仓库的压缩方案讲清楚。" },
      { role: "assistant", content: "讲清楚了。" },
      { role: "user", content: "再补充细节。" + "y".repeat(padded) + extra },
    ],
  };
}

function withCompressCall(body) {
  // The model made a compress call covering m00001–m00002; the client executed it.
  body.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "compress", arguments: JSON.stringify({ content: "m00001–m00002 需求\n用户要一份压缩方案说明,包含阈值、风险和回滚方式,细节不需要原文。" }) },
      },
    ],
  });
  body.messages.push({ role: "tool", tool_call_id: "c1", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` });
  body.messages.push({ role: "user", content: "继续" });
  return body;
}

describe("usage dedupe", () => {
  test("a duplicate callback for one request is dropped", () => {
    const dir = store();
    const s = openSession(dir, "k1");
    s.recordRequest({ at: 1, tokens: 10 });
    expect(s.recordUsage({ seq: 1, at: 5, input: 700 })).toBe(true);
    expect(s.recordUsage({ seq: 1, at: 5, input: 700 })).toBe(false);
    expect(s.state.usage).toHaveLength(1);
  });

  test("two requests billing identical numbers are both kept", () => {
    const dir = store();
    const s = openSession(dir, "k2");
    s.recordRequest({ at: 1, tokens: 10 });
    s.recordUsage({ seq: 1, at: 5, input: 700 });
    s.recordRequest({ at: 6, tokens: 10 });
    expect(s.recordUsage({ seq: 2, at: 6, input: 700 })).toBe(true);
    expect(s.state.usage).toHaveLength(2);
  });

  test("onResponse records against the request sequence of the turn", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir } };
    const body = chatHistory();
    await onRequest(structuredClone(body), {
      protocol: "chat",
      origin: "local", session: "s1", options });
    await onResponse({ usage: { prompt_tokens: 900 } }, {
      protocol: "chat",
      origin: "local", session: "s1", options });
    // same request, second callback: one sample, not two
    await onResponse({ usage: { prompt_tokens: 900 } }, {
      protocol: "chat",
      origin: "local", session: "s1", options });
    const state = JSON.parse(readFileSync(join(dir, "sessions", "s1.json"), "utf8"));
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0].seq).toBe(1);
  });
});

describe("client compaction", () => {
  test("a fold whose anchors left the history is dropped, not rendered", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir }, minRangeBytes: 10 };
    const first = withCompressCall(chatHistory());
    const shown = await onRequest(structuredClone(first), {
      protocol: "chat",
      origin: "local", session: "c", options });
    expect(shown.messages.some((m) => typeof m.content === "string" && m.content.includes("[acp] m"))).toBe(true);

    // The client compacted: the two folded turns are gone, replaced by its own summary.
    const compacted = {
      model: "x",
      messages: [
        { role: "user", content: "（客户端压缩)用户要一份压缩方案说明,包含阈值、风险和回滚方式,细节不需要原文。" },
        { role: "user", content: "继续" },
      ],
    };
    const after = await onRequest(structuredClone(compacted), {
      protocol: "chat",
      origin: "local", session: "c", options });
    expect(after.messages.some((m) => typeof m.content === "string" && m.content.includes("[acp] m"))).toBe(false);
    expect(after.messages).toHaveLength(2);
  });

  test("the same content keeps its ref across a rewritten history; new content never reuses one", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir } };
    const once = await onRequest(structuredClone(chatHistory()), {
      protocol: "chat",
      origin: "local", session: "r", options });
    const refA = /^\[(m\d{5})\]/.exec(once.messages[0].content)?.[1];
    expect(refA).toBe("m00001");

    // Compaction rewrote the prefix but kept the first message verbatim.
    const rewritten = chatHistory({ padded: 10 });
    const twice = await onRequest(structuredClone(rewritten), {
      protocol: "chat",
      origin: "local", session: "r", options });
    expect(/^\[(m\d{5})\]/.exec(twice.messages[0].content)?.[1]).toBe(refA);

    // Different content gets a fresh ref, never the dead one.
    const changed = chatHistory({ padded: 10, extra: "完全不同的内容" });
    const third = await onRequest(structuredClone(changed), {
      protocol: "chat",
      origin: "local", session: "r", options });
    const refC = /^\[(m\d{5})\]/.exec(third.messages[2].content)?.[1];
    expect(refC).not.toBe("m00003");
    const state = JSON.parse(readFileSync(join(dir, "sessions", "r.json"), "utf8"));
    const byRef = Object.fromEntries(Object.entries(state.refs).map(([id, ref]) => [ref, id]));
    expect(new Set(Object.values(state.refs)).size).toBe(Object.values(state.refs).length);
    expect(byRef[refC]).toBeDefined();
  });
});

describe("reconcile", () => {
  test("marks a fold whose original vanished and reports it without writing on a dry run", () => {
    const dir = store();
    const s = openSession(dir, "k1");
    s.recordFolds([{ id: "f1", blocks: ["missingblock00001"], startBlock: "missingblock00001", endBlock: "missingblock00001" }], () => {});
    s.save();

    const dry = reconcile(dir, {});
    expect(dry.missingOriginals).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "sessions", "k1.json"), "utf8")).folds[0].evictedAt).toBeUndefined();

    const applied = reconcile(dir, { apply: true });
    expect(applied.missingOriginals).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "sessions", "k1.json"), "utf8")).folds[0].evictedAt).toBeGreaterThan(0);
  });

  test("an orphan block is only removed with --apply", () => {
    const dir = store();
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(join(dir, "blocks", `${"0".repeat(16)}.json`), JSON.stringify({ text: "nobody points here" }));

    expect(reconcile(dir, {}).orphanBlocks).toBe(1);
    expect(existsSync(join(dir, "blocks", `${"0".repeat(16)}.json`))).toBe(true);

    expect(reconcile(dir, { apply: true }).removedBlocks).toBe(1);
    expect(existsSync(join(dir, "blocks", `${"0".repeat(16)}.json`))).toBe(false);
  });

  test("an idle session loses its unused refs but keeps its folds", () => {
    const dir = store();
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "blocks", "aaaa000000000000.json"), JSON.stringify({ text: "kept" }));
    writeFileSync(
      join(dir, "sessions", "old.json"),
      JSON.stringify({ v: 1, next: 3, refs: { aaaa000000000000: "m00001", bbbb000000000000: "m00002" }, folds: [{ id: "f", blocks: ["aaaa000000000000"] }], request: { at: 1 } }),
    );

    const done = reconcile(dir, { apply: true, ttlDays: 1, now: 10 * 86400000 });
    expect(done.deadSessions).toBe(1);
    const state = JSON.parse(readFileSync(join(dir, "sessions", "old.json"), "utf8"));
    expect(Object.keys(state.refs)).toEqual(["aaaa000000000000"]);
    expect(state.folds).toHaveLength(1);
  });
});

describe("forget and unlock", () => {
  test("forget deletes the original and marks the fold that needed it", () => {
    const dir = store();
    const s = openSession(dir, "k1");
    s.storeOriginal("cccc000000000000", { blockId: "cccc000000000000", ref: "m00001", text: "原文" });
    s.recordFolds([{ id: "f", blocks: ["cccc000000000000"] }], () => {});
    s.save();

    const done = forget(dir, ["cccc000000000000"]);
    expect(done.removed).toEqual(["cccc000000000000"]);
    expect(done.markedFolds).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "sessions", "k1.json"), "utf8")).folds[0].evictedAt).toBeGreaterThan(0);
  });

  test("unlock removes a lock a killed hook left behind", () => {
    const dir = store();
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "k1.lock"), "");
    expect(unlock(dir).removed).toBe(1);
    expect(readdirSync(join(dir, "sessions"))).not.toContain("k1.lock");
  });
});

describe("cli", () => {
  const run = (args, dir) => spawnSync(process.execPath, [join(import.meta.dir, "..", "cli.mjs"), ...args, "--store", dir], { encoding: "utf8" });

  test("status --json reports the store it read", () => {
    const dir = store();
    const s = openSession(dir, "cli1");
    s.recordRequest({ at: 1, tokens: 1234, folds: 1 });
    s.recordUsage({ seq: 1, at: 2, input: 1234 });
    s.save();

    const out = run(["status", "--json"], dir);
    expect(out.status).toBe(0);
    const scan = JSON.parse(out.stdout);
    expect(scan.storeDir).toBe(dir);
    expect(scan.sessions[0].key).toBe("cli1");
    expect(scan.sessions[0].lastUsage.input).toBe(1234);
  });

  test("status prints the same line the agent sees", () => {
    const dir = store();
    const s = openSession(dir, "cli2");
    s.recordRequest({ at: 1, tokens: 500 });
    s.save();
    const out = run(["status"], dir);
    expect(out.stdout).toContain("store ");
    expect(out.stdout).toContain("cli2");
  });

  test("forget refuses without --yes and deletes with it", () => {
    const dir = store();
    const s = openSession(dir, "cli3");
    s.storeOriginal("dddd000000000000", { blockId: "dddd000000000000", ref: "m00007", text: "要删掉的原文" });
    s.save();

    expect(run(["forget", "m00007"], dir).stdout).toContain("--yes");
    expect(existsSync(join(dir, "blocks", "dddd000000000000.json"))).toBe(true);

    expect(run(["forget", "m00007", "--yes"], dir).status).toBe(0);
    expect(existsSync(join(dir, "blocks", "dddd000000000000.json"))).toBe(false);
  });

  test("reconcile --json is a dry run unless --apply is passed", () => {
    const dir = store();
    mkdirSync(join(dir, "blocks"), { recursive: true });
    writeFileSync(join(dir, "blocks", `${"e".repeat(16)}.json`), "{}");
    const dry = JSON.parse(run(["reconcile", "--json"], dir).stdout);
    expect(dry.orphanBlocks).toBe(1);
    expect(existsSync(join(dir, "blocks", `${"e".repeat(16)}.json`))).toBe(true);

    const applied = JSON.parse(run(["reconcile", "--json", "--apply"], dir).stdout);
    expect(applied.removedBlocks).toBe(1);
  });
});

describe("renderStatus", () => {
  test("says so when the store has never been used", () => {
    const dir = store();
    expect(renderStatus(scanStore(dir))).toContain("还没有会话记录");
  });
});

describe("a refused turn", () => {
  const ctx = (dir, extra = {}) => ({ protocol: "chat", origin: "local", session: "s1", options: { enabled: true, store: { dir } }, ...extra });

  // A session already bigger than its window never reaches the model, so it can never fold its
  // way out: the refusal is the only evidence, and it has to be said out loud (omp 2026-11-07,
  // 1.28M tokens, 400 at the provider, zero folds, nothing in acp_status to explain it).
  test("is recorded and says the host has to compact first", async () => {
    const dir = store();
    await onRequest(chatHistory(), ctx(dir));
    await onResponse({ error: { message: "Input exceeds the context limit (1048570 tokens). Please shorten the input." } }, ctx(dir, { success: false }));
    const status = renderStatus(scanStore(dir));
    expect(status).toContain("上游拒绝了上一次请求");
    expect(status).toContain("1,048,570");
    expect(status).toContain("先在宿主里压缩一次");
  });

  test("a failed turn with no body says what is known and what it would mean", async () => {
    const dir = store();
    await onRequest(chatHistory(), ctx(dir));
    await onResponse(null, ctx(dir, { success: false }));
    const status = renderStatus(scanStore(dir));
    expect(status).toContain("没有附带原因");
    expect(status).toContain("先在宿主里压缩一次");
  });

  test("does not blame the window for a refusal that is not about size", async () => {
    const dir = store();
    await onRequest(chatHistory(), ctx(dir));
    await onResponse({ error: { message: "Service is too busy" } }, ctx(dir, { success: false }));
    const status = renderStatus(scanStore(dir));
    expect(status).toContain("Service is too busy");
    expect(status).not.toContain("先在宿主里压缩一次");
  });

  test("clears once a reply lands, and the note stops mentioning it", async () => {
    const dir = store();
    await onRequest(chatHistory(), ctx(dir));
    await onResponse({ error: { message: "Input exceeds the context limit (1048570 tokens)" } }, ctx(dir, { success: false }));
    const warned = await onRequest(chatHistory(), ctx(dir));
    expect(JSON.stringify(warned.messages)).toContain("先在宿主里压缩一次");

    await onResponse({ usage: { prompt_tokens: 900, completion_tokens: 5 } }, ctx(dir));
    expect(renderStatus(scanStore(dir))).not.toContain("上游拒绝了上一次请求");
    const after = await onRequest(chatHistory(), ctx(dir));
    expect(JSON.stringify(after.messages)).not.toContain("先在宿主里压缩一次");
  });
});
