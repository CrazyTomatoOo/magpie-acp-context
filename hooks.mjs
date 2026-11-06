/**
 * magpie async gateway hook: ACP-style context compression, one request at a time.
 *
 * What this hook does (M0):
 *   1. give every visible turn a durable ref (a ledger, not a per-turn count) and stamp it
 *      into the message so the model can cite it;
 *   2. read compress calls the model already made (the client executed them) and turn them
 *      into fold records keyed by content, never by position;
 *   3. send the folded history: folded ranges collapse into one block, everything else is
 *      byte-identical to what the client sent.
 *
 * What it does in M2: the same, plus the reply's own `usage` (onResponse) becomes the
 * number the nudge decides on, so "the window is 78% full" is what the provider billed,
 * not a guess about the body.
 *
 * It never calls a model, never writes to the network, and never invents a summary.
 * Failing open is the default: any error returns undefined, i.e. the original request.
 */
import { loadConfig } from "./src/config.mjs";
import { adapterFor } from "./src/protocol.mjs";
import { openSession } from "./src/store.mjs";
import { compressCalls } from "./src/compress.mjs";
import { blockIdOf, formatRef, neutralizeMarkers, sha256, utf8Bytes } from "./src/text.mjs";
import { decideNudge, nudgeText, NUDGE_NONE } from "./src/nudge.mjs";
import { estimateBodyTokens, readUsage } from "./src/usage.mjs";

const PROMPT = [
  "[acp] 每条历史消息前的 [mNNNNN] 是它的 ref。",
  "要把一段旧历史折成摘要时,调用 compress 工具,给出 startRef、endRef、topic、summary;",
  "下一次请求里那段历史会被你的摘要替代。只折叠你已经不再需要原文的细节,",
  "不要把一次工具调用和它的结果切开。",
].join("");

/** `foldableFrom`/`foldableTo` are refs already (`m00001`), never numbers: the note is display text. */
export function buildNote({ foldableFrom, foldableTo, nudge = "", skipped = [], foreign = [] }) {
  const base = PROMPT;
  const parts = [
    foldableFrom == null || foldableTo == null
      ? base
      : `${base}当前可以折叠的范围是 ${foldableFrom}–${foldableTo}。`,
  ];
  if (skipped.length) {
    // Our own call whose range we cannot resolve (a ref we never issued, or a range the
    // window rule refuses). Saying so beats a silent no-op.
    parts.push(
      `历史里有 ${skipped.length} 个 compress 调用引用了本插件没有发过的 ref(${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? " 等" : ""}),无法按内容结算,已跳过;请用上面给出的范围重新调用。`,
    );
  }
  if (foreign.length) {
    // A session inherited from billion-context: same `mNNNNN` spelling, different numbering,
    // and a summary that describes the range bili saw. Settling it would be a guess.
    parts.push(
      `另有 ${foreign.length} 个 compress 调用来自别的压缩器(${foreign.slice(0, 3).join("、")}${foreign.length > 3 ? " 等" : ""}),它们的 ref 编号不是本插件发的,已跳过;要压缩请用上面给出的范围重新调用。`,
    );
  }
  if (nudge) parts.push(nudge);
  return parts.join("\n");
}

/** The window a percentage is taken of. Providers do not tell a hook, so it is configured. */
function windowTokens(cfg) {
  return Number(cfg.nudge.windowTokens) || 200000;
}

export function markerText(fold) {
  const head = `[acp] ${fold.startRef}–${fold.endRef}${fold.topic ? ` ${fold.topic}` : ""}`;
  return `${head}\n${neutralizeMarkers(fold.summary)}`;
}

function sessionKeyOf(ctx) {
  if (ctx?.session) return String(ctx.session);
  const agent = ctx?.agent ? String(ctx.agent) : "";
  const cwd = ctx?.cwd ? String(ctx.cwd) : "";
  if (agent || cwd) return `${agent}|${cwd}`;
  return "default";
}

function unitIds(units) {
  return units.map((u) => blockIdOf(`${u.role}\u0000${u.text}`));
}

/** Shrink or refuse a range until it no longer cuts a tool call away from its result. */
function pairSafe(units, start, end) {
  let s = start;
  let e = end;
  while (s > 0 && (units[s].role === "tool" || (units[s - 1].toolCalls || []).length > 0)) s -= 1;
  while (e + 1 < units.length && (units[e].toolCalls || []).length > 0) e += 1;
  return { start: s, end: e };
}

/**
 * The foldable window always stops before the turn being sent: everything from the last
 * user-positioned unit onward is the new input and must go out untouched. `keepRecentTurns`
 * additionally preserves that many trailing user turns.
 */
