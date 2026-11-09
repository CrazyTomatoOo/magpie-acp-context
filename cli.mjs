#!/usr/bin/env node
/**
 * Operator CLI. Deliberately not part of the request path and not part of either Bun host:
 * it runs under plain Node (>= 22) so it can be used when magpie itself is not running.
 *
 *   magpie-acp status  [--limit N] [--session KEY] [--folds N] [--growth-floor N] [--json]
 *   magpie-acp sessions [--json]
 *   magpie-acp folds   [session] [--json]
 *   magpie-acp turns   [session] [--limit N] [--json]
 *   magpie-acp skips   [--limit N] [--json] [--forget]
 *   magpie-acp search  <query> [--limit N] [--json]
 *   magpie-acp show    <id|ref>
 *   magpie-acp block   <id|ref> [--json]
 *   magpie-acp forget  <id|ref>... [--yes]
 *   magpie-acp unlock  [session]
 *   magpie-acp reconcile [--apply] [--ttl-days N] [--json]
 *   magpie-acp evict   [--max-bytes N] [--ttl-days N]
 *
 * The store directory comes from `--store`, then MAGPIE_ACP_STORE, then the plugin default.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { findBlock, searchBlocks } from "./src/blocks.mjs";
import { cleanup } from "./src/store.mjs";
import { forget, reconcile, renderSkips, renderStatus, scanStore, sessionReport, unlock } from "./src/maintenance.mjs";
import { foldStats, reportData } from "./src/report.mjs";
import { forgetSkips } from "./src/skips.mjs";

const DEFAULTS = {
  dir: "~/.local/share/magpie-acp",
  maxBytes: 536870912,
  ttlDays: 30,
  growthFloor: 50000,
};

function takeFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    i += 1;
  }
  return { flags, rest };
}

function storeDir(flags) {
  const chosen = flags.store || process.env.MAGPIE_ACP_STORE || DEFAULTS.dir;
  return resolve(chosen.replace(/^~(?=$|\/)/, homedir()));
}

function num(flag, fallback) {
  const n = Number(flag);
  return Number.isFinite(n) ? n : fallback;
}

function print(value, flags) {
  if (flags.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function usage() {
  console.log(
    [
      "usage: magpie-acp <command> [options]",
      "",
      "  status      [--limit N] [--session KEY] [--folds N] [--growth-floor N] [--json]",
      "  sessions    [--json]",
      "  folds       [session] [--json]               折叠明细与省下的字节/token",
      "  turns       [session] [--limit N] [--json]    每个会话最近几轮的体量走势",
      "  skips       [--limit N] [--json] [--forget]   钩子为什么跳过了请求",
      "  search      <query> [--limit N] [--json]      在被折叠的原文里检索",
      "  block       <id|ref> [--json]",
      "  show        <id|ref>                         block 的别名",
      "  forget      <id|ref>... [--yes]",
      "  unlock      [session]",
      "  reconcile   [--apply] [--ttl-days N] [--json]",
      "  evict       [--max-bytes N] [--ttl-days N]",
      "",
      "common: --store DIR (default $MAGPIE_ACP_STORE or ~/.local/share/magpie-acp)",
    ].join("\n"),
  );
}

function main(argv) {
  const { flags, rest } = takeFlags(argv);
  const command = rest[0];
  const dir = storeDir(flags);
  const growthFloor = num(flags["growth-floor"], DEFAULTS.growthFloor);

  switch (command) {
    case "status": {
      const scan = scanStore(dir);
      const limit = num(flags.limit, 5);
      const shown = flags.session ? scan.sessions.filter((s) => s.key === flags.session) : scan.sessions;
      if (flags.json) {
        return print(reportData({ ...scan, sessions: shown }, { growthFloor, limit }), flags);
      }
      const out = renderStatus(
        { ...scan, sessions: shown },
        { growthFloor, limit, foldLimit: num(flags.folds, 10) },
      );
      return print(flags.session && !shown.length ? `${out}\n没有这个会话:${flags.session}` : out, flags);
    }
    case "folds": {
      const scan = scanStore(dir);
      const shown = rest[1] ? scan.sessions.filter((s) => s.key === rest[1]) : scan.sessions.slice(0, num(flags.limit, 1));
      if (!shown.length) return print(rest[1] ? `没有这个会话:${rest[1]}` : "还没有会话记录。", flags);
      if (flags.json) return print(shown.map((s) => ({ key: s.key, folds: s.foldList, ...foldStats(s.foldList) })), flags);
      const lines = [];
      for (const s of shown) lines.push(...sessionReport(s, { growthFloor, foldLimit: num(flags.folds, 50) }));
      return print(lines.join("\n"), flags);
    }
    case "turns": {
      const scan = scanStore(dir);
      const shown = rest[1] ? scan.sessions.filter((s) => s.key === rest[1]) : scan.sessions.slice(0, num(flags.limit, 1));
      if (!shown.length) return print(rest[1] ? `没有这个会话:${rest[1]}` : "还没有会话记录。", flags);
      if (flags.json) return print(shown.map((s) => ({ key: s.key, turns: s.turns })), flags);
      const limit = num(flags.limit, 10);
      const lines = [];
      for (const s of shown) {
        lines.push(`· ${s.key}`);
        const turns = (s.turns ?? []).slice(-limit);
        if (!turns.length) lines.push("  还没有请求记录。");
        for (const t of turns) {
          const n = (v) => Number(v ?? 0).toLocaleString("en-US");
          lines.push(
            `  ${t.at ? new Date(Number(t.at)).toISOString() : "-"} seq=${t.seq ?? "?"} units=${n(t.units)} ${n(t.bytes)}B` +
              ` 上下文≈${n(t.tokens)} 计费=${n(t.billed)} 折叠渲染=${n(t.applied)}` +
              `${t.foldableFrom && t.foldableTo ? ` 可折 ${t.foldableFrom}–${t.foldableTo}` : ""}` +
              `${t.rejected?.length ? ` 上次折叠被拒:${t.rejected[0]}` : ""}`,
          );
        }
      }
      return print(lines.join("\n"), flags);
    }
    case "skips": {
      const scan = scanStore(dir);
      if (flags.forget) return print(`清了 ${forgetSkips(dir, rest[1] ?? null)} 个会话的跳过记录。`, flags);
      if (flags.json) return print(scan.skips, flags);
      const lines = renderSkips(scan.skips, { limit: num(flags.limit, 20) });
      return print(lines.length ? lines.join("\n") : "没有跳过记录：钩子介入了它看到的每一个请求。", flags);
    }
    case "search": {
      const query = rest[1];
      if (!query) return usage();
      const hits = searchBlocks(dir, query, num(flags.limit, 5));
      if (flags.json) return print(hits, flags);
      if (!hits.length) return print(`没有命中:${query}`, flags);
      return print(hits.map((h, i) => `[${i + 1}] ${h.blockId}${h.ref ? ` ${h.ref}` : ""} role=${h.role || "?"} score=${h.score}\n${h.snippet}`).join("\n\n"), flags);
    }
    case "sessions": {
      const scan = scanStore(dir);
      if (flags.json) return print(scan.sessions, flags);
      if (!scan.sessions.length) return print("还没有会话记录。", flags);
      return print(scan.sessions.map((s) => `${s.key}  refs=${s.refs} folds=${s.folds} usage=${s.usage} last=${s.request?.at ?? "-"}`).join("\n"), flags);
    }
    case "show":
    case "block": {
      const id = rest[1];
      if (!id) return usage();
      const found = findBlock(dir, id);
      if (!found) return print(`没有这个块:${id}`, flags);
      return print(found.text, flags);
    }
    case "forget": {
      const wanted = rest.slice(1);
      if (!wanted.length) return usage();
      // Accept refs too: an operator reads refs in the transcript, not 16 hex chars.
      const ids = wanted.map((w) => findBlock(dir, w)?.blockId ?? w);
      if (!flags.yes) return print(`将删除 ${ids.length} 个块的原文(不可恢复)。加 --yes 执行:\n${ids.join("\n")}`, flags);
      return print(forget(dir, ids), flags);
    }
    case "unlock": {
      const done = unlock(dir, rest[1] ?? null);
      return print(`removed ${done.removed} lock file(s)`, flags);
    }
    case "reconcile": {
      const done = reconcile(dir, {
        apply: Boolean(flags.apply),
        ttlDays: num(flags["ttl-days"], 0),
      });
      if (flags.json) return print(done, flags);
      const lines = [
        `sessions=${done.scannedSessions} blocks=${done.scannedBlocks}`,
        `missing originals → folds marked evicted: ${done.missingOriginals}`,
        `orphan blocks: ${done.orphanBlocks}${flags.apply ? ` (removed ${done.removedBlocks})` : " (dry run, --apply to remove)"}`,
        `dead sessions: ${done.deadSessions}${flags.apply ? ` (dropped ${done.droppedRefs} refs)` : ""}`,
      ];
      return print(lines.join("\n"), flags);
    }
    case "evict": {
      const done = cleanup(dir, {
        maxBytes: num(flags["max-bytes"], DEFAULTS.maxBytes),
        ttlDays: num(flags["ttl-days"], DEFAULTS.ttlDays),
      });
      return print(`删了 ${done.removed} 个块,释放 ${done.freed} 字节,标记 ${done.evictedFolds} 个 fold 为已淘汰。`, flags);
    }
    default:
      return usage();
  }
}

main(process.argv.slice(2));
