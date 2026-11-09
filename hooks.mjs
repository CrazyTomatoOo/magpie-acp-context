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
import { refusalNote } from "./src/maintenance.mjs";
import { adapterFor, advertisedToolNames } from "./src/protocol.mjs";
import { recordSkip } from "./src/skips.mjs";
import { openSession } from "./src/store.mjs";
import { canCallOwnTools, compressCalls, deviceTarget, MIN_SUMMARY_BYTES, ownToolUnit, unknownShapes } from "./src/compress.mjs";
import { blockIdOf, formatRef, neutralizeMarkers, sha256, utf8Bytes } from "./src/text.mjs";
import { decideNudge, nudgeText, NUDGE_NONE } from "./src/nudge.mjs";
import { clipMarker, planClips } from "./src/fallback.mjs";
import { estimateBodyTokens, readRefusal, readUsage } from "./src/usage.mjs";

// The one sentence a model reads before its first fold. It names the tool's real argument
// (`content`, one header line and a summary line) because a model that guesses the shape pays a
// wasted turn for it: measured 2026-11-07, a note promising startRef/endRef/topic/summary sent a
// model into exactly that.
const PROMPT = [
  "[acp] 每条历史消息前的 [mNNNNN] 是它的 ref,只在指代某条历史时写;不要给你的回复加这种前缀。",
  "要把一段旧历史折成摘要时,调用 compress 工具,参数 content 写成:",
  "第一行 `m00002–m00005 主题`,紧接的下一行是这一段的中文摘要(至少 40 字节);",
  "多段之间用空行分隔。摘要要写成普通字符串字面量,不要用变量拼接。",
  "下一次请求里那段历史会被你的摘要替代。只折叠你已经不再需要原文的细节,",
  "不要把一次工具调用和它的结果切开。",
].join("");

/** `foldableFrom`/`foldableTo` are refs already (`m00001`), never numbers: the note is display text. */
export function buildNote({ foldableFrom, foldableTo, nudge = "", skipped = [], foreign = [], rejected = [], unrecognized = [], refusal = "", minRangeBytes = 0 }) {
  const base = PROMPT;
  const parts = [
    foldableFrom == null || foldableTo == null
      ? base
      : `${base}当前可以折叠的范围是 ${foldableFrom}–${foldableTo}。`,
  ];
  // A call under the floor is not an error, it is a no-op: the range stays put and nothing
  // settles. Saying the number up front is cheaper than the model discovering it per call.
  if (Number(minRangeBytes) > 0) {
    parts.push(
      `一次折叠覆盖的原文至少 ${Number(minRangeBytes)} 字节(约 ${Math.round(Number(minRangeBytes) / 2.5)} tokens);不够的先留在历史里,攒够了再折。`,
      `摘要至少 ${MIN_SUMMARY_BYTES} 字节:被折叠的原文之后只剩摘要,写短了等于把那段历史删掉。`,
    );
  }
  if (skipped.length) {
    // Our own call whose range we cannot resolve (a ref we never issued, or a range the
    // window rule refuses). Saying so beats a silent no-op.
    parts.push(
      `历史里有 ${skipped.length} 个 compress 调用引用了本插件没有发过的 ref(${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? " 等" : ""}),无法按内容结算,已跳过;请用上面给出的范围重新调用。`,
    );
  }
  if (unrecognized.length) {
    // Our own answer without a readable call in front of it: the host replays this tool in a
    // shape nothing here knows. Naming the shape is the only thing that shortens the next
    // report from "折叠没生效" to "这个宿主用 <shape> 重放调用".
    parts.push(
      `历史里有 ${unrecognized.length} 次 compress 已经执行,但读不出对应的调用(宿主用 ${unrecognized.slice(0, 3).join("、")} 重放,或该调用已被截断),这些折叠不会结算;请把这句话连同宿主名反馈给插件作者。`,
    );
  }
  if (rejected.length) {
    // Our own, resolvable call that still cannot settle: say which rule refused it, or the model
    // keeps re-issuing the same call.
    parts.push(
      `上一次折叠请求没有生效:${rejected.slice(0, 3).join(";")}${rejected.length > 3 ? " 等" : ""}。按上面的条件调整范围后再调用。`,
    );
  }
  if (foreign.length) {
    // A session inherited from billion-context: same `mNNNNN` spelling, different numbering,
    // and a summary that describes the range bili saw. Settling it would be a guess.
    parts.push(
      `另有 ${foreign.length} 个 compress 调用来自别的压缩器(${foreign.slice(0, 3).join("、")}${foreign.length > 3 ? " 等" : ""}),它们的 ref 编号不是本插件发的,已跳过;要压缩请用上面给出的范围重新调用。`,
    );
  }
  if (refusal) parts.push(refusal);
  if (nudge) parts.push(nudge);
  return parts.join("\n");
}

