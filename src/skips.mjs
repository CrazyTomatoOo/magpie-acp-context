/**
 * Why the hook stepped aside, written down per session.
 *
 * Every gate in `onRequest` returns the request untouched, which from the outside is
 * indistinguishable from "this plugin is not installed": no refs, no note, no fold, and nothing
 * on the wire says why. `debug` prints the reason to the host's stderr — which a TUI user never
 * sees. This file is the other half: `<store>/skips/<key>.json`, a ring of the last reasons that
 * session was skipped, read by `acp_status` and `magpie-acp skips`.
 *
 * It is deliberately NOT in the session ledger: a skipped request must not create a session
 * entry (that would put a ghost conversation in `acp_status` and give it a ref space it never
 * uses), and the skip record must survive the session file being deleted or reconciled.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_SKIPS = 20;

const MAX_DETAIL = 160;

export function skipsDir(storeDir) {
  return join(storeDir, "skips");
}

const safeKey = (key) => String(key || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, path);
}

/**
 * Best effort by contract: this runs on the request path (right before the hook returns the
 * request untouched), so it may never throw and may never wait. A failed write loses one
 * diagnostic row; the request itself is unaffected.
 */
export function recordSkip(storeDir, key, entry) {
  try {
    const path = join(skipsDir(storeDir), `${safeKey(key)}.json`);
    const ring = readJson(path, []);
    const list = Array.isArray(ring) ? ring : [];
    const reason = String(entry?.reason ?? "?");
    const detail = String(entry?.detail ?? "").slice(0, MAX_DETAIL);
    const last = list[list.length - 1];
    // The same gate firing every turn is one finding, not twenty: count it instead of appending.
    if (last && last.reason === reason && last.detail === detail) {
      last.count = Number(last.count ?? 1) + 1;
      last.at = Number(entry?.at ?? Date.now());
    } else {
      list.push({ at: Number(entry?.at ?? Date.now()), reason, detail, count: 1 });
    }
    while (list.length > MAX_SKIPS) list.shift();
    mkdirSync(skipsDir(storeDir), { recursive: true });
    writeJsonAtomic(path, list);
    return true;
  } catch {
    return false;
  }
}

/** Every skip record on disk, newest first. A corrupted file is a missing one, never a crash. */
export function scanSkips(storeDir) {
  let names = [];
  try {
    names = readdirSync(skipsDir(storeDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const key = name.replace(/\.json$/, "");
    const ring = readJson(join(skipsDir(storeDir), name), []);
    if (!Array.isArray(ring)) continue;
    for (const entry of ring) {
      if (!entry || typeof entry !== "object") continue;
      out.push({
        key,
        at: Number(entry.at ?? 0),
        reason: String(entry.reason ?? "?"),
        detail: String(entry.detail ?? ""),
        count: Number(entry.count ?? 1),
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function forgetSkips(storeDir, key = null) {
  try {
    const names = readdirSync(skipsDir(storeDir)).filter((f) => f.endsWith(".json"));
    const gone = names.filter((n) => (key ? n === `${safeKey(key)}.json` : true));
    for (const name of gone) writeFileSync(join(skipsDir(storeDir), name), "[]", "utf8");
    return gone.length;
  } catch {
    return 0;
  }
}
