/**
 * Off-request maintenance. Nothing here runs on the request path: the hook stays under its
 * budget, and the operator (or `acp_status {evict:true}`) decides when to pay for a scan.
 *
 * The store is two directories that can drift apart:
 *   sessions/<key>.json          the ref ledger and the fold records
 *   blocks/<blockId>.json        the folded originals, content-addressed, shared by all sessions
 *
 * Drift is normal, not corruption: a fold whose original was evicted, a block nobody folds any
 * more, a lock file left behind by a killed process. Every function here repairs one shape of it
 * and reports what it did, so a repair is auditable rather than silent.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { blocksDir } from "./blocks.mjs";
import { cleanup } from "./store.mjs";

const MAX_SCAN = 50_000;

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

function sessionFiles(storeDir) {
  try {
    return readdirSync(join(storeDir, "sessions"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ key: f.replace(/\.json$/, ""), path: join(storeDir, "sessions", f) }));
  } catch {
    return [];
  }
}

function blockFiles(storeDir) {
  try {
    return readdirSync(blocksDir(storeDir))
      .filter((f) => f.endsWith(".json"))
      .slice(0, MAX_SCAN)
      .map((f) => {
        const path = join(blocksDir(storeDir), f);
        let size = 0;
        let mtime = 0;
        try {
          const st = statSync(path);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          // vanished between readdir and stat: not ours to report
        }
        return { id: f.replace(/\.json$/, ""), path, size, mtime };
      });
  } catch {
    return [];
  }
}

/** Everything the operator needs to see, computed from disk, never from a cache. */
export function scanStore(storeDir) {
  const sessions = sessionFiles(storeDir).map(({ key, path }) => {
    const state = readJson(path, {}) ?? {};
    return {
      key,
      path,
      refs: Object.keys(state.refs ?? {}).length,
      folds: (state.folds ?? []).length,
      evictedFolds: (state.folds ?? []).filter((f) => f.evictedAt).length,
      usage: (state.usage ?? []).length,
      lastUsage: state.usage?.[state.usage.length - 1] ?? null,
      request: state.request ?? null,
      nudge: state.nudge ?? null,
      refusal: state.refusal ?? null,
    };
  });
  const blocks = blockFiles(storeDir);
  return {
    storeDir,
    sessions: sessions.sort((a, b) => (b.request?.at ?? 0) - (a.request?.at ?? 0)),
    blocks,
    bytes: blocks.reduce((n, b) => n + b.size, 0),
  };
}

/**
 * Repairs, in the order that leaves the store consistent at every step:
 *  1. a fold whose original is gone is marked `evictedAt` (so `decompress` reports a hole
 *     instead of inventing text) — `apply:false` only reports the count;
 *  2. a block no fold points at is an orphan (a crash between "write original" and "write
 *     ledger"); deleted only with `apply:true`;
 *  3. a session with no request inside `ttlDays` is dead: its refs are dropped (they can never
 *     be referenced again) while its folds are kept, because a live client could still resume.
 */
export function reconcile(storeDir, { apply = false, ttlDays = 0, now = Date.now() } = {}) {
  const blocks = blockFiles(storeDir);
  const files = sessionFiles(storeDir);
  const referenced = new Set();
  const report = { scannedSessions: files.length, scannedBlocks: blocks.length, missingOriginals: 0, orphanBlocks: 0, deadSessions: 0, droppedRefs: 0, removedBlocks: 0 };

  const states = new Map();
  for (const { key, path } of files) {
    const state = readJson(path, null);
    if (!state) continue;
    states.set(key, { path, state });
    for (const fold of state.folds ?? []) for (const id of fold.blocks ?? []) referenced.add(id);
  }

  const present = new Set(blocks.map((b) => b.id));
  for (const { path, state } of states.values()) {
    let touched = false;
    for (const fold of state.folds ?? []) {
      const lost = (fold.blocks ?? []).filter((id) => !present.has(id));
      if (!lost.length || fold.evictedAt) continue;
      report.missingOriginals += 1;
      fold.evictedAt = now;
      touched = true;
    }
    if (ttlDays > 0) {
      const idle = now - Number(state.request?.at ?? 0);
      if (Number(state.request?.at ?? 0) > 0 && idle > ttlDays * 86400000) {
        report.deadSessions += 1;
        const live = new Set();
        for (const fold of state.folds ?? []) for (const id of fold.blocks ?? []) live.add(id);
        for (const id of Object.keys(state.refs ?? {})) {
          if (live.has(id)) continue;
          delete state.refs[id];
          report.droppedRefs += 1;
          touched = true;
        }
      }
    }
    if (touched && apply) writeJsonAtomic(path, state);
  }

  const orphans = blocks.filter((b) => !referenced.has(b.id));
  report.orphanBlocks = orphans.length;
  if (apply) {
    for (const b of orphans) {
      try {
        rmSync(b.path, { force: true });
        report.removedBlocks += 1;
      } catch {
        // a block that will not delete is still an orphan; the next run reports it again
      }
    }
  }
  return report;
}