export function markerText(fold) {
  const head = `[acp] ${fold.startRef}–${fold.endRef}${fold.topic ? ` ${fold.topic}` : ""}`;
  return `${head}\n${neutralizeMarkers(fold.summary)}`;
}

/** The head line every marker of this fold starts with (`[acp] m00001–m00002 …`). */
function markerHead(fold) {
  return `[acp] ${fold.startRef}–${fold.endRef}`;
}

/**
 * Folds the model is actually reading this turn.
 *
 * Two shapes mean the same thing, and both count: the hook replaces the range with a marker
 * (the anchors are still in the body, `ranges` non-empty), or the client already stored that
 * marker and dropped the originals — then the anchors are gone, `liveRanges` finds nothing, and
 * counting only `ranges` reports a session that folds beautifully as "0 rendered, 5 lost".
 * Measured on the omp lane 2026-11-07: 5 folds, every summary in the visible history, 0 counted.
 */
export function renderedFoldCount({ units, folds, ranges }) {
  const ids = new Set(ranges.map((r) => r.fold.id));
  for (const fold of folds) {
    if (ids.has(fold.id)) continue;
    const head = markerHead(fold);
    if (units.some((u) => String(u.text ?? "").includes(head))) ids.add(fold.id);
  }
  return ids.size;
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
 * The first unit in a span that sits in `set`, or -1.
 *
 * A fold may not reach across a barrier: our own tool record has to stay where the model can read
 * it (#9), and a media unit is unrecoverable the moment it folds (#10).
 */
function firstInSet(set, start, end) {
  if (!set.size) return -1;
  for (let i = start; i <= end; i += 1) if (set.has(i)) return i;
  return -1;
}

/** The one sentence a refused range gets when a barrier sits inside it, naming that barrier. */
function barrierRefusal(label, unit, refs, isMedia) {
  const where = refs[unit.blockId] ?? "?";
  return isMedia
    ? `${label}:范围含媒体消息 ${where}(图片/文件/音频),原文只存文本,折了之后 decompress 也取不回媒体;请把范围收在它之后`
    : `${label}:范围含插件自己的压缩记录 ${where}(压缩/取回/状态的调用或结果),它要留在上下文里说明折过哪些段;请把范围收在它之后`;
}

/**
 * The one judgment an offer and an apply share: a unit a fold can be anchored on.
 *
 * Apply keeps a range only when both endpoints are `stampable`, and a range can only name a unit
 * that carries a ref. An offer that starts on anything else advertises a range that can never
 * settle: measured 2026-11-07, the note offered a start on a tool result, the model folded exactly
 * that range, and apply answered `两端的消息不可折叠` - then offered the same start again (#16,
 * bili #3236's advertise/apply split).
 */
function citable(unit) {
  return Boolean(unit && unit.stampable && unit.ref && !unit.media);
}

/** The first index at or after `from` that a fold may BEGIN on, or `to + 1` when none does. */
function citableStart(units, from, to) {
  let s = Math.max(0, from);
  while (s <= to && !citable(units[s])) s += 1;
  return s;
}

/**
 * The offer must be a span that can actually settle: start after the newest barrier inside it, so
 * the note never advertises a range whose apply would refuse it (#9, the same advertise/apply
 * split bili fixed in #3236). A barrier is our own tool record - a call and its reply, so `i + 1`
 * is the reply, a tool result (#16) - or a media unit apply will not fold across (#10).
 */
function trimPastBarriers(units, window, barriers) {
  for (let i = window.to; i >= window.from; i -= 1) {
    if (!barriers.has(i)) continue;
    const from = citableStart(units, i + 1, window.to);
    return from <= window.to ? { from, to: window.to } : null;
  }
  return window;
}

/**
 * The summary of a fold speaks for the work behind it, so the range has to begin where that work
 * began: a start inside a turn leaves the instruction that asked for the work outside the
 * summary, and the summary then claims a task the reader cannot find the request for (#11).
 *
 * Both boundaries are pushed out to the enclosing turn edges. When that would leave `[lower,
 * upper]` the turn is dropped whole instead of being cut - a half turn keeps exactly the lie the
 * mid-turn start had, and the remaining turns are still complete. `null` means no whole turn
 * fits, which the caller reports rather than folds.
 */
export function alignToTurns(units, start, end, lower, upper, starts = turnStarts(units, units.length)) {
  const last = units.length - 1;
  const startOf = (i) => {
    let s = starts.length ? starts[0] : 0;
    for (const t of starts) if (t <= i) s = t;
    return Math.min(s, last);
  };
  const endOf = (i) => {
    for (const t of starts) if (t > i) return t - 1;
    return last;
  };
  let s = startOf(start);
  let e = endOf(end);
  if (s < lower) {
    // The turn holding `start` begins before the window: take the next whole turn instead.
    const next = starts.find((t) => t >= lower);
    if (next === undefined) return null;
    s = next;
  }
  if (e > upper) {
    // The turn holding `end` closes after the window: end at the previous whole turn.
    let prev = -1;
    for (const t of [...starts, units.length]) {
      const close = t - 1;
      if (close <= upper && close > prev) prev = close;
    }
    if (prev < 0) return null;
    e = prev;
  }
  if (s > end || e < start || s > e) return null;
  return { start: s, end: e };
}

/** Whether `i` closes the turn it sits in, so a fold may end there even on a tool result. */
function atTurnEnd(units, i, starts = turnStarts(units, units.length)) {
  let next = -1;
  for (const t of starts) if (t > i) { next = t; break; }
  return next > 0 ? next - 1 === i : i === units.length - 1;
}

/** The newest unit a range can END at without dragging its tool result past `cap`. */
function citableEnd(units, cap) {
  for (let e = cap; e >= 0; e -= 1) {
    if (!citable(units[e])) continue;
    let x = e;
    while (x + 1 < units.length && (units[x].toolCalls || []).length > 0) x += 1;
    if (x <= cap) return e;
  }
  return -1;
}

/**
 * The foldable window always stops before the input being sent: the newest user message, or
 * everything after the last assistant message, goes out untouched. `keepRecentTurns` additionally
 * preserves that many trailing turns.
 *
 * A turn starts at a user message or at an assistant message that answers tool output. Counting
 * user messages alone protected the entire history on an agentic host - omp spends a single user
 * turn on hundreds of tool steps, so its 3,488 units landed inside the protected tail, the window
 * shrank to one unit, and the body grew to 1.28M tokens until the provider refused it.
 */
function turnStarts(units, end) {
  const starts = [];
  for (let i = 0; i < end; i += 1) {
    if (units[i].role === "user") starts.push(i);
    else if (units[i].role === "assistant" && i > 0 && units[i - 1].role === "tool") starts.push(i);
  }
  return starts;
}

function foldWindow(units, keepRecentTurns) {
  let lastAssistant = -1;
  let lastUser = -1;
  for (let i = units.length - 1; i >= 0 && (lastAssistant < 0 || lastUser < 0); i -= 1) {
    if (lastAssistant < 0 && units[i].role === "assistant") lastAssistant = i;
    if (lastUser < 0 && units[i].role === "user") lastUser = i;
  }
  const input = lastAssistant < 0 ? 0 : lastUser > lastAssistant ? lastUser : lastAssistant + 1;
  if (input <= 0) return null;
  const starts = turnStarts(units, input);
  const keep = Math.max(0, Number(keepRecentTurns) || 0);
  const boundary = keep > 0 && starts.length > keep ? starts[starts.length - keep] : -1;
  let to = boundary >= 0 ? citableEnd(units, boundary - 1) : -1;
  // Never protect the whole history: a window of zero cannot fold, and a session that cannot
  // fold grows until the provider refuses it. The input alone is then the protected tail.
  if (to < 0) to = citableEnd(units, input - 1);
  if (to < 0) return null;
  // A window may only name units a fold can cite. System/developer prompts are never numbered,
  // so a window that starts at index 0 hands the model `undefined` as its first ref - a range it
  // cannot possibly call compress with. Tool calls and results carry a ref but are endpoints
  // apply refuses, so the start is the first unit that passes the same judgment apply uses.
  const from = citableStart(units, 0, to);
  if (from > to) return null;
  return { from, to };
}

export function planFolds({ units, refs, session, cfg, now = Date.now() }) {
  const idToIndex = new Map();
  for (const unit of units) {
    const ref = refs[unit.blockId];
    if (ref) idToIndex.set(ref, unit.index);
  }
  const window0 = foldWindow(units, cfg.keepRecentTurns);
  // Barriers are not just refusals: a range may not reach across one, and the offer may not start
  // before the newest one. Our own tool traffic is one kind (#9); a media unit is the other,
  // because the store keeps text only - folding it makes the picture unrecoverable (#10).
  const barriers = new Set();
  const media = new Set();
  for (let i = 0; i < units.length; i += 1) {
    if (ownToolUnit(units[i])) barriers.add(i);
    if (units[i].media) { barriers.add(i); media.add(i); }
  }
  const window = window0 ? trimPastBarriers(units, window0, barriers) : null;
  // Turn boundaries are read once: an apply loop can carry hundreds of calls, and each one would
  // otherwise rescan the history to find the turn it sits in.
  const turns = turnStarts(units, units.length);
  const created = [];
  const unresolved = [];
  const foreign = [];
  // A refused call is the quietest failure this plugin has: the tool already told the model the
  // fold would settle next request, and then it silently does not. Every branch below that would
  // drop a call records the reason, so the next request can say it out loud.
  const rejected = [];
  const windowRefs = window ? `${refs[units[window.from]?.blockId] ?? "?"}–${refs[units[window.to]?.blockId] ?? "?"}` : "";
  // The window ends at a citable message, and a range that ends there keeps its own tool result:
  // the pair belongs to the same side of the cut, so it may reach one unit past the end.
  const windowEnd = window ? pairSafe(units, window.to, window.to).end : -1;
  // A call the model already moved past is not a live complaint: once a later fold has settled,
  // an older failing call is history, and repeating its refusal every turn is noise the model
  // pays for (measured 2026-11-07: a rejected 28-byte call kept re-announcing itself long after
  // the range had been folded successfully).
  const settled = session.folds();
  const settledEnd = settled.length ? idToIndex.get(settled[settled.length - 1].endRef) : undefined;
  // A range that a settled fold already covers needs nothing more: re-folding it with a second
  // summary would replace the same span twice, and re-reporting its refusal is noise. Ranges can
  // leave this window (the client truncates), so coverage is matched against the folds we own.
  const coveredBySettled = (startIndex, endIndex) =>
    settled.some((fold) => {
      const a = idToIndex.get(fold.startRef);
      const b = idToIndex.get(fold.endRef);
      return a !== undefined && b !== undefined && startIndex >= a && endIndex <= b;
    });
  const coveringFoldOf = (index) =>
    settled.find((fold) => {
      const a = idToIndex.get(fold.startRef);
      const b = idToIndex.get(fold.endRef);
      return a !== undefined && b !== undefined && index >= a && index <= b;
    });
  // The note must never advertise a start that a settled fold already covers: a model that folds
  // the advertised range again produces a nested summary, which liveRanges then drops as an
  // overlap — the work is lost and the next note advertises the same stale start (measured
  // 2026-11-07 in this session: covered m00387–m00709 was still advertised as the fold start).
  // Holes stay foldable: the first index past every covering span, not past the newest fold.
  const firstUncoveredFrom = (from, to) => {
    let i = from;
    while (i <= to) {
      const cover = coveringFoldOf(i);
      if (!cover) return i;
      i = Number(idToIndex.get(cover.endRef)) + 1;
    }
    return to + 1;
  };
  // A window whose whole span sits under the fold floor is not an offer, it is a trap: measured
  // 2026-11-07 on the claude lane, the note advertised a 3,410-byte single-unit window, the model
  // folded exactly that and got a size refusal, widened the range, and hit the window refusal —
  // two calls spent on a range nothing could ever settle. The floor and the span both start at
  // the first citable unit: skipping a settled fold can land on the tool result that answered a
  // call inside it, and that unit is no more foldable than the record it follows (#16).
  const foldable = window
    ? (() => {
        const from0 = citableStart(units, firstUncoveredFrom(window.from, window.to), window.to);
        if (from0 > window.to) return null;
        const aligned = alignToTurns(units, from0, window.to, window.from, windowEnd, turns);
        if (!aligned) return null;
        const from = citableStart(units, Math.max(aligned.start, window.from), aligned.end);
        if (from > aligned.end) return null;
        const spanBytes = units.slice(from, aligned.end + 1).reduce((n, u) => n + utf8Bytes(u.text), 0);
        if (spanBytes < Number(cfg.minRangeBytes)) return null;
        return { from, to: aligned.end };
      })()
    : null;
  for (const call of compressCalls(units)) {
    if (settledEnd !== undefined && call.unitIndex < settledEnd) continue;
    if (call.unreadable) {
      // The one report that turns a lane's silent no-fold into a sentence a reader can act on:
      // it names the shape the host used, so a new client costs one line of diagnosis.
      const where = refs[units[call.unitIndex]?.blockId] ?? "?";
      const args = (units[call.unitIndex]?.toolCalls || []).find((c) => String(c?.name ?? "") === call.name)?.input;
      const target = deviceTarget(call.name, args);
      rejected.push(
        target
          ? `${where}:调用被重放成设备调用(${call.name} → ${target}),载荷不是可读的 content,settle 不了`
          : `${where}:调用形状为 ${call.name || "?"},载荷读不出来(要么写在脚本里且不是字面量,要么参数不是 compress 的 content),settle 不了`,
      );
      continue;
    }
    if (!call.acknowledged) {
      for (const entry of call.entries) foreign.push(`${String(entry.startId).trim()}–${String(entry.endId).trim()}`);
      continue;
    }
    for (const entry of call.entries) {
      const label = `${String(entry.startId).trim()}–${String(entry.endId).trim()}`;
      const startIndex = idToIndex.get(String(entry.startId).trim());
      const endIndex = idToIndex.get(String(entry.endId).trim());
      if (startIndex === undefined || endIndex === undefined) {
        unresolved.push(label);
        continue;
      }
      if (startIndex > endIndex) {
        rejected.push(`${label}:起点在终点之后`);
        continue;
      }
      if (!citable(units[startIndex]) || !(citable(units[endIndex]) || atTurnEnd(units, endIndex, turns))) {
        rejected.push(`${label}:两端的消息不可折叠(工具调用或工具结果)`);
        continue;
      }
      // Barriers answer on the range the model wrote: "your range holds media" is something it can
      // act on, while widening first would report a window complaint instead (#9, #10).
      const raw = pairSafe(units, startIndex, endIndex);
      const rawMedia = firstInSet(media, raw.start, raw.end);
      if (rawMedia >= 0) {
        rejected.push(barrierRefusal(label, units[rawMedia], refs, true));
        continue;
      }
      const rawBarrier = firstInSet(barriers, raw.start, raw.end);
      if (rawBarrier >= 0) {
        rejected.push(barrierRefusal(label, units[rawBarrier], refs, false));
        continue;
      }
      // A start inside a span that already settled is answered with where to start instead, and
      // checked on the range as written: widening would swallow the whole span and go silent.
      if (coveredBySettled(startIndex, endIndex)) continue;
      const rawCover = coveringFoldOf(startIndex);
      if (rawCover !== undefined) {
        const coverEnd = Number(idToIndex.get(rawCover.endRef));
        rejected.push(`${label}:起点落在已结算的折叠 ${rawCover.startRef}–${rawCover.endRef} 里,请从 ${refs[units[coverEnd + 1]?.blockId] ?? "该折叠之后"} 开始`);
        continue;
      }
      // The range is widened to whole turns before anything else looks at it (#11): a summary that
      // starts mid-turn speaks for work whose instruction it does not contain. A range that cannot
      // be aligned without leaving the window or cutting a turn is refused, never trimmed.
      const aligned = alignToTurns(units, startIndex, endIndex, window ? window.from : 0, windowEnd >= 0 ? windowEnd : units.length - 1, turns);
      if (!aligned) {
        rejected.push(`${label}:范围对不齐整轮(起点所在的轮在窗口外,或终点所在的轮超出窗口),请从某一轮的起点开始`);
        continue;
      }
      if (coveredBySettled(aligned.start, aligned.end)) continue;
      const safe = pairSafe(units, aligned.start, aligned.end);
      // Widening can drag a barrier into the span that the model's own range did not cover.
      const held = firstInSet(media, safe.start, safe.end);
      if (held >= 0) {
        rejected.push(barrierRefusal(label, units[held], refs, true));
        continue;
      }
      const barrier = firstInSet(barriers, safe.start, safe.end);
      if (barrier >= 0) {
        rejected.push(barrierRefusal(label, units[barrier], refs, false));
        continue;
      }
      const cover = coveringFoldOf(safe.start);
      if (cover !== undefined) {
        const coverEnd = Number(idToIndex.get(cover.endRef));
        rejected.push(`${label}:起点落在已结算的折叠 ${cover.startRef}–${cover.endRef} 里,请从 ${refs[units[coverEnd + 1]?.blockId] ?? "该折叠之后"} 开始`);
        continue;
      }
      if (window && (safe.start < window.from || safe.end > windowEnd)) {
        rejected.push(`${label}:超出可折叠窗口(${windowRefs}),最近的 ${Number(cfg.keepRecentTurns) || 0} 轮要留着`);
        continue;
      }
      const inRange = units.slice(safe.start, safe.end + 1);
      const bytes = inRange.reduce((n, u) => n + utf8Bytes(u.text), 0);
      const floor = Number(cfg.minRangeBytes);
      if (bytes < floor) {
        rejected.push(`${label}:这段只有 ${bytes} 字节,低于 minRangeBytes=${floor}`);
        continue;
      }
      // The summary is the only thing left of the range afterwards, so a couple of characters is
      // not a summary, it is a deletion with a receipt. A real client folded 45,542 bytes into the
      // two-byte topic word "填充" before this floor existed.
      const summary = String(entry.summary || "").slice(0, Number(cfg.maxSummaryChars));
      if (!summary.trim()) {
        rejected.push(`${label}:摘要为空`);
        continue;
      }
      const summaryBytes = utf8Bytes(summary);
      if (summaryBytes < MIN_SUMMARY_BYTES) {
        rejected.push(`${label}:摘要只有 ${summaryBytes} 字节,至少要 ${MIN_SUMMARY_BYTES} 字节;被折叠的原文之后只剩摘要`);
        continue;
      }
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
        summaryBytes,
        at: now,
        bytes,
        blocks: inRange.map((u) => ({ blockId: u.blockId, ref: refs[u.blockId], role: u.role, text: neutralizeMarkers(u.text) })),
      });
    }
  }
  const unrecognized = unknownShapes(units, compressCalls(units));
  return { created, window, foldable, unresolved: [...new Set(unresolved)], foreign: [...new Set(foreign)], rejected: [...new Set(rejected)], unrecognized: [...new Set(unrecognized)] };
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
    // A one-unit range is a real range: models do compress a single message, and dropping
    // `start === end` here silently ignored exactly that fold.
    if (start === undefined || end === undefined || start > end) continue;
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
    // Every gate below returns the request untouched. That silence is the hardest thing to
    // debug from the outside - a client sees no refs and no fold and nothing says why - so
    // under `debug` each one names itself before it steps aside.
    if (!cfg.enabled) {
      recordSkip(cfg.storeDir, sessionKeyOf(ctx), { reason: "开关关着", detail: "enabled=false" });
      if (cfg.debug) console.error("[magpie-acp-context] skip: the plugin is off");
      return undefined;
    }
    // Canary gate: an agent left out of the list never reaches the store, so its requests
    // are byte-identical to what the client sent.
    if (!allowsAgent(cfg, ctx) || !allowsOrigin(cfg, ctx)) {
      recordSkip(cfg.storeDir, sessionKeyOf(ctx), {
        reason: "canary 名单不收这个调用方",
        detail: `agent=${ctx?.agent ?? "?"} origin=${ctx?.origin ?? "?"}`,
      });
      if (cfg.debug) console.error(`[magpie-acp-context] skip: agent=${ctx?.agent} origin=${ctx?.origin} is not in the canary list`);
      return undefined;
    }
    // Tool gate: the prompt asks for a tool magpie serves, so a client that declares tools,
    // none of ours, and no code surface that could reach them can never obey it - it only
    // pays for the prompt and the `[mNNNNN]` prefixes while nothing can ever fold. A request
    // with no declaration list at all is not evidence either way (older hosts, probes) and
    // is served as before.
    const declared = advertisedToolNames(body);
    if (declared && !canCallOwnTools(declared)) {
      recordSkip(cfg.storeDir, sessionKeyOf(ctx), {
        reason: "工具门:声明的工具没有一个能到本插件",
        detail: declared.slice(0, 6).join(","),
      });
      if (cfg.debug) console.error(`[magpie-acp-context] skip: none of the ${declared.length} declared tools can reach ours: ${JSON.stringify(declared.slice(0, 12))}`);
      return undefined;
    }
    const adapter = adapterFor(ctx?.protocol);
    if (!adapter || !adapter.unitArray(body)) {
      recordSkip(cfg.storeDir, sessionKeyOf(ctx), { reason: "这个协议的请求体读不出消息", detail: String(ctx?.protocol ?? "?") });
      if (cfg.debug) console.error(`[magpie-acp-context] skip: protocol ${ctx?.protocol} has no readable body`);
      return undefined;
    }

    let units = adapter.read(body);
    if (units.length === 0) return undefined;

    const session = openSession(cfg.storeDir, sessionKeyOf(ctx));

    // The cap (wayfinder #18): one unit big enough to sink the request on its own. It runs
    // before refs are assigned so the ledger numbers the text actually sent, and it stores the
    // original before it cuts, because `decompress` is the only way back: a cut whose original
    // failed to store is abandoned rather than made. `fallback: "off"` leaves the request
    // byte-identical, and every exempt unit (media, own records, markers, ref-bearing prose) is
    // named in `clipBlocker` rather than checked here.
    const plan = cfg.fallback === "off" ? { candidates: [], exempt: [] } : planClips({ units, cfg });
    const clips = [];
    const clipRefusals = [];
    let sent = body;
    for (const candidate of plan.candidates) {
      const marker = (omitted) => clipMarker({ blockId: candidate.blockId, omitted });
      const stored = session.withLock(() =>
        session.storeOriginal(candidate.blockId, { role: candidate.role, text: candidate.text, at: Date.now() }),
      );
      if (!stored) {
        clipRefusals.push({ at: Date.now(), id: candidate.blockId, role: candidate.role, beforeBytes: utf8Bytes(candidate.text), reason: "原文写不进存储,这一条不裁" });
        continue;
      }
      const nextBody = sent === body ? structuredClone(body) : sent;
      const cut = adapter.clipInto(nextBody, candidate.index, { keepChars: candidate.keepChars, marker });
      if (!cut.ok) {
        clipRefusals.push({ at: Date.now(), id: candidate.blockId, role: candidate.role, beforeBytes: utf8Bytes(candidate.text), reason: cut.reason });
        continue;
      }
      sent = nextBody;
      clips.push({
        at: Date.now(),
        id: candidate.blockId,
        role: candidate.role,
        beforeBytes: utf8Bytes(candidate.text),
        afterBytes: utf8Bytes(cut.text),
        omitted: cut.omitted,
        reason: "cap",
      });
    }
    // A clip changes the text the pipeline reads, so re-read rather than patching: the projection
    // rules (a `tool_result ` prefix, a `[image]` placeholder) live in the adapter, and a second
    // copy of them here would drift the first time a protocol changes.
    if (clips.length) units = adapter.read(sent);
    if (clips.length || clipRefusals.length) {
      session.withLock(() => session.recordClips(clips, clipRefusals));
      if (cfg.debug && (clips.length || clipRefusals.length)) {
        console.error(`[magpie-acp-context] cap: ${clips.length} 条裁了${clipRefusals.length ? `,${clipRefusals.length} 条没裁成(${clipRefusals.map((r) => r.reason).join(";")})` : ""}`);
      }
    }

    const ids = unitIds(units);

    // A ref is the only way a compress range can name a unit, so leaving system/developer
    // prompts unnumbered makes them unfoldable by construction rather than by a check.
    const refIds = ids.filter((_, i) => units[i].role !== "system" && units[i].role !== "developer");
    const refs = session.withLock(() => session.assignRefs(refIds, (n) => formatRef(n, cfg.refFormat)));
    for (let i = 0; i < units.length; i += 1) units[i].blockId = ids[i];
    for (let i = 0; i < units.length; i += 1) units[i].ref = refs[ids[i]];

    const { created, window, foldable, unresolved, foreign, rejected, unrecognized } = planFolds({ units, refs, session, cfg });
    if (cfg.debug) console.error("[magpie-acp-context] plan", JSON.stringify({ session: sessionKeyOf(ctx), units: units.length, calls: compressCalls(units).length, window, foldable, created: created.length, clips: clips.length, clipRefusals, unresolved, foreign, rejected, unrecognized, folds: session.folds().length }));
    if (created.length) {
      session.withLock(() => session.recordFolds(created, ({ blockId, role, text }) => session.storeOriginal(blockId, { role, text, ref: refs[blockId], at: Date.now() })));
    }
    const ranges = liveRanges({ units, folds: session.folds(), window });
    // Said in the transcript only when it is actionable (a proven ceiling, or the repetition that
    // marks a stuck session): a one-off cancel is noise a model would pay for on every turn.
    const refusal = session.refusal();

    // Tokens: the billed prompt of the last reply when there is one (it is the only
    // number the provider actually counted), never smaller than this body's own size,
    // because a retry or a fresh session has no reply behind it yet.
    const lastUsage = session.lastUsage();
    const bodyTokens = estimateBodyTokens(sent);
    const contextTokens = Math.max(bodyTokens, Number(lastUsage?.input) || 0);

    const foldedBytes = session.folds().reduce((n, f) => n + (Number(f.bytes) || 0), 0);
    const sinceGrowth = Math.max(0, contextTokens - Math.round(foldedBytes / 3.5));
    // Counted, not clocked: two replies inside the same millisecond must still be two replies.
    const answeredSince = session.state.usage.length > Number(session.nudge()?.usageCount ?? 0);
    const decision = decideNudge({
      cfg,
      sinceGrowth,
      lastNudge: session.nudge(),
      folds: session.folds().length,
      answeredSince,
    });
    const nudge =
      cfg.mode === "assist" && decision.kind !== NUDGE_NONE && !decision.repeat
        ? nudgeText(
            {
              since: decision.since,
              growthFloor: decision.growthFloor,
              range: foldable ? `${units[foldable.from]?.ref}–${units[foldable.to]?.ref}` : "",
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
      bytes: utf8Bytes(JSON.stringify(sent)),
      tokens: contextTokens,
      billed: Number(lastUsage?.input) || 0,
      folds: session.folds().length,
      // Rendered this turn vs merely on file: a fold the client's own compaction shook loose
      // renders nothing, and reporting it as "late" instead of "dormant" is a lie in two places.
      applied: renderedFoldCount({ units, folds: session.folds(), ranges }),
      foldableFrom: foldable ? units[foldable.from]?.ref ?? null : null,
      foldableTo: foldable ? units[foldable.to]?.ref ?? null : null,
      rejected: rejected.slice(0, 3),
      unresolved: unresolved.slice(0, 3),
      unrecognized: unrecognized.slice(0, 3),
      foreign: foreign.length,
      // The cap is the hook's own work, so it is reported next to the fold count rather than
      // mixed into it: "0 folds" and "0 folds, 2 clips" are different answers to "is anything
      // actually shrinking this session?".
      clips: clips.length,
      clipBytes: clips.reduce((n, c) => n + Math.max(0, c.beforeBytes - c.afterBytes), 0),
      clipRefused: clipRefusals.slice(0, 3),
    });
    session.save();

    if (Date.now() - started > cfg.budgetMs) return undefined;

    const next = structuredClone(sent);

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
        foldableFrom: foldable ? units[foldable.from]?.ref : null,
        foldableTo: foldable ? units[foldable.to]?.ref : null,
        nudge,
        skipped: unresolved,
        foreign,
        rejected,
        unrecognized,
        refusal: refusalNote(refusal),
        minRangeBytes: cfg.minRangeBytes,
      });
      if (cfg.injectStyle === "system-suffix") adapter.appendSystem(next, note);
      else adapter.appendNote(next, note);
    }

    if (JSON.stringify(next) === JSON.stringify(body)) return undefined;
    return next;
  } catch (err) {
    // A gateway hook may never break the request, so this stays a log rather than a throw.
    try {
      recordSkip((cfg ?? loadConfig(ctx?.options)).storeDir, sessionKeyOf(ctx), {
        reason: "钩子自己出错,这一轮原样放行",
        detail: String(err?.message ?? err).slice(0, 160),
      });
    } catch {
      // failOpen has to survive even a broken error path
    }
    if (cfg?.debug) console.error("[magpie-acp-context] onRequest failed:", err);
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
    if (!usage && ctx?.success !== false) return;
    const session = openSession(cfg.storeDir, sessionKeyOf(ctx));
    // A session the hook never served has nothing to record usage FOR: either the request
    // gate above skipped this client (no declaration of our tools) or this is a reply to a
    // request that never reached the hook. Writing usage here would create a store entry for
    // a client that is byte-identically proxied, and its file would never fold anything.
    if (!session.existed) return;
    // A refused turn has no usage, and it is the only evidence that this session is already too
    // big for its window - the model never saw the nudge, so no fold can ever settle.
    if (ctx?.success === false) {
      const refusal = readRefusal(reply);
      session.withLock(() => {
        session.recordRefusal({
          at: Date.now(),
          protocol: ctx?.protocol ?? null,
          model: ctx?.model ?? null,
          tokens: Number(session.state.request?.tokens) || 0,
          seq: session.state.request?.seq ?? null,
          ...refusal,
        });
        session.save();
      });
      if (cfg.debug) console.error("[magpie-acp-context] refused:", refusal.text || "(the gateway forwards no reason on a failed turn)", "size≈", refusal.tokens ?? 0);
      return;
    }
    session.withLock(() => {
      session.clearRefusal();
      session.recordUsage({ ...usage, at: Date.now(), model: ctx?.model ?? null, seq: session.state.request?.seq ?? null });
      session.save();
    });
  } catch (err) {
    if (cfg?.debug) console.error("[magpie-acp-context] onResponse failed:", err);
    if (cfg?.failOpen === false) throw err;
  }
}

export default { onRequest, onResponse };
