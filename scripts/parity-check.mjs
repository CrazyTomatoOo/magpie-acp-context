#!/usr/bin/env node
/**
 * Compares billion-context's contract with the snapshot this plugin is written against.
 *
 *   node scripts/parity-check.mjs                      # check a checkout against the snapshot
 *   node scripts/parity-check.mjs --repo ~/bc          # explicit checkout
 *   node scripts/parity-check.mjs --update             # re-pin the snapshot (after a deliberate adoption)
 *   node scripts/parity-check.mjs --json               # machine-readable diff
 *
 * Exit codes: 0 = no drift, 1 = drift (adopt, ignore or record as a deliberate divergence), 2 = snapshot missing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffContract, extractContract, renderDiff } from "../parity/extract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const parityDir = join(root, "parity");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const mapping = existsSync(join(parityDir, "mapping.json"))
  ? JSON.parse(readFileSync(join(parityDir, "mapping.json"), "utf8"))
  : {};

const snapshots = readdirSync(parityDir)
  .filter((f) => /^bili-.*\.json$/.test(f))
  .sort();
const pinned = snapshots.at(-1);

const repo = resolve(value("repo") ?? process.env.BILI_REPO ?? "/tmp/bc-upstream");
if (!existsSync(join(repo, "package.json"))) {
  console.error(`no checkout at ${repo}; pass --repo <dir> (a git clone of ranxianglei/billion-context)`);
  process.exit(2);
}

const current = extractContract(repo);

if (flag("update")) {
  const target = join(parityDir, `bili-${current.version ?? "unknown"}.json`);
  writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`pinned ${target}`);
  process.exit(0);
}

if (!pinned) {
  console.error("no parity/bili-<version>.json snapshot; run --update once against a checkout");
  process.exit(2);
}

const diff = diffContract(JSON.parse(readFileSync(join(parityDir, pinned), "utf8")), current);

if (flag("json")) {
  console.log(JSON.stringify({ pinned, version: current.version, diff }, null, 2));
  process.exit(diff.length ? 1 : 0);
}

console.log(`pinned ${pinned} · checkout ${current.version ?? "unknown"} · ${repo}`);
console.log(renderDiff(diff, mapping));
process.exit(diff.length ? 1 : 0);
