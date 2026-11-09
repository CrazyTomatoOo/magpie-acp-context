/**
 * What the operator (and the model) can actually see. One renderer, two callers: the
 * `acp_status` tool in a live conversation and `magpie-acp status` in a terminal, so the two
 * can never drift apart — bili's `acp_status` was the surface people trusted precisely because
 * there was exactly one of it.
 *
 * Everything here is derived from the ledgers on disk; nothing is cached, nothing is estimated
 * beyond a clearly-marked byte→token conversion (3.5 bytes per token, the same constant the
 * nudge uses).
 *
 * Display rules bought with measured confusion:
 *  - a fold the client's own compaction has shaken loose is counted as NEITHER live NOR evicted;
 *    it gets its own number (`失锚`), because "folds=2" while nothing renders is a lie in two
 *    places at once;
 *  - every refused fold call is reported with the reason it was refused, since a rejected
 *    compress call otherwise looks exactly like a model that chose not to fold;
 *  - a request the hook never served says WHY, per session: silence was the hardest thing to
 *    debug from outside.
 */
import { utf8Bytes } from "./text.mjs";

const num = (n) => Number(n ?? 0).toLocaleString("en-US");
const pad = (n) => String(n).padStart(2, "0");

/** Bytes are not tokens; this is the same approximation the nudge thresholds were built on. */
export const tokensOfBytes = (bytes) => Math.round(Number(bytes ?? 0) / 3.5);

