/**
 * Reads over the global block store. A tool runs in the plugin host with no request and no
 * session, so everything here is keyed by content: `<store>/blocks/<blockId>.json`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_SCAN = 20_000;
export const MAX_SNIPPET = 1_200;

export function blocksDir(storeDir) {
  return join(storeDir, "blocks");
}

export function readBlock(storeDir, blockId) {
  try {
    return JSON.parse(readFileSync(join(blocksDir(storeDir), `${blockId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Every block on disk, newest first. Bounded so a big store cannot stall a tool call. */
/** Every session's ledger, newest request first — what `acp_status` reports. */
export function listSessions(storeDir) {
  const dir = join(storeDir, "sessions");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    try {
      const state = JSON.parse(readFileSync(join(dir, file), "utf8"));
      out.push({
        key: file.replace(/\.json$/, ""),
        folds: (state.folds ?? []).length,
        refs: Object.keys(state.refs ?? {}).length,
        usage: state.usage?.length ?? 0,
        lastUsage: state.usage?.[state.usage.length - 1] ?? null,
        request: state.request ?? null,
        nudge: state.nudge ?? null,
        evictedFolds: (state.folds ?? []).filter((f) => f.evictedAt).length,
      });
    } catch {
      // an unreadable ledger is a missing one, not a crash
    }
  }
  return out.sort((a, b) => (b.request?.at ?? 0) - (a.request?.at ?? 0));
}

export function listBlocks(storeDir) {
  let names;
  try {
    names = readdirSync(blocksDir(storeDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, MAX_SCAN)) {
    const path = join(blocksDir(storeDir), name);
    let at = 0;
    let size = 0;
    try {
      const st = statSync(path);
      at = st.mtimeMs;
      size = st.size;
    } catch {
      continue;
    }
    out.push({ blockId: name.slice(0, -5), path, at, size });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** One block by its id or by the ref it was shown under (`m00003`). */
export function findBlock(storeDir, idOrRef) {
  const key = String(idOrRef || "").trim();
  if (!key) return null;
  const direct = readBlock(storeDir, key);
  if (direct) return { blockId: key, ...direct };
  for (const { blockId } of listBlocks(storeDir)) {
    const block = readBlock(storeDir, blockId);
    if (block && block.ref === key) return { blockId, ...block };
  }
  return null;
}

const tokens = (text) => (String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 64);

function score(block, needle, terms) {
  const hay = String(block.text || "").toLowerCase();
  if (!hay) return 0;
  let s = hay.includes(needle) ? 10 : 0;
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(t, from);
      if (at < 0) break;
      s += 1;
      from = at + t.length;
      if (s > 400) break;
    }
  }
  return s;
}

function snippet(text, needle, terms) {
  const hay = String(text || "");
  const lower = hay.toLowerCase();
  let at = needle ? lower.indexOf(needle) : -1;
  if (at < 0) {
    for (const t of terms) {
      at = lower.indexOf(t);
      if (at >= 0) break;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 200);
  const body = hay.slice(start, start + MAX_SNIPPET);
  return `${start > 0 ? "…" : ""}${body}${start + MAX_SNIPPET < hay.length ? "…" : ""}`;
}

/** Substring plus term-frequency ranking across folded originals. */
export function searchBlocks(storeDir, query, limit = 5) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const terms = tokens(needle);
  const hits = [];
  for (const { blockId } of listBlocks(storeDir)) {
    const block = readBlock(storeDir, blockId);
    if (!block) continue;
    const s = score(block, needle, terms);
    if (s <= 0) continue;
    hits.push({ blockId, ref: block.ref, role: block.role, score: s, at: block.at ?? 0, snippet: snippet(block.text, needle, terms) });
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  return hits.slice(0, Math.max(1, Math.min(20, limit)));
}