function foldWindow(units, keepRecentTurns) {
  const userIdx = [];
  units.forEach((u, i) => { if (u.role === "user") userIdx.push(i); });
  if (userIdx.length === 0) return null;
  const tailStart = userIdx[userIdx.length - 1];
  const keep = Math.max(0, Number(keepRecentTurns) || 0);
  const boundary = keep > 0 ? userIdx[Math.max(0, userIdx.length - keep)] : tailStart;
  const to = keep > 0 && userIdx.length <= keep ? -1 : Math.min(boundary, tailStart) - 1;
  if (to < 0) return null;
  return { from: 0, to };
}

export function planFolds({ units, refs, session, cfg }) {
  const idToIndex = new Map();
  for (const unit of units) {
    const ref = refs[unit.blockId];
    if (ref) idToIndex.set(ref, unit.index);
  }
  const window = foldWindow(units, cfg.keepRecentTurns);
  const created = [];
  const unresolved = [];
  const foreign = [];
  for (const call of compressCalls(units)) {
    if (!call.acknowledged) {
      for (const entry of call.entries) foreign.push(`${String(entry.startId).trim()}–${String(entry.endId).trim()}`);
      continue;
    }
    for (const entry of call.entries) {
      const startIndex = idToIndex.get(String(entry.startId).trim());
      const endIndex = idToIndex.get(String(entry.endId).trim());
      if (startIndex === undefined || endIndex === undefined) {
        unresolved.push(`${String(entry.startId).trim()}–${String(entry.endId).trim()}`);
        continue;
      }
      if (startIndex > endIndex) continue;
      if (!units[startIndex].stampable || !units[endIndex].stampable) continue;
      const safe = pairSafe(units, startIndex, endIndex);
      if (window && (safe.start < window.from || safe.end > window.to)) continue;
      const inRange = units.slice(safe.start, safe.end + 1);
      const bytes = inRange.reduce((n, u) => n + utf8Bytes(u.text), 0);
      if (bytes < Number(cfg.minRangeBytes)) continue;
      const summary = String(entry.summary || "").slice(0, Number(cfg.maxSummaryChars));
      if (!summary.trim()) continue;
      const startBlock = units[safe.start].blockId;
      const endBlock = units[safe.end].blockId;
      created.push({
        id: `${startBlock}-${endBlock}-${sha256(summary).slice(0, 12)}`,
        startRef: refs[startBlock],
        endRef: refs[endBlock],
        startBlock,
        endBlock,
        topic: String(entry.topic || "").slice(0, 120),
        summary,
        bytes,
        blocks: inRange.map((u) => ({ blockId: u.blockId, ref: refs[u.blockId], role: u.role, text: neutralizeMarkers(u.text) })),
      });
    }
  }
  return { created, window, unresolved: [...new Set(unresolved)], foreign: [...new Set(foreign)] };
}

/**
 * Folds survive only while both anchors are still in the history (the client's own
 * compaction drops them) AND the range is still inside the foldable window.
 */
