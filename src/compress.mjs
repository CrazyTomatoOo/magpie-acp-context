/**
 * Reading the model's own compress calls out of the transcript.
 *
 * The proxy never invents a summary: a fold exists only because a tool call with real
 * summary text is visible in the history. That is also why every shape bili accepts
 * has to be accepted here — the client's tool result does not carry the summary.
 */

export const COMPRESS_ACK = "折叠会在下一次请求时按历史里真实的 ref 结算";

export const COMPRESS_TOOL_NAMES = new Set([
  "compress",
  "compress_context",
  "compact",
  "compact_context",
  "compress_history",
  "acp_compress",
]);

/** The plugin's own name in package.json: magpie serves `<plugin>_<tool>`. */
const OWN_PREFIX = "magpie-acp-context";

/**
 * Some wires flatten a name before it reaches the transcript (`_mcp__magpie_acp_context_compress`:
 * leading underscore, dots and dashes folded to underscores), so the separators that identify a
 * name are not the ones the client was given. Compare on a canonical form, keeping the rule that
 * the plugin's own prefix must appear - another server's `foo_compress` is not our call.
 */
const canonical = (name) => name.replace(/[-.\s]+/g, "_").replace(/^_+/, "");

export function isCompressToolName(name) {
  const raw = String(name ?? "").toLowerCase().trim();
  if (!raw) return false;
  const full = canonical(raw);
  const own = canonical(OWN_PREFIX);
  if (COMPRESS_TOOL_NAMES.has(full)) return true;
  // Whatever a client wraps around the served name - an MCP prefix, a flattened one - the name
  // it wraps still sits inside, with the tool as its tail.
  const at = full.lastIndexOf(`${own}_`);
  if (at < 0) return false;
  const tail = full.slice(at + own.length + 1);
  if (COMPRESS_TOOL_NAMES.has(tail)) return true;
  return tail.startsWith("mcp__") && isCompressToolName(tail.slice(5));
}

const FENCE = /^```[a-zA-Z]*\s*|\s*```$/g;

/**
 * Whether a name belongs to this plugin at all (not just to its compress tool).
 *
 * Matching stays the same lenient canonical form `isCompressToolName` uses, because the
 * wrapping differs per wire (`magpie-acp-context_compress`,
 * `_mcp__magpie_acp_context_compress`, `mcp__magpie__magpie-acp-context_decompress`).
 */
export function isOwnToolName(name) {
  const raw = String(name ?? "").toLowerCase().trim();
  if (!raw) return false;
  return canonical(raw).includes(`${canonical(OWN_PREFIX)}_`);
}

/**
 * Tool names that can reach MCP tools without declaring them.
 *
 * A client does not have to list our tools to be able to call them: omp (the magpie lane's
 * host) declares `read`/`bash`/`eval` and reaches every MCP tool through `eval`, so a gate
 * that demanded our names in `tools[]` would switch compression off for exactly the client
 * this plugin was written for. Shell and code surfaces can also POST to the gateway's own
 * `/mcp/magpie/tools` endpoint directly.
 */
const EXEC_SURFACES = new Set([
  "eval",
  "run_code",
  "run_command",
  "code_interpreter",
  "execute",
  "exec",
  "bash",
  "shell",
  "terminal",
  "python",
  "node",
]);

/** Whether a client declaring these tools could call this plugin's tools at all. */
export function canCallOwnTools(names) {
  return names.some((name) => {
    const full = canonical(String(name ?? "").toLowerCase().trim());
    if (!full) return false;
    if (isOwnToolName(full)) return true;
    if (EXEC_SURFACES.has(full)) return true;
    return EXEC_SURFACES.has(full.replace(/^(mcp__)?[a-z0-9]+_+/, ""));
  });
}

function stripFences(s) {
  return String(s).replace(FENCE, "").trim();
}

function normalizeEntry(entry) {
  if (typeof entry === "string") return null;
  if (!entry || typeof entry !== "object") return null;
  const startId = entry.startId ?? entry.startRef ?? entry.start ?? entry.from;
  const endId = entry.endId ?? entry.endRef ?? entry.end ?? entry.to;
  const summary = entry.summary ?? entry.content ?? entry.text;
  if (!startId || !endId || !summary) return null;
  return { startId: String(startId).trim(), endId: String(endId).trim(), topic: entry.topic ?? entry.title ?? "", summary: String(summary) };
}

/** "m00182–m00220 Auth 重写\n正文…" -> one entry */
function parseLine(line) {
  const m = /^([mM]\d{1,9})\s*[-~–—]\s*([mM]\d{1,9})\s*[:：]?\s*(.*)$/s.exec(line.trim());
  if (!m) return null;
  const rest = m[3].trim();
  const nl = rest.indexOf("\n");
  const topic = nl === -1 ? rest : rest.slice(0, nl).trim();
  const summary = nl === -1 ? rest : rest.slice(nl + 1).trim();
  if (!summary) return null;
  return { startId: m[1], endId: m[2], topic, summary };
}

export function parseCompressPayload(raw) {
  let value = raw;
  if (typeof value === "string") {
    const text = stripFences(value);
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
  }
  // A wrapper the advertised schema uses: {content: "<lines>"} or {content: [...]}
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.content === "string" && !value.summary) {
    return parseCompressPayload(value.content);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.ranges)) {
    return value.ranges.map(normalizeEntry).filter(Boolean);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && value.content && Array.isArray(value.content)) {
    return value.content.map(normalizeEntry).filter(Boolean);
  }
  if (Array.isArray(value)) {
    const objects = value.map(normalizeEntry).filter(Boolean);
    if (objects.length) return objects;
    return value
      .map((line) => (typeof line === "string" ? parseLine(line) : null))
      .filter(Boolean);
  }
  const flat = normalizeEntry(value);
  if (flat) return [flat];
  if (typeof value === "string") {
    return value.split(/\n{2,}/).map(parseLine).filter(Boolean);
  }
  return [];
}

/** Our tool answers every call with this sentence; another compressor cannot produce it. */
function acknowledges(units, index) {
  const stop = Math.min(units.length, index + 4);
  for (let i = index + 1; i < stop; i += 1) {
    if (String(units[i].text || "").includes(COMPRESS_ACK)) return true;
  }
  return false;
}

/**
 * Every compress call visible in this history, oldest first.
 *
 * Settling a call means folding the range its refs name onto the summary it carries, so a
 * call this plugin did not execute must never be settled: an inherited billion-context
 * session shares the mNNNNN spelling but not the numbering, and adopting one would paste a
 * summary of other content over the wrong range.
 */
export function compressCalls(units) {
  const calls = [];
  for (const unit of units) {
    for (const call of unit.toolCalls || []) {
      if (!isCompressToolName(call?.name)) continue;
      const entries = parseCompressPayload(call.input);
      if (entries.length) {
        calls.push({ unitIndex: unit.index, entries, acknowledged: acknowledges(units, unit.index) });
      }
    }
  }
  return calls;
}
