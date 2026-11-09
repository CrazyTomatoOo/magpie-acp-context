import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFolds } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

/**
 * The skeleton every history fixture shares. It was copied into eight test files and one copy was
 * wrong in a way no assertion could see: a history whose first unit is an assistant message has no
 * turn start at index 0, so `alignToTurns` silently snapped the requested range to a later turn
 * and the test measured something other than what its name said (#14 retro).
 */

export const filler = (n) => "填充文本,内容重复,记住结论就够。".repeat(n);
export const pad = (n) => "x".repeat(n);

/** A fold marker as it looks in the client's history: no stamp, because the client sent it. */
export const marker = (start, end, body, label = "早期") => `[acp] ${start}–${end} ${label}\n${body}`;

/** What a compress call carries: the ref range, a label line, then the summary. */
export const foldInput = (range, summary, label = "早期") => ({ content: `${range} ${label}\n${summary}` });

/** The tool reply the runtime writes back; the tool itself never touches history. */
export const ACK = `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。`;

/** The two sentences fixtures summarize with, so a rename of the note text cannot drift here. */
export const SUMMARY_FILLER = "读了几轮文件,结论是填充文本,不需要逐字保留,后来的人知道这一点就够继续了。";
export const SUMMARY_EARLY = "早期需求是把方案讲清楚,这件事已经做完,结论记在这儿。";

/** One unit, with `stampable` derived the way the wires derive it: tool traffic and empty text are not history. */
export function unit(role, text, { media = false, toolCalls = [] } = {}) {
  return { role, text, stampable: role !== "tool" && text.trim() !== "" && toolCalls.length === 0, media, toolCalls };
}

/**
 * Rows to units, in ledger order. Rows are `[role, text, stampable, toolCalls]` tuples or already
 * built units. The guard is the point: a fixture must open on a user turn, or the first turn has
 * no start and `alignToTurns` measures the wrong range.
 */
export function transcript(rows, { prefix = "b" } = {}) {
  if (!rows.length) throw new Error("a fixture needs at least one unit");
  const first = Array.isArray(rows[0]) ? rows[0][0] : rows[0].role;
  if (first !== "user") {
    throw new Error(
      `a fixture must open on a user turn, got "${first}": its first turn has no start, so a range inside it cannot be widened to a whole turn (#11)`,
    );
  }
  return rows.map((row, index) => {
    const u = Array.isArray(row) ? { role: row[0], text: row[1], stampable: row[2], toolCalls: row[3] ?? [] } : row;
    return { ...u, media: u.media === true, index, blockId: `${prefix}${index}`, ref: `m${String(index + 1).padStart(5, "0")}` };
  });
}

/** `planFolds` with the numbers the gate tests settled on: a small floor so fixtures stay short. */
export function planOf(units, { keepRecentTurns = 1, minRangeBytes = 40, maxSummaryChars = 20000 } = {}) {
  const refs = Object.fromEntries(units.map((u) => [u.blockId, u.ref]));
  return planFolds({ units, refs, session: { folds: () => [] }, cfg: { keepRecentTurns, minRangeBytes, maxSummaryChars } });
}

export const tempStore = (prefix = "acp-test-") => mkdtempSync(join(tmpdir(), prefix));

/** The options a wire-level test needs: one small turn's worth of protection, a store of its own. */
export const wireOptions = (dir, over = {}) => ({ enabled: true, keepRecentTurns: 1, minRangeBytes: 1, store: { dir }, ...over });

/** A compress call as a client sends it, and the reply the runtime writes back. */
export const compressCall = (id, range, summary = SUMMARY_EARLY) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "compress", arguments: JSON.stringify(foldInput(range, summary)) } }],
});

export const compressAck = (id) => ({ role: "tool", tool_call_id: id, content: ACK });