export function liveRanges({ units, folds, window }) {
  const indexByBlock = new Map(units.map((u) => [u.blockId, u.index]));
  const ranges = [];
  for (const fold of folds) {
    const start = indexByBlock.get(fold.startBlock);
    const end = indexByBlock.get(fold.endBlock);
    if (start === undefined || end === undefined || start >= end) continue;
    if (window && (start < window.from || end > window.to)) continue;
    ranges.push({ start, end, fold });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let cursor = -1;
  for (const r of ranges) {
    if (r.start <= cursor) continue; // overlapping: keep the earliest, drop the rest
    kept.push(r);
    cursor = r.end;
  }
  return kept;
}

/**
 * `agents` is a canary list: empty means every agent, naming agents means only those. An
 * agent left out is never read, never written, and never recorded.
 */
function allowsAgent(cfg, ctx) {
  return cfg.agents.length === 0 || cfg.agents.includes(String(ctx?.agent ?? ""));
}

/**
 * magpie classifies the caller itself: `local` for a loopback request, `magpie-key`
 * for the owner's own sharing key, `gateway-key`/`remote` for anyone else's, and
 * nothing on an older host. Serving only the owner's own traffic is the default,
 * because this store keeps prompt text and usage per client.
 */
function allowsOrigin(cfg, ctx) {
  return cfg.origins.length === 0 || cfg.origins.includes(String(ctx?.origin ?? ""));
}

export async function onRequest(body, ctx) {
  const started = Date.now();
  let cfg;
  try {
    cfg = loadConfig(ctx?.options);
    if (!cfg.enabled) return undefined;
    // Canary gate: an agent left out of the list never reaches the store, so its requests
    // are byte-identical to what the client sent.
    if (!allowsAgent(cfg, ctx) || !allowsOrigin(cfg, ctx)) return undefined;
    const adapter = adapterFor(ctx?.protocol);
    if (!adapter || !adapter.unitArray(body)) return undefined;

    const units = adapter.read(body);
    if (units.length === 0) return undefined;

    const ids = unitIds(units);
    const session = openSession(cfg.storeDir, sessionKeyOf(ctx));

    // A ref is the only way a compress range can name a unit, so leaving system/developer
    // prompts unnumbered makes them unfoldable by construction rather than by a check.
    const refIds = ids.filter((_, i) => units[i].role !== "system" && units[i].role !== "developer");
    const refs = session.withLock(() => session.assignRefs(refIds, (n) => formatRef(n, cfg.refFormat)));
    for (let i = 0; i < units.length; i += 1) units[i].blockId = ids[i];
    for (let i = 0; i < units.length; i += 1) units[i].ref = refs[ids[i]];

    const { created, window, unresolved, foreign } = planFolds({ units, refs, session, cfg });
    if (created.length) {
      session.withLock(() => session.recordFolds(created, ({ blockId, role, text }) => session.storeOriginal(blockId, { role, text, ref: refs[blockId], at: Date.now() })));
    }
    const ranges = liveRanges({ units, folds: session.folds(), window });

    // Tokens: the billed prompt of the last reply when there is one (it is the only
    // number the provider actually counted), never smaller than this body's own size,
    // because a retry or a fresh session has no reply behind it yet.
    const lastUsage = session.lastUsage();
    const bodyTokens = estimateBodyTokens(body);
    const contextTokens = Math.max(bodyTokens, Number(lastUsage?.input) || 0);

    const foldedBytes = session.folds().reduce((n, f) => n + (Number(f.bytes) || 0), 0);
    const sinceGrowth = Math.max(0, contextTokens - Math.round(foldedBytes / 3.5));
    // Counted, not clocked: two replies inside the same millisecond must still be two replies.
    const answeredSince = session.state.usage.length > Number(session.nudge()?.usageCount ?? 0);
    const decision = decideNudge({
      cfg,
      contextTokens,
      sinceGrowth,
      lastNudge: session.nudge(),
      folds: session.folds().length,
      answeredSince,
    });
    const nudge =
      cfg.mode === "assist" && decision.kind !== NUDGE_NONE && !decision.repeat
        ? nudgeText(
            {
              kind: decision.kind,
              pct: decision.pct,
              range: window ? `${units[window.from]?.ref}–${units[window.to]?.ref}` : "",
            },
            cfg,
          )
        : "";
    if (nudge) {
      session.setNudge({
        kind: decision.kind,
        fingerprint: decision.fingerprint,
        at: Date.now(),
        tokens: contextTokens,
        usageCount: session.state.usage.length,
      });
    }
    session.recordRequest({
      at: Date.now(),
      protocol: ctx?.protocol,
      model: ctx?.model,
      units: units.length,
      bytes: utf8Bytes(JSON.stringify(body)),
      tokens: contextTokens,
      billed: Number(lastUsage?.input) || 0,
      folds: session.folds().length,
    });
    session.save();

    if (Date.now() - started > cfg.budgetMs) return undefined;

    const next = structuredClone(body);

    for (const unit of units) {
      if (!unit.stampable || !unit.ref) continue;
      adapter.stamp(next, unit.index, `[${unit.ref}]`);
    }

    if (ranges.length) {
      const arr = adapter.unitArray(next);
      for (const range of ranges.slice().sort((a, b) => b.start - a.start)) {
        arr.splice(range.start, range.end - range.start + 1, adapter.makeMarker(markerText(range.fold)));
      }
    }

    if (cfg.mode !== "render") {
      const note = buildNote({
        foldableFrom: window ? units[window.from]?.ref : null,
        foldableTo: window ? units[window.to]?.ref : null,
        nudge,
        skipped: unresolved,
        foreign,
      });
      if (cfg.injectStyle === "system-suffix") adapter.appendSystem(next, note);
      else adapter.appendNote(next, note);
    }

    if (JSON.stringify(next) === JSON.stringify(body)) return undefined;
    return next;
  } catch (err) {
    if (cfg?.failOpen !== false) return undefined;
    throw err;
  }
}

/**
 * The completion notification: magpie hands over the client-facing reply as one body
 * (`docs/subsystems/gateway-request-hooks.md`, "Completion notification"), so the usage
 * inside it is real. Recording it is the whole point: every later nudge is decided on
 * these numbers. Nothing here can change the reply, and nothing here may throw into it.
 */
export async function onResponse(reply, ctx) {
  let cfg;
  try {
    cfg = loadConfig(ctx?.options);
    if (!cfg.enabled) return;
    // Same canary gate as onRequest: an agent left out of the list leaves no trace either,
    // so a canary really is one client and nothing else.
    if (!allowsAgent(cfg, ctx) || !allowsOrigin(cfg, ctx)) return;
    const usage = readUsage(reply, ctx?.protocol);
    if (!usage) return;
    const session = openSession(cfg.storeDir, sessionKeyOf(ctx));
    session.withLock(() => {
      session.recordUsage({ ...usage, at: Date.now(), model: ctx?.model ?? null, seq: session.state.request?.seq ?? null });
      session.save();
    });
  } catch (err) {
    if (cfg?.failOpen === false) throw err;
  }
}

export default { onRequest, onResponse };
