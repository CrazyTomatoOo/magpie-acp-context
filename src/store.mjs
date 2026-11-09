import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

const LOCK_WAIT_MS = 120;

const MAX_USAGE = 200;

/**
 * A ring of the last requests, not just the newest one: "is this session growing or was that a
 * retry?" is a question one number cannot answer, and it is the question a reader actually asks.
 */
const MAX_TURNS = 20;

/** Clips, like folds, are keyed by content: the same tool result re-sent is one record. */
const MAX_CLIPS = 20;

const emptySession = () => ({ v: 1, next: 1, refs: {}, folds: [], clips: [], clipRefusals: [], usage: [], turns: [], nudge: null, refusal: null });

function paths(dir, key) {
  const root = join(dir, "sessions");
  const safe = String(key || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
  return { root, dir: join(root, safe), state: join(root, `${safe}.json`), lock: join(root, `${safe}.lock`) };
}

function withLock(lockPath, fn) {
  const started = Date.now();
  let fd = null;
  while (Date.now() - started < LOCK_WAIT_MS) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      // another hook of the same conversation holds it; wait a beat
      const until = Date.now() + 5;
      while (Date.now() < until) { /* spin: hooks must not use timers */ }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      try { rmSync(lockPath, { force: true }); } catch {}
    }
  }
}