/** Delete originals on purpose: `acp forget <id|ref>...`. A fold holding one becomes a hole. */
export function forget(storeDir, ids, { now = Date.now() } = {}) {
  const removed = [];
  for (const id of ids) {
    const path = join(blocksDir(storeDir), `${id}.json`);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(id);
    } catch {
      // permission or a concurrent writer: report nothing removed for this id
    }
  }
  let marked = 0;
  const gone = new Set(removed);
  if (gone.size) {
    for (const { path } of sessionFiles(storeDir).map(({ key, path }) => ({ key, path }))) {
      const state = readJson(path, null);
      if (!state) continue;
      let touched = false;
      for (const fold of state.folds ?? []) {
        if (fold.evictedAt) continue;
        if (!(fold.blocks ?? []).some((id) => gone.has(id))) continue;
        fold.evictedAt = now;
        touched = true;
        marked += 1;
      }
      if (touched) writeJsonAtomic(path, state);
    }
  }
  return { removed, markedFolds: marked };
}

/** A hook killed mid-write leaves `*.lock` behind; hooks only wait 120 ms, so it must be removed. */
export function unlock(storeDir, key = null) {
  let locks = [];
  try {
    locks = readdirSync(join(storeDir, "sessions"))
      .filter((f) => f.endsWith(".lock"))
      .filter((f) => (key ? f === `${key}.lock` : true))
      .map((f) => join(storeDir, "sessions", f));
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const path of locks) {
    try {
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // someone else already removed it
    }
  }
  return { removed };
}

/** One line per session, the same shape the agent sees from `acp_status`. */
export function renderStatus({ storeDir, sessions, blocks, bytes }, { growthFloor = 50000, limit = 5 } = {}) {
  const num = (n) => Number(n ?? 0).toLocaleString("en-US");
  const out = [`store ${storeDir}:${num(blocks.length)} 个块 / ${num(bytes)} 字节;${num(sessions.length)} 个会话;折叠提醒线 = 增长 ${num(growthFloor)} tokens。`];
  if (!sessions.length) out.push("还没有会话记录。");
  for (const s of sessions.slice(0, limit)) {
    out.push(
      [
        `· ${s.key}`,
        `refs=${num(s.refs)} folds=${num(s.folds)} evicted=${num(s.evictedFolds)}`,
        `本轮≈${num(s.request?.tokens ?? 0)} tok,计费 prompt=${num(s.lastUsage?.input ?? 0)} tok`,
        `收到 usage ${num(s.usage)} 次`,
        `nudge=${s.nudge ? `${s.nudge.kind}@${num(s.nudge.tokens ?? 0)} tok` : "无"}`,
      ].join(" · "),
    );
    if (s.refusal) out.push(`  ${refusalLine(s.refusal)}`);
  }
  return out.join("\n");
}

export { cleanup };

/**
 * What a refused turn means, said once. A refusal is the only proof this plugin ever gets that
 * a session is already bigger than its window: the model never saw the prompt, so it never had
 * a chance to fold, and asking it harder cannot help - the host has to compact first.
 */
export function refusalLine(refusal) {
  const num = (n) => Number(n ?? 0).toLocaleString("en-US");
  const pad = (n) => String(n).padStart(2, "0");
  const d = refusal.at ? new Date(refusal.at) : null;
  const when = d && !Number.isNaN(d.getTime())
    ? `(${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`
    : "";
  const size = refusal.tokens ? `本轮 ≈${num(refusal.tokens)} tokens` : "本轮大小未知";
  const strikes = Number(refusal.strikes ?? 0);

  // A reason with a ceiling in it is proof. Say it plainly, and say the fold cannot help.
  if (refusal.contextLimit) {
    const why = String(refusal.text || "理由是上下文超限").replace(/[。.]+$/, "");
    const ceiling = refusal.limit ? `上限约 ${num(refusal.limit)} tokens。` : "";
    const here = refusal.tokens ? `本轮 ≈${num(refusal.tokens)} tokens。` : "";
    return `上游拒了上一轮${when}:${why}。${ceiling}${here}折叠救不了这一轮 —— 请求在模型看到提示之前就被拒了,先在宿主里压缩一次(compaction),再继续。`;
  }

  // No reason arrives: magpie forwards nothing on a failed turn (measured 2026-11-07: `reply` is
  // null, `ctx.state` empty), and an aborted request (omp cancels with 499) looks exactly like a
  // provider rejection from here. So state the fact and let repetition speak, never assert a cause.
  const why = refusal.text ? `${refusal.text}。` : "magpie 在失败回合不转发原因。";
  if (strikes >= 2) {
    return `上一轮请求又没拿到回复${when};${size},连续 ${strikes} 轮都如此。${why}若每一轮都在同一个体量上失败,通常是上下文上限 —— 那种情况下折叠救不了(请求在模型看到提示之前就被拒了),先在宿主里压缩一次(compaction)。`;
  }
  return `上一轮请求没拿到回复${when};${size}。${why}单次失败多半是取消或上游抖动,下一轮成功就会清掉。`;
}

/**
 * The note is context the model pays for on every turn, so it only carries a refusal that has
 * something to act on: a proven ceiling, or the repetition that makes a stuck session evident.
 */
export function refusalNote(refusal) {
  if (!refusal) return "";
  return refusal.contextLimit || Number(refusal.strikes ?? 0) >= 2 ? refusalLine(refusal) : "";
}