function stamp(ms, now = Date.now(), { full = false } = {}) {
  const d = ms ? new Date(Number(ms)) : null;
  if (!d || Number.isNaN(d.getTime())) return full ? "" : "-";
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = full ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function delta(from, to) {
  const d = Number(to ?? 0) - Number(from ?? 0);
  return `${d >= 0 ? "+" : ""}${num(d)}`;
}

/** What the folds add up to: how much original text they replaced, and with how little. */
export function foldStats(foldList = []) {
  let originalBytes = 0;
  let summaryBytes = 0;
  const coveredRefs = new Set();
  let live = 0;
  let evicted = 0;
  for (const fold of foldList) {
    originalBytes += Number(fold.bytes) || 0;
    summaryBytes += Number(fold.summaryBytes ?? utf8Bytes(fold.summary ?? "")) || 0;
    for (const block of fold.blocks ?? []) if (block?.ref) coveredRefs.add(block.ref);
    if (fold.evictedAt) evicted += 1;
    else live += 1;
  }
  const savedBytes = Math.max(0, originalBytes - summaryBytes);
  return { originalBytes, summaryBytes, savedBytes, savedTokens: tokensOfBytes(savedBytes), coveredRefs, live, evicted };
}

function foldRow(fold, index, now) {
  const summaryBytes = Number(fold.summaryBytes ?? 0) || utf8Bytes(fold.summary ?? "");
  const saved = Math.max(0, (Number(fold.bytes) || 0) - summaryBytes);
  const share = Number(fold.bytes) > 0 ? Math.round((saved / Number(fold.bytes)) * 100) : 0;
  const when = fold.at ? ` ${stamp(fold.at, now)}` : "";
  const size = `${num(fold.bytes)} → ${num(summaryBytes)} 字节(-${share}%)`;
  const state = fold.evictedAt ? " 原文已淘汰" : "";
  const blocks = Array.isArray(fold.blocks) ? ` ${fold.blocks.length} 条` : "";
  const id = String(fold.id ?? "").slice(0, 12);
  return `    ${index + 1}. ${fold.startRef}–${fold.endRef}${fold.topic ? ` 「${fold.topic}」` : ""} ${size}${blocks}${when}${state}${id ? ` block ${id}` : ""}`;
}

/**
 * One session, in the order a reader asks the questions: how big is the request, is the ledger
 * keeping up, did the folds actually render, and if nothing folded — why not.
 */
export function sessionReport(session, { growthFloor = 50000, turnLimit = 5, foldLimit = 10, now = Date.now() } = {}) {
  const lines = [];
  const request = session.request ?? null;
  const foldList = Array.isArray(session.foldList) ? session.foldList : [];
  const stats = foldStats(foldList);
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const last = turns.length ? turns[turns.length - 1] : request;

  lines.push(
    [
      `· ${session.key}`,
      `refs=${num(session.refs)} folds=${num(session.folds)} clips=${num((session.clips ?? []).length)} elides=${num((session.elisions ?? []).length)} evicted=${num(session.evictedFolds)}`,
      `本轮≈${num(request?.tokens ?? 0)} tok,计费 prompt=${num(session.lastUsage?.input ?? 0)} tok`,
      `收到 usage ${num(session.usage)} 次`,
      `nudge=${session.nudge ? `${session.nudge.kind}@${num(session.nudge.tokens ?? 0)} tok` : "无"}`,
    ].join(" · "),
  );

  if (request) {
    const where = [request.protocol, request.model].filter(Boolean).join(" · ") || "?";
    const cache = Number(session.lastUsage?.cacheRead ?? 0);
    lines.push(
      `  ${where} · ${stamp(request.at, now)} · units=${num(request.units)} · 请求 ${num(request.bytes)} 字节` +
        ` · 上下文≈${num(request.tokens)} tok · 计费 prompt=${num(session.lastUsage?.input ?? 0)} tok${cache ? `(缓存命中 ${num(cache)})` : ""}`,
    );
  }

  if (turns.length > 1) {
    const prev = turns[turns.length - 2];
    lines.push(`  走势:上下文 ${num(prev.tokens)} → ${num(last.tokens)}(${delta(prev.tokens, last.tokens)}) · 计费 ${num(prev.billed)} → ${num(last.billed)}(${delta(prev.billed, last.billed)})`);
  }

  if (foldList.length) {
    const coverage = Number(session.refs) > 0 ? Math.round((stats.coveredRefs.size / Number(session.refs)) * 100) : 0;
    lines.push(
      `  折叠账:${num(foldList.length)} 条覆盖 ${num(stats.coveredRefs.size)}/${num(session.refs)} 条 ref(${coverage}%)` +
        ` · 原文 ${num(stats.originalBytes)} 字节 → 摘要 ${num(stats.summaryBytes)} 字节,省下 ≈${num(stats.savedTokens)} tok`,
    );
    const shown = foldList.slice(-Math.max(1, foldLimit));
    lines.push(`  折叠明细${shown.length < foldList.length ? `(最近 ${shown.length}/${foldList.length} 条)` : ""}:`);
    const offset = foldList.length - shown.length;
    for (let i = 0; i < shown.length; i += 1) lines.push(foldRow(shown[i], offset + i, now));
  }

  if (request) {
    const rendered = Number(request.applied ?? 0);
    const dormant = Math.max(0, foldList.length - stats.evicted - rendered);
    const bits = [`  本轮渲染 ${num(rendered)} 个折叠`];
    if (dormant) bits.push(`另有 ${num(dormant)} 个失锚(宿主改写或截断了历史里的锚点,原文还在,这条折叠暂时用不上)`);
    if (request.foldableFrom && request.foldableTo) bits.push(`可折窗口 ${request.foldableFrom}–${request.foldableTo}`);
    if (bits.length > 1 || rendered) lines.push(bits.join(" · "));
  }

  if (request?.rejected?.length) lines.push(`  上次折叠没生效:${request.rejected.join(";")}`);
  const held = request?.nudgeHeld;
  if (held) {
    const why =
      held.reason === "no-window"
        ? "窗口里没有可折的范围(增长的都在保护尾里)"
        : `可折范围只有 ${num(held.reclaimable)} tok,不到门槛 ${num(held.minGain)} tok`;
    lines.push(`  提醒被压下:${why};阶段变了或折叠之后会再提醒。`);
  }
  // The cap is the hook's own cut, so it gets its own line: count, bytes it bought back, and
  // why the newest one happened. A refusal belongs here too - "nothing grew" and "I could not
  // cut anything" look identical from the outside otherwise.
  const clipList = Array.isArray(session.clips) ? session.clips : [];
  if (clipList.length) {
    const saved = clipList.reduce((n, c) => n + Math.max(0, Number(c.beforeBytes ?? 0) - Number(c.afterBytes ?? 0)), 0);
    const latest = clipList[clipList.length - 1];
    const gone = clipList.filter((c) => c.evictedAt).length;
    lines.push(
      `  裁剪:${num(clipList.length)} 条,原文省下 ${num(saved)} 字节 · 最近 ${stamp(latest?.at ?? null, now)} ${latest?.reason ?? "?"}` +
        `(原文 id ${String(latest?.id ?? "").slice(0, 16)})${gone ? ` · ${num(gone)} 条原文已淘汰` : ""}`,
    );
  }
  const clipRefused = Array.isArray(session.clipRefusals) ? session.clipRefusals : [];
  if (clipRefused.length) {
    const lastRefusal = clipRefused[clipRefused.length - 1];
    lines.push(`  上一轮有 ${num(clipRefused.length)} 条超限没裁成:${lastRefusal?.reason ?? "?"}`);
  }
  // The elision is the pass nobody asked for, so it must never look like a fold: no summary, a
  // count of turns, and the span it dropped - which is exactly what `decompress` needs to undo it.
  const elideList = Array.isArray(session.elisions) ? session.elisions : [];
  if (elideList.length) {
    const latest = elideList[elideList.length - 1];
    const saved = elideList.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
    lines.push(
      `  省略:${num(elideList.length)} 次,原文省下 ${num(saved)} 字节 · 最近 ${latest?.startRef ?? "?"}–${latest?.endRef ?? "?"}` +
        ` 共 ${num(latest?.count ?? 0)} 条 / ${num(latest?.turns ?? 0)} 轮(${stamp(latest?.at ?? null, now)})`,
    );
  }
  if (request?.limit) {
    const band = request.overLimit ? "超过" : "未超过";
    const streak = Number(request.elideStreak ?? 0);
    lines.push(`  窗口:${num(request.limit)} tok,本轮≈${num(request.tokens ?? 0)} tok ${band} 95% 线${streak ? `;连续第 ${num(streak)} 轮` : ""}`);
    if (request.newSession) lines.push("  本轮已经说过:该开一个新会话了(这一句每段一次,不会每轮重复)。");
  }
  if (request?.unrecognized?.length) lines.push(`  认不出的 compress 形状:${request.unrecognized.join(";")}`);
  if (request?.unresolved?.length) lines.push(`  引用了本插件没发过的 ref:${request.unresolved.join("、")}`);
  if (Number(request?.foreign) > 0) lines.push(`  另有 ${num(request.foreign)} 个 compress 调用来自别的压缩器(不算我们的折叠)`);

  if (session.refusal) lines.push(`  ${refusalLine(session.refusal, now)}`);

  if (!foldList.length && request && !session.refusal) {
    lines.push(`  还没有折叠成功过:提醒线是增长 ${num(growthFloor)} tokens,到了会提示可折范围。`);
  }
  return lines;
}

/** Requests the hook stepped aside for, newest first. Same reason twice in a row is one row. */
export function renderSkips(skips = [], { limit = 5, now = Date.now() } = {}) {
  if (!skips.length) return [];
  const out = ["最近被跳过(钩子没有介入的请求):"];
  for (const skip of skips.slice(0, limit)) {
    const times = Number(skip.count ?? 1) > 1 ? ` ×${num(skip.count)}` : "";
    out.push(`  ${stamp(skip.at, now)} ${skip.key ?? "?"} · ${skip.reason}${skip.detail ? `:${skip.detail}` : ""}${times}`);
  }
  if (skips.length > limit) out.push(`  …再加 ${num(skips.length - limit)} 条:magpie-acp skips`);
  return out;
}

/** The whole store: one header line, then the sessions, then the gates that skipped requests. */
export function renderStatus({ storeDir, sessions, blocks, bytes, skips = [] }, { growthFloor = 50000, limit = 5, turns = 5, foldLimit = 10, now = Date.now() } = {}) {
  const out = [`store ${storeDir}:${num(blocks.length)} 个块 / ${num(bytes)} 字节;${num(sessions.length)} 个会话;折叠提醒线 = 增长 ${num(growthFloor)} tokens。`];
  if (!sessions.length) out.push("还没有会话记录。");
  for (const session of sessions.slice(0, limit)) out.push(...sessionReport(session, { growthFloor, turnLimit: turns, foldLimit, now }));
  const skipLines = renderSkips(skips, { now });
  if (skipLines.length) out.push(...skipLines);
  return out.join("\n");
}

/**
 * What was refused, said once. A refusal is the only proof this plugin ever gets that a session
 * is already bigger than its window: the model never saw the prompt, so it never had a chance to
 * fold, and asking it harder cannot help - the host has to compact first.
 */
export function refusalLine(refusal, now = Date.now()) {
  const when = refusal.at ? `(${stamp(refusal.at, now, { full: true })})` : "";
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

/** The same data, structured, for `acp_status {json:true}` and `magpie-acp status --json`. */
export function reportData({ storeDir, sessions, blocks, bytes, skips = [] }, { growthFloor = 50000, limit = 5, now = Date.now() } = {}) {
  return {
    storeDir,
    growthFloor,
    blocks: blocks.length,
    bytes,
    sessions: sessions.slice(0, limit).map((s) => {
      const stats = foldStats(s.foldList ?? []);
      return {
        key: s.key,
        protocol: s.request?.protocol ?? null,
        model: s.request?.model ?? null,
        at: s.request?.at ?? null,
        units: s.request?.units ?? 0,
        requestBytes: s.request?.bytes ?? 0,
        contextTokens: s.request?.tokens ?? 0,
        billedPromptTokens: s.lastUsage?.input ?? 0,
        cacheReadTokens: s.lastUsage?.cacheRead ?? 0,
        refs: s.refs,
        folds: s.folds,
        evicted: s.evictedFolds,
        renderedThisTurn: s.request?.applied ?? 0,
        foldableFrom: s.request?.foldableFrom ?? null,
        foldableTo: s.request?.foldableTo ?? null,
        coverage: {
          coveredRefs: stats.coveredRefs.size,
          originalBytes: stats.originalBytes,
          summaryBytes: stats.summaryBytes,
          savedBytes: stats.savedBytes,
          savedTokens: stats.savedTokens,
        },
        foldList: (s.foldList ?? []).map((f) => ({
          id: f.id,
          startRef: f.startRef,
          endRef: f.endRef,
          topic: f.topic ?? "",
          bytes: f.bytes ?? 0,
          summaryBytes: f.summaryBytes ?? null,
          blocks: Array.isArray(f.blocks) ? f.blocks.length : 0,
          at: f.at ?? null,
          evictedAt: f.evictedAt ?? null,
        })),
        turns: s.turns ?? [],
        nudge: s.nudge ?? null,
        // A nudge that was held back: the reason and the two numbers it was weighed against.
        nudgeHeld: s.request?.nudgeHeld ?? null,
        refusal: s.refusal ?? null,
        lastFoldRejections: s.request?.rejected ?? [],
        unrecognized: s.request?.unrecognized ?? [],
        unresolved: s.request?.unresolved ?? [],
        foreign: s.request?.foreign ?? 0,
      };
    }),
    skips,
    at: now,
  };
}
