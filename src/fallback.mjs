/**
 * The fallback, first leg: the cap.
 *
 * Advice is not a mechanism. A session can outgrow its window while every request carries a
 * perfect nudge, because the model never has to obey it - and one unit can blow a request on
 * its own: a tool result inside the *current* turn cannot be saved by dropping history.
 *
 * So the hook cuts. It cuts one unit, not a range, and only after the original is on disk:
 * `decompress` is the only way back, so a cut whose original failed to store is abandoned
 * rather than made. What is left in the transcript is the first and last `keepChars`
 * characters plus a marker naming the block id - never the `[acp] mNNNNN–mNNNNN` fold shape,
 * because a clip is not a summary and a reader must not confuse one for the other.
 *
 * Who is exempt, and why:
 *   - media units: the text projection carries `[image]`, so a cut would drop the picture
 *     without any store holding it (`src/protocol.mjs` `isMediaPart`);
 *   - our own tool records: they are the ack of a fold, not content (`ownToolUnit`);
 *   - `[acp]` markers: an existing marker is already the compressed form;
 *   - any unit carrying a ref: refs are content ids (`src/text.mjs` `blockIdOf`), so a cut
 *     changes the id - the note would advertise a ref that no longer matches any unit, and
 *     `compress` by that ref would stop resolving. Tool results are the units that matter
 *     here and they carry no stamp (`stampable` excludes `role === "tool"`).
 */

import { ownToolUnit } from "./compress.mjs";
import { blockIdOf } from "./text.mjs";
import { estimateTokens } from "./usage.mjs";

/** The prefix every marker this plugin writes starts with (`[acp] `). Escaped, per repo rule. */
export const MARKER_PREFIX = "[acp] ";

