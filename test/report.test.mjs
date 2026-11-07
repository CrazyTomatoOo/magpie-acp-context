import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { foldStats, renderSkips, renderStatus, reportData, sessionReport } from "../src/report.mjs";
import { scanStore } from "../src/maintenance.mjs";
import { recordSkip, scanSkips } from "../src/skips.mjs";
import { openSession } from "../src/store.mjs";

const store = () => mkdtempSync(join(tmpdir(), "acp-report-"));

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function writeSession(dir, key, state) {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "sessions", `${key}.json`), JSON.stringify(state), "utf8");
}

function seeded(dir, key = "s1") {
  writeSession(dir, key, {
    v: 1,
    next: 40,
    refs: { b1: "m00001", b2: "m00002", b3: "m00003", b4: "m00040" },
    folds: [
      {
        id: "fold-aaaa",
        startRef: "m00001",
        endRef: "m00002",
        topic: "需求与方案",
        summary: "x".repeat(800),
        summaryBytes: 800,
        at: NOW - 3600_000,
        bytes: 160_000,
        blocks: [{ blockId: "b1", ref: "m00001" }, { blockId: "b2", ref: "m00002" }],
      },
      {
        id: "fold-bbbb",
        startRef: "m00003",
        endRef: "m00003",
        topic: "旧文档",
        summary: "y".repeat(120),
        summaryBytes: 120,
        at: NOW - 60_000,
        bytes: 9_000,
        evictedAt: NOW - 30_000,
        blocks: [{ blockId: "b3", ref: "m00003" }],
      },
    ],
    usage: [{ seq: 1, at: NOW, input: 61_204, cacheRead: 4096 }, { seq: 2, at: NOW, input: 37_522, cacheRead: 17_152 }],
    turns: [
      { seq: 1, at: NOW - 120_000, units: 30, bytes: 200_000, tokens: 61_204, billed: 61_204, folds: 1, applied: 1 },
      {
        seq: 2,
        at: NOW,
        units: 39,
        bytes: 330_911,
        tokens: 88_802,
        billed: 37_522,
        folds: 2,
        applied: 1,
        foldableFrom: "m00023",
        foldableTo: "m00037",
        rejected: ["m00005–m00009:这段只有 1,200 字节,低于 minRangeBytes=5000"],
        unresolved: ["m00099–m00100"],
        foreign: 1,
      },
    ],
    request: {
      seq: 2,
      at: NOW,
      protocol: "chat",
      model: "volcengine-apigw/deepseek-v4.1-flash",
      units: 39,
      bytes: 330_911,
      tokens: 88_802,
      billed: 37_522,
      folds: 2,
      applied: 1,
      foldableFrom: "m00023",
      foldableTo: "m00037",
      rejected: ["m00005–m00009:这段只有 1,200 字节,低于 minRangeBytes=5000"],
      unresolved: ["m00099–m00100"],
      foreign: 1,
    },
    nudge: { kind: "hint", fingerprint: "hint:50000:171:0", at: NOW, tokens: 85_538, usageCount: 1 },
    refusal: null,
  });
}

describe("fold accounting", () => {
  test("savings are the original minus the summary, and evicted folds are counted apart", () => {
    const stats = foldStats([
      { bytes: 10_000, summaryBytes: 500, blocks: [{ ref: "m00001" }, { ref: "m00002" }] },
      { bytes: 4_000, summaryBytes: 200, evictedAt: 1, blocks: [{ ref: "m00002" }, { ref: "m00003" }] },
    ]);
    expect(stats.originalBytes).toBe(14_000);
    expect(stats.summaryBytes).toBe(700);
    expect(stats.savedBytes).toBe(13_300);
    expect(stats.savedTokens).toBe(Math.round(13_300 / 3.5));
    expect(stats.coveredRefs.size).toBe(3);
    expect(stats.evicted).toBe(1);
  });
});

describe("sessionReport", () => {
  test("shows the request, the ledger, the fold table, the trend and the growth direction", () => {
    const scan = scanStore(seededDir());
    const lines = sessionReport(scan.sessions[0], { now: NOW }).join("\n");
    expect(lines).toContain("refs=4");
    expect(lines).toContain("folds=2");
    expect(lines).toContain("evicted=1");
    expect(lines).toContain("chat · volcengine-apigw/deepseek-v4.1-flash");
    expect(lines).toContain("units=39");
    expect(lines).toContain("缓存命中 17,152");
    expect(lines).toContain("走势:上下文 61,204 → 88,802(+27,598)");
    expect(lines).toContain("覆盖 3/4 条 ref(75%)");
    expect(lines).toContain("m00001–m00002 「需求与方案」 160,000 → 800 字节(-100%)");
    expect(lines).toContain("原文已淘汰");
    expect(lines).toContain("本轮渲染 1 个折叠");
    expect(lines).toContain("可折窗口 m00023–m00037");
    // 2 folds, 1 rendered, 1 evicted -> 0 dormant; the evicted one is not "dormant".
    expect(lines).not.toContain("失锚");
  });

  test("says why the last fold did not take effect instead of looking like a choice", () => {
    const scan = scanStore(seededDir());
    const lines = sessionReport(scan.sessions[0], { now: NOW }).join("\n");
    expect(lines).toContain("上次折叠没生效:m00005–m00009");
    expect(lines).toContain("引用了本插件没发过的 ref:m00099–m00100");
    expect(lines).toContain("另有 1 个 compress 调用来自别的压缩器");
  });

  test("counts a fold whose anchors left the history as dormant, neither live nor evicted", () => {
    const dir = seededDir();
    const state = JSON.parse(readFileSync(join(dir, "sessions", "s1.json"), "utf8"));
    state.folds.push({ id: "fold-cccc", startRef: "m00030", endRef: "m00031", bytes: 5000, summaryBytes: 100, summary: "z".repeat(100), blocks: [{ blockId: "bx", ref: "m00030" }] });
    writeSession(dir, "s1", state);
    const out = sessionReport(scanStore(dir).sessions[0], { now: NOW }).join("\n");
    expect(out).toContain("另有 1 个失锚");
  });

  test("an empty session says nothing was folded yet and never invents a table", () => {
    const dir = store();
    writeSession(dir, "empty", { v: 1, next: 1, refs: {}, folds: [], usage: [], request: null });
    const out = sessionReport(scanStore(dir).sessions[0], { now: NOW }).join("\n");
    expect(out).toContain("refs=0");
    expect(out).not.toContain("折叠明细");
  });
});

