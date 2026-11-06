#!/usr/bin/env node
/**
 * Operator CLI. Deliberately not part of the request path and not part of either Bun host:
 * it runs under plain Node (>= 22) so it can be used when magpie itself is not running.
 *
 *   magpie-acp status  [--limit N] [--growth-floor N] [--json]
 *   magpie-acp sessions [--json]
 *   magpie-acp block   <id|ref> [--json]
 *   magpie-acp forget  <id|ref>... [--yes]
 *   magpie-acp unlock  [session]
 *   magpie-acp reconcile [--apply] [--ttl-days N] [--json]
 *   magpie-acp evict   [--max-bytes N] [--ttl-days N]
 *
 * The store directory comes from `--store`, then MAGPIE_ACP_STORE, then the plugin default.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findBlock, listBlocks } from "./src/blocks.mjs";
import { cleanup } from "./src/store.mjs";
import { forget, reconcile, renderStatus, scanStore, unlock } from "./src/maintenance.mjs";

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
      "  status      [--limit N] [--growth-floor N] [--json]",
      "  sessions    [--json]",
      "  block       <id|ref> [--json]",
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
      if (flags.json) return print(scan, flags);
      const limit = num(flags.limit, 5);
      return print(renderStatus(scan, { growthFloor, limit }), flags);
    }
    case "sessions": {
      const scan = scanStore(dir);
      if (flags.json) return print(scan.sessions, flags);
      if (!scan.sessions.length) return print("还没有会话记录。", flags);
      return print(scan.sessions.map((s) => `${s.key}  refs=${s.refs} folds=${s.folds} usage=${s.usage} last=${s.request?.at ?? "-"}`).join("\n"), flags);
    }
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
