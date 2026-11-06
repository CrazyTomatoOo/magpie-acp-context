/**
 * The staleness hint for `acp_status`: one line naming the version the user is
 * actually running, plus the newest published version when the running copy is
 * behind the moving pointer, and `local build` when it is ahead of anything
 * published. Everything here must fail silent — a broken check
 * may never turn into error text on a tool the user asked for something else.
 *
 * The installed copy is what magpie placed under `<cwd>/plugins/node_modules/<pkg>`;
 * a developer checkout has none, and falls back to this package's own manifest.
 * The published-version answer is cached for a day in the store directory, so the hint costs
 * one request a day, not one per call; a failed check is remembered for six hours, so a dead
 * route is not retried on every call either.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_URL =
  "https://raw.githubusercontent.com/CrazyTomatooOo/magpie-acp-context/magpie-plugin/package.json";
const ownManifest = fileURLToPath(new URL("../package.json", import.meta.url));

const CHECK_CACHE_FILE = "version-check.json";
const CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_BACKOFF_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;

/**
 * The last successful check while it is still young enough to use: `<store>/version-check.json`,
 * holding `{latest, at}` beside the session and block files. Anything unreadable, unparsable,
 * or too old is simply no cache — the check runs afresh and the file gets rewritten. A failed
 * check is recorded in the same file as `{failedAt}` instead, holding the next attempt off
 * for six hours (`withinFailureBackoff`).
 */
function readCheckCache(storeDir) {
  if (!storeDir) return null;
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(storeDir, CHECK_CACHE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (typeof entry?.latest !== "string" || !entry.latest) return null;
  if (!Number.isFinite(entry.at) || Date.now() - entry.at >= CHECK_CACHE_TTL_MS) return null;
  return entry;
}

function writeCheckCache(storeDir, latest) {
  if (!storeDir) return;
  try {
    writeFileSync(join(storeDir, CHECK_CACHE_FILE), JSON.stringify({ latest, at: Date.now() }), "utf8");
  } catch {
    // a store this plugin cannot write to costs at most the fetch we already made, never the line
  }
}

function writeFailureRecord(storeDir) {
  if (!storeDir) return;
  try {
    writeFileSync(join(storeDir, CHECK_CACHE_FILE), JSON.stringify({ failedAt: Date.now() }), "utf8");
  } catch {
    // an unwritable store costs at most a retry on the next call, never the line
  }
}

/**
 * A failed check is remembered in the same file for 6 hours instead of a day: while
 * `{failedAt}` is younger than that, the check is not retried at all, so a dead route costs
 * one attempt per 6 hours rather than one per call.
 */
function withinFailureBackoff(storeDir) {
  if (!storeDir) return false;
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(storeDir, CHECK_CACHE_FILE), "utf8"));
  } catch {
    return false;
  }
  return Number.isFinite(entry?.failedAt) && Date.now() - entry.failedAt < CHECK_BACKOFF_MS;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The version of the copy that is actually running, or null when no manifest is readable. */
export function ownVersion(cwd = process.cwd()) {
  const own = readJson(ownManifest);
  const installed = own?.name ? readJson(join(cwd, "plugins", "node_modules", own.name, "package.json")) : null;
  const version = installed?.version ?? own?.version;
  return typeof version === "string" && version ? version : null;
}

function parseVersion(str) {
  if (typeof str !== "string") return null;
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(str);
  if (!m) return null;
  return { core: m[1].split(".").map(Number), pre: m[2] ?? null };
}

function comparePrerelease(a, b) {
  const ia = a.split(".");
  const ib = b.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Numeric per-component comparison with the leading `v` of a git tag tolerated
 * and a prerelease ordered below its release: negative when `a` is older,
 * positive when `a` is newer, 0 when equal, null when either side cannot be
 * parsed.
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d) return d;
  }
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return comparePrerelease(va.pre, vb.pre);
}

/**
 * The line for a running version and the version at the moving pointer: behind
 * names the published newest, ahead says `local build`, and equal or unparsable
 * names the running version only.
 */
function comparisonLine(own, latest) {
  const cmp = compareVersions(own, latest);
  if (cmp === null || cmp === 0) return `version ${own}`;
  return cmp < 0 ? `version ${own} · latest ${latest}` : `version ${own} · local build`;
}

/**
 * The abort signal asks a well-behaved fetch to stop at the budget; this deadline makes the
 * call return even against one that ignores it, so the tool cannot hang past the budget.
 */
function withDeadline(promise) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("version check timed out")), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * One attempt at the published version, recording the outcome in the cache file: a success is
 * kept for 24 hours, and any failure — offline, abort, non-2xx, a body with no version in it —
 * is recorded as a failure and returns null, so the line is absent rather than a guess.
 */
async function checkPublished(storeDir) {
  let latest;
  let failure;
  try {
    const res = await withDeadline(fetch(PUBLISHED_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }));
    if (res.ok) latest = (await res.json())?.version;
    else failure = `HTTP ${res.status}`;
  } catch (err) {
    failure = err?.message ?? String(err);
  }
  if (typeof latest !== "string" || !latest) failure ??= "no version in the published manifest";
  if (failure) {
    writeFailureRecord(storeDir);
    if (process.env.MAGPIE_ACP_DEBUG === "1") {
      // the same switch config.mjs reads: cfg never reaches this module, and the reason
      // belongs on the host's stderr, never in a tool result the model would echo back
      console.error("[magpie-acp-context] version check failed:", failure);
    }
    return null;
  }
  writeCheckCache(storeDir, latest);
  return latest;
}

/**
 * `version <own> · latest <published>` when behind the moving pointer,
 * `version <own> · local build` when ahead of anything published, plain
 * `version <own>` when current or when either version cannot be parsed — or
 * null when anything failed. One fetch a day per store: a check younger than 24 h renders from
 * the cache file, a failed check holds the next attempt off for 6 h, and the deadline keeps a
 * slow network from stalling the tool.
 */
export async function versionLine(cwd = process.cwd(), storeDir) {
  const own = ownVersion(cwd);
  if (!own) return null;
  let latest = readCheckCache(storeDir)?.latest;
  if (!latest) {
    if (withinFailureBackoff(storeDir)) return null;
    latest = await checkPublished(storeDir);
    if (!latest) return null;
  }
  return comparisonLine(own, latest);
}