describe("skips", () => {
  test("the same gate twice in a row is one row with a count", () => {
    const dir = store();
    recordSkip(dir, "s1", { at: NOW - 1000, reason: "工具门:声明的工具没有一个能到本插件", detail: "task_done,code_search" });
    recordSkip(dir, "s1", { at: NOW, reason: "工具门:声明的工具没有一个能到本插件", detail: "task_done,code_search" });
    const skips = scanSkips(dir);
    expect(skips).toHaveLength(1);
    expect(skips[0].count).toBe(2);
    expect(renderSkips(skips, { now: NOW }).join("\n")).toContain("×2");
  });

  test("the ring is bounded and a broken file is a missing one", () => {
    const dir = store();
    for (let i = 0; i < 30; i += 1) recordSkip(dir, "s1", { at: NOW + i, reason: `r${i}`, detail: "" });
    expect(scanSkips(dir)).toHaveLength(20);
    mkdirSync(join(dir, "skips"), { recursive: true });
    writeFileSync(join(dir, "skips", "bad.json"), "{not json", "utf8");
    expect(() => scanSkips(dir)).not.toThrow();
    expect(scanSkips(dir).length).toBe(20);
  });

  test("status prints the gate that skipped a request, because silence is the hard part", () => {
    const dir = seededDir();
    recordSkip(dir, "s1", { at: NOW, reason: "工具门:声明的工具没有一个能到本插件", detail: "task_done" });
    const out = renderStatus(scanStore(dir), { now: NOW });
    expect(out).toContain("最近被跳过");
    expect(out).toContain("工具门");
  });
});

describe("reportData", () => {
  test("is the same numbers in a shape a script can read", () => {
    const scan = scanStore(seededDir());
    const data = reportData({ ...scan, sessions: scan.sessions.slice(0, 1) }, { now: NOW });
    const s = data.sessions[0];
    expect(s.key).toBe("s1");
    expect(s.billedPromptTokens).toBe(37_522);
    expect(s.coverage.coveredRefs).toBe(3);
    expect(s.foldList).toHaveLength(2);
    expect(s.foldList[1].evictedAt).toBe(NOW - 30_000);
    expect(s.turns).toHaveLength(2);
    expect(s.renderedThisTurn).toBe(1);
    expect(s.lastFoldRejections[0]).toContain("minRangeBytes");
  });
});

describe("cli observability", () => {
  const run = (args, dir) => spawnSync(process.execPath, [join(import.meta.dir, "..", "cli.mjs"), ...args, "--store", dir], { encoding: "utf8" });

  test("folds and turns read the same ledger the agent sees", () => {
    const dir = seededDir();
    const folds = run(["folds", "s1"], dir);
    expect(folds.status).toBe(0);
    expect(folds.stdout).toContain("m00001–m00002");
    expect(folds.stdout).toContain("省下 ≈");
    const turns = run(["turns", "s1"], dir);
    expect(turns.stdout).toContain("计费=37,522");
    expect(turns.stdout).toContain("可折 m00023–m00037");
    expect(turns.stdout).toContain("折叠渲染=1");
  });

  test("skips prints the recorded gates and can forget them", () => {
    const dir = seededDir();
    recordSkip(dir, "s1", { at: NOW, reason: "开关关着", detail: "enabled=false" });
    expect(run(["skips"], dir).stdout).toContain("开关关着");
    expect(run(["skips", "--forget"], dir).stdout).toContain("清了");
    expect(run(["skips"], dir).stdout).toContain("没有跳过记录");
  });

  test("search finds a folded original by keyword", () => {
    const dir = store();
    const s = openSession(dir, "s2");
    s.storeOriginal("abcd000000000000", { blockId: "abcd000000000000", ref: "m00004", role: "user", text: "火山引擎拒绝了这条请求" });
    s.save();
    const out = run(["search", "火山引擎"], dir);
    expect(out.stdout).toContain("m00004");
    expect(out.stdout).toContain("火山引擎");
  });

  test("show is the same command as block", () => {
    const dir = store();
    const s = openSession(dir, "s3");
    s.storeOriginal("eeee000000000000", { blockId: "eeee000000000000", ref: "m00008", role: "assistant", text: "存档的原文" });
    s.save();
    expect(run(["show", "m00008"], dir).stdout).toContain("存档的原文");
  });
});

function seededDir() {
  const dir = store();
  seeded(dir);
  return dir;
}
