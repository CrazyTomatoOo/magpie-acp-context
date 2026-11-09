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
export function planClips({ units = [], cfg = {} } = {}) {
  const capTokens = positive(cfg?.cap?.unitTokens, 32000);
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