function readJson(path, fallback) {
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
 * Per-session state: the ref ledger (monotonic, never renumbered) and the fold records.
 * Losing this file degrades to "no compression", never to a wrong request.
 */
export function openSession(storeDir, key) {
  const p = paths(storeDir, key);
  mkdirSync(p.dir, { recursive: true });
  const existed = existsSync(p.state);
  const state = existed ? readJson(p.state, emptySession()) : emptySession();
  if (!state.usage) state.usage = [];
  if (!Array.isArray(state.folds)) state.folds = [];
  if (!Array.isArray(state.clips)) state.clips = [];
  if (!Array.isArray(state.clipRefusals)) state.clipRefusals = [];
  if (!Array.isArray(state.elisions)) state.elisions = [];
  if (!state.elide) state.elide = null;
  if (!Array.isArray(state.turns)) state.turns = [];
  const before = existed ? JSON.stringify(state) : null;
  let dirty = false;

  return {
    key,
    dir: p.dir,
    /** Whether a store entry for this key was already there when it was opened. */
    existed,
    get state() {
      return state;
    },
    folds() {
      return state.folds;
    },
    /** blockId -> ref, assigning new refs in encounter order; stable for known content. */
    assignRefs(blockIds, formatRef) {
      const out = {};
      for (const id of blockIds) {
        if (!id) continue;
        if (!state.refs[id]) {
          state.refs[id] = formatRef(state.next);
          state.next += 1;
          dirty = true;
        }
        out[id] = state.refs[id];
      }
      return out;
    },
    /** Folds are keyed by their own id, so re-seeing the same compress call is a no-op. */
    recordFolds(folds, putOriginal) {
      const known = new Set(state.folds.map((f) => f.id));
      for (const fold of folds) {
        if (known.has(fold.id)) continue;
        state.folds.push(fold);
        known.add(fold.id);
        dirty = true;
        for (const block of fold.blocks || []) putOriginal(block);
      }
    },
    /**
     * A clip is a cut the hook made, not one the model asked for, so it keeps its own ring:
     * `folds` is the ledger of what the agent handed over, and mixing the two would make every
     * "did the agent fold?" answer wrong. Keyed by block id, because the same oversized tool
     * result arrives again on the next request and must not look like a second clip.
     */
    recordClips(clips, refusals = []) {
      const known = new Set(state.clips.map((c) => c.id));
      let added = 0;
      for (const clip of clips) {
        if (!clip?.id || known.has(clip.id)) continue;
        state.clips.push(clip);
        known.add(clip.id);
        added += 1;
        dirty = true;
      }
      if (state.clips.length > MAX_CLIPS) state.clips.splice(0, state.clips.length - MAX_CLIPS);
      for (const refusal of refusals) {
        state.clipRefusals.push(refusal);
        dirty = true;
      }
      if (state.clipRefusals.length > MAX_CLIPS) state.clipRefusals.splice(0, state.clipRefusals.length - MAX_CLIPS);
      return added;
    },
    clips() {
      return state.clips;
    },
    clipRefusals() {
      return state.clipRefusals;
    },
    /**
     * What onResponse saw the provider bill, newest last; the tail is all the nudge reads.
     * Dedupe is by request sequence, not by numbers: a duplicate completion callback for the
     * same request carries the same `seq`, while two different requests that happen to bill
     * the same tokens (or land in the same millisecond) are both real and both kept.
     */
    recordUsage(sample) {
      const last = state.usage[state.usage.length - 1];
      if (last && sample.seq != null && last.seq === sample.seq) return false;
      state.usage.push(sample);
      if (state.usage.length > MAX_USAGE) state.usage.splice(0, state.usage.length - MAX_USAGE);
      dirty = true;
      return true;
    },
    lastUsage() {
      return state.usage[state.usage.length - 1] ?? null;
    },
    /**
     * The biggest prompt the provider has billed. It is the last-resort answer to "how big is
     * this window": a request that came back with usage proves the window held at least that
     * much, and no cheaper evidence exists for a session nobody configured.
     */
    peakInput() {
      let peak = 0;
      for (const sample of state.usage) peak = Math.max(peak, Number(sample?.input) || 0);
      return peak;
    },
    elisions() {
      return state.elisions;
    },
    /**
     * One record per pass, keyed by its span: the same history elided twice is the same elision,
     * and a ring that grew on retries would read as "the hook keeps cutting", which is the one
     * thing a reader must be able to tell apart.
     */
    recordElisions(list) {
      const known = new Set(state.elisions.map((e) => e.id));
      let added = 0;
      for (const elision of list) {
        if (!elision?.id || known.has(elision.id)) continue;
        state.elisions.push(elision);
        known.add(elision.id);
        added += 1;
        dirty = true;
      }
      if (state.elisions.length > MAX_CLIPS) state.elisions.splice(0, state.elisions.length - MAX_CLIPS);
      return added;
    },
    elide() {
      return state.elide ?? null;
    },
    /**
     * The latch: how many passes in a row left the request over the limit, and whether the one
     * new-session line has already been said. It is stored rather than derived because the
     * request that says it and the request that repeats it are different requests.
     */
    setElide(elide) {
      state.elide = elide;
      dirty = true;
    },
    clearElide() {
      if (!state.elide) return false;
      state.elide = null;
      dirty = true;
      return true;
    },
    /**
     * The provider refusing the request is the one signal no size estimate can supply: a
     * session already bigger than its window never reaches the model, so it can never fold
     * its way out. Kept until a reply lands, because only then is the refusal history.
     */
    recordRefusal(sample) {
      const strikes = Number(state.refusal?.strikes ?? 0) + 1;
      state.refusal = { ...sample, strikes };
      dirty = true;
      return strikes;
    },
    clearRefusal() {
      if (!state.refusal) return false;
      state.refusal = null;
      dirty = true;
      return true;
    },
    refusal() {
      return state.refusal ?? null;
    },
    /** The whole request bookkeeping of the turn being sent, for `acp_status`. */
    recordRequest(info) {
      state.seq = Number(state.seq ?? 0) + 1;
      state.request = { ...info, seq: state.seq };
      state.turns.push({ ...state.request });
      if (state.turns.length > MAX_TURNS) state.turns.splice(0, state.turns.length - MAX_TURNS);
      dirty = true;
    },
    setNudge(nudge) {
      state.nudge = nudge;
      dirty = true;
    },
    nudge() {
      return state.nudge ?? null;
    },
    save() {
      if (!dirty && before !== null) return;
      if (before !== null && JSON.stringify(state) === before && !dirty) return;
      writeJsonAtomic(p.state, state);
      dirty = false;
    },
    withLock(fn) {
      return withLock(p.lock, fn);
    },
    /**
     * Folded originals live in one global, content-addressed place: `<store>/blocks/<blockId>.json`.
     * Block ids are derived from content, so any session (and any tool run, which has no session
     * of its own) can find an original without knowing which conversation folded it.
     *
     * Returns whether the original is on disk afterwards, not whether this call wrote it: a fold
     * may ignore the answer (the model already said the summary, and a missing original only
     * costs `decompress`), but a clip may not - `decompress` is its only way back, so a cut whose
     * original failed to store is abandoned (`hooks.mjs`).
     */
    storeOriginal(blockId, payload) {
      const file = join(storeDir, "blocks", `${blockId}.json`);
      try {
        mkdirSync(join(storeDir, "blocks"), { recursive: true });
        if (existsSync(file)) return true;
        writeJsonAtomic(file, { ...payload, session: key });
      } catch {
        return false;
      }
      return existsSync(file);
    },
    readOriginal(blockId) {
      return readJson(join(storeDir, "blocks", `${blockId}.json`), null);
    },
  };
}

/**
 * Keep the store bounded: drop blocks nobody folds any more, then the oldest
 * folded originals of dead sessions. A block a live fold still points at is kept
 * until the budget leaves no choice — and when it does go, every fold holding it
 * is marked `evicted` so `decompress` reports a hole instead of inventing text.
 */
export function cleanup(storeDir, { maxBytes = 0, ttlDays = 0, now = Date.now() } = {}) {
  const blocksDir = join(storeDir, "blocks");
  const sessionsDir = join(storeDir, "sessions");
  if (!existsSync(blocksDir)) return { removed: 0, freed: 0, evictedFolds: 0 };

  const referenced = new Set();
  const sessionFiles = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))
    : [];
  for (const file of sessionFiles) {
    const state = readJson(join(sessionsDir, file), null);
    for (const fold of state?.folds ?? []) for (const id of fold.blocks ?? []) referenced.add(id);
    // A clip's original is the only copy left of that text, so it is referenced exactly like a
    // folded block's: evicting it turns a marker's "可用 decompress 取回" into a lie.
    for (const clip of state?.clips ?? []) if (clip?.id) referenced.add(clip.id);
  }

  const files = readdirSync(blocksDir).filter((f) => f.endsWith(".json"));
  const blocks = [];
  let total = 0;
  for (const file of files) {
    const path = join(blocksDir, file);
    let size = 0;
    let mtime = 0;
    try {
      const st = statSync(path);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    total += size;
    blocks.push({ file, path, size, mtime, id: file.replace(/\.json$/, "") });
  }

  const doomed = new Set();
  if (ttlDays > 0) {
    const cutoff = now - ttlDays * 86400000;
    for (const b of blocks) if (b.mtime < cutoff && !referenced.has(b.id)) doomed.add(b.id);
  }
  let freed = blocks.filter((b) => doomed.has(b.id)).reduce((n, b) => n + b.size, 0);
  if (maxBytes > 0 && total - freed > maxBytes) {
    const oldestFirst = blocks
      .filter((b) => !doomed.has(b.id))
      .sort((a, b) => (referenced.has(a.id) ? 1 : 0) - (referenced.has(b.id) ? 1 : 0) || a.mtime - b.mtime);
    for (const b of oldestFirst) {
      if (total - freed <= maxBytes) break;
      doomed.add(b.id);
      freed += b.size;
    }
  }

  for (const id of doomed) {
    try { rmSync(join(blocksDir, `${id}.json`), { force: true }); } catch {}
  }

  let evictedFolds = 0;
  if (doomed.size) {
    for (const file of sessionFiles) {
      const path = join(sessionsDir, file);
      const state = readJson(path, null);
      if (!state) continue;
      let touched = false;
      for (const fold of state.folds ?? []) {
        const hit = (fold.blocks ?? []).filter((id) => doomed.has(id));
        if (!hit.length || fold.evictedAt) continue;
        fold.evictedAt = now;
        touched = true;
        evictedFolds += 1;
      }
      for (const clip of state.clips ?? []) {
        if (!doomed.has(clip?.id) || clip.evictedAt) continue;
        clip.evictedAt = now;
        touched = true;
      }
      if (touched) writeJsonAtomic(path, state);
    }
  }

  return { removed: doomed.size, freed, evictedFolds };
}