function thousands(n) {
  return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * The words a reader sees where the text was. It names the block id, not a ref: tool results
 * have no stamp, and `findBlock` (`src/blocks.mjs`) resolves a bare id, so `decompress <id>`
 * is what puts the original back.
 */
export function clipMarker({ blockId, omitted }) {
  return `${MARKER_PREFIX}已省略 ${thousands(omitted)} 字符,原文 id ${blockId},可用 decompress 取回`;
}

/** Why the cap must not touch this unit, or null when it may. */
export function clipBlocker(unit) {
  if (!unit) return "没有这个单元";
  if (unit.media) return "媒体单元(裁了只剩占位符,原文里也没有第二份)";
  if (ownToolUnit(unit)) return "本插件自己的记录";
  if (String(unit.text ?? "").startsWith(MARKER_PREFIX)) return "已经是 [acp] 标记";
  if (unit.stampable) return "带 ref 的单元(裁了 ref 和原文就对不上)";
  return null;
}

/**
 * Which units are over the cap and may be cut.
 *
 * The cap is measured in tokens on the unit's text projection, because that is the number the
 * request pays for; the cut itself belongs to the protocol adapter, which is the only code
 * that knows where a unit's text physically lives.
 */
export function planClips({ units = [], cfg = {}, capTokens: override = 0 } = {}) {
  const capTokens = positive(override, positive(cfg?.cap?.unitTokens, 32000));
  const keepChars = positive(cfg?.cap?.keepChars, 2000);
  const candidates = [];
  const exempt = [];
  for (const unit of units) {
    const text = String(unit?.text ?? "");
    if (estimateTokens(text) <= capTokens) continue;
    const blocked = clipBlocker(unit);
    if (blocked) {
      exempt.push({ index: unit.index, role: unit.role, reason: blocked });
      continue;
    }
    candidates.push({
      index: unit.index,
      role: unit.role,
      blockId: blockIdOf(`${unit.role}\u0000${text}`),
      text,
      keepChars,
    });
  }
  return { candidates, exempt, capTokens, keepChars };
}

/**
 * The fallback, second leg: the elision.
 *
 * The cap saves a request from one oversized unit. It cannot save a session whose *history* is
 * the problem, and the pass that would - a fold - needs the model to cooperate, which it may
 * simply never do: measured in the container, twenty turns carried a perfect nudge and not one
 * compress call. So when the request is over a known limit, the hook drops the oldest whole
 * turns itself.
 *
 * What it writes is a statement, not a summary, and it must not look like one: no
 * `[acp] mNNNNN–mNNNNN` range (that shape means "a summary stands here"), and the words say
 * mechanically what happened. Every dropped unit keeps its original in the store first, so
 * `decompress` by its ref still returns the text - the elision moves work out of the window,
 * it never destroys it.
 *
 * The window has to be known. A guessed limit is how a hook cuts a request that was fine, so
 * `knownLimit` only believes three sources, in this order: the number a refusal named, the
 * owner's declaration, and the biggest prompt the provider has actually billed. Nothing known
 * means the leg never runs, and `fallback: "cap"` (the default) never runs it either.
 */

/** Where the leg starts, and how far down one pass aims: native's bands, 0.75 hurt, 0.95 bounce. */
export const ELIDE_AT = 0.95;
export const ELIDE_DOWN_TO = 0.75;

/** Over the ratio, a unit this big is also fair game for the second-level cut (2000 + 2000 chars). */
export const SECOND_LEVEL_TOKENS = 2000;

/** Passes that still leave the request over the limit before the host is told to start over. */
export const NEW_SESSION_AFTER = 3;

/**
 * The window, best evidence first. Returns 0 when nothing is known - and 0 is the answer that
 * keeps the leg off, because `0 * ELIDE_AT` is not a threshold, it is a guess.
 */
export function knownLimit({ cfg = {}, ceiling = 0, peak = 0 } = {}) {
  return positive(ceiling, positive(cfg?.contextLimit, positive(peak, 0)));
}

/**
 * What a reader sees where whole turns were dropped. It names the span as refs so the dropped
 * work stays addressable, and it says "mechanical" in as many words, because a reader who
 * mistakes this for a summary will believe details nobody ever wrote down.
 */
export function elideMarker({ startRef, endRef, count }) {
  return `${MARKER_PREFIX}已省略 ${startRef}–${endRef} 共 ${count} 条(机械省略,没有摘要;每条原文都存着,可用 decompress 按 ref 取回)`;
}

/** The head of that marker, so reading the transcript back can give it its span's identity. */
export function elideHead(elision) {
  return `${MARKER_PREFIX}已省略 ${elision.startRef}–${elision.endRef} 共 `;
}

/** Why whole turns may not leave from this unit, or null when they may. */
export function elideBlocker(unit, folded = null) {
  if (unit?.media) return "媒体单元";
  if (ownToolUnit(unit)) return "本插件自己的记录";
  if (String(unit?.text ?? "").startsWith(MARKER_PREFIX)) return "已经是 [acp] 标记";
  if (folded?.has?.(unit.index)) return "这一轮里有正在结算的折叠";
  return null;
}

/**
 * Which whole turns leave, oldest first. The span always starts at `from` — the window the hook
 * passes in already begins right after the newest barrier — so the statement it leaves behind is
 * anchored to a marker or a record rather than sitting in a clean run of turns.
 *
 * `turns` is `turnStarts(units, units.length)`; only turns fully inside `[from, to]` are
 * candidates, so the protected tail and the fold window set the outer bounds and this decides
 * how much of the oldest part goes. The walk stops at the first turn holding a barrier - media,
 * one of our own records, an existing marker, or a span being folded this very request - because
 * skipping it would leave a hole.
 */
export function planElide({ units = [], turns = null, from = 0, to = -1, tokens = 0, target = 0, folded = null } = {}) {
  const starts = Array.isArray(turns) ? turns.filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b) : [];
  if (starts.length === 0) return null;
  if (!(to >= from) || units.length === 0) return null;
  const budget = Math.max(0, Number(target) || 0);
  const inside = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : units.length - 1;
    if (start >= from && end <= to) inside.push({ start, end });
  }
  if (inside.length === 0) return null;
  let projected = Math.max(0, Number(tokens) || 0);
  const dropped = [];
  let droppedTokens = 0;
  for (const turn of inside) {
    if (projected <= budget) break;
    const span = units.slice(turn.start, turn.end + 1);
    const blocked = span.map((unit) => elideBlocker(unit, folded)).find(Boolean);
    // A barrier ends the sweep rather than being skipped: the prefix has to stay contiguous.
    if (blocked) break;
    let cost = 0;
    for (const unit of span) cost += estimateTokens(unit.text);
    dropped.push(turn);
    droppedTokens += cost;
    projected -= cost;
  }
  if (dropped.length === 0) return null;
  return {
    from: dropped[0].start,
    to: dropped[dropped.length - 1].end,
    turns: dropped.length,
    count: dropped.reduce((n, turn) => n + (turn.end - turn.start + 1), 0),
    tokens: droppedTokens,
    projected: Math.max(0, projected),
  };
}
