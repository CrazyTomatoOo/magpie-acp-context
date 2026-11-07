/**
 * Reading the model's own compress calls out of the transcript.
 *
 * The proxy never invents a summary: a fold exists only because a tool call with real
 * summary text is visible in the history. That is also why every shape bili accepts
 * has to be accepted here — the client's tool result does not carry the summary.
 */

// A fold keeps only its summary, so anything shorter than this is a deletion, not a
// compression. Measured against the smallest range worth folding (5,000 bytes), it is still
// a 100:1 cut - the floor is there to catch the empty gesture, not to shape good prose.
export const MIN_SUMMARY_BYTES = 40;

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
 * Every wire spells the served name its own way: Claude Code keeps the MCP wrapper and doubles the
 * underscore (`mcp__magpie-acp-context__compress`), Codex keeps a slash
 * (`magpie-acp-context/compress`), omp flattens the whole thing
 * (`_mcp__magpie_acp_context_compress`). Fold every run of non-alphanumerics to one underscore, so
 * the separators that identify the name stop depending on which client is talking, while the rule
 * that the plugin's own prefix must appear still keeps another server's `foo_compress` out.
 */
const canonical = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

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
/** The plugin's other tool names: a client can declare these without any wrapper at all. */
const OWN_TOOL_NAMES = new Set([...COMPRESS_TOOL_NAMES, "decompress", "search_context", "acp_status", "acp_cache"]);

export function isOwnToolName(name) {
  const raw = String(name ?? "").toLowerCase().trim();
  if (!raw) return false;
  const full = canonical(raw);
  // Measured on omp 2026-11-07: its tool inventory lists the served names bare - `compress`,
  // `decompress`, `acp_status` - so a gate that demanded the plugin prefix switched
  // compression off for a client that could call every tool the prompt names.
  if (OWN_TOOL_NAMES.has(full)) return true;
  return full.includes(`${canonical(OWN_PREFIX)}_`);
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
  "exec_command",
  "codemode",
]);

/** Whether a client declaring these tools could call this plugin's tools at all. */
export function canCallOwnTools(names) {
  return names.some((name) => {
    const full = canonical(String(name ?? "").toLowerCase().trim());
    if (!full) return false;
    if (isOwnToolName(full)) return true;
    if (EXEC_SURFACES.has(full)) return true;
    return EXEC_SURFACES.has(full.replace(/^mcp_/, "").replace(/^[a-z0-9]+_+/, ""));
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
      const direct = isCompressToolName(call?.name);
      const device = direct ? null : deviceCompressPayload(call?.name, call?.input);
      const entries = direct
        ? parseCompressPayload(call.input)
        : device !== null
          ? parseCompressPayload(device)
          : scriptCompressCalls(call?.name, call?.input);
      if (entries.length) {
        calls.push({ unitIndex: unit.index, entries, acknowledged: acknowledges(units, unit.index) });
        continue;
      }
      // A call this plugin executed but cannot read is the quietest failure there is: the model
      // believes the fold landed and the hook says nothing. Every shape below is a call we saw
      // and still could not settle, so it is reported (with the name that defeated us) instead of
      // being treated as a call that never happened.
      const seen =
        direct ||
        device !== null ||
        scriptMentionsOurTool(call?.name, call?.input);
      if (seen) {
        calls.push({
          unitIndex: unit.index,
          entries: [],
          unreadable: true,
          name: String(call?.name ?? ""),
          acknowledged: acknowledges(units, unit.index),
        });
      }
    }
  }
  return calls;
}

/**
 * A tool result carrying our own answer proves that a compress call happened. If no call could be
 * read out of the units just before it, this host replays that call in a shape nothing here
 * knows - and that shape has to be named, because the alternative is the failure mode measured on
 * omp 2026-11-07: 491 refs, a tool answering "解析到 1 段" every time, and not one fold settled.
 */
const ACK_AT_START = /^解析到\s*\d+\s*段/;

export function unknownShapes(units, calls) {
  const settled = new Set(calls.filter((c) => c.entries.length > 0).map((c) => c.unitIndex));
  const shapes = [];
  for (let at = 0; at < units.length; at += 1) {
    // Our reply opens with the count of ranges it parsed. A transcript that merely *quotes* our
    // answer (a log read back through a shell, a pasted tool result) is not a call: measured
    // 2026-11-07, a bash result echoing the ack produced a phantom "host replayed it as bash".
    if (!ACK_AT_START.test(String(units[at]?.text || "").trimStart())) continue;
    const names = [];
    for (let back = at - 1; back >= 0 && back >= at - 4; back -= 1) {
      const calls_ = units[back]?.toolCalls || [];
      if (!calls_.length) continue;
      if (settled.has(units[back].index)) { names.length = 0; break; }
      names.push(...calls_.map((c) => String(c?.name ?? "?")));
    }
    if (names.length) shapes.push([...new Set(names)].join("、"));
  }
  return shapes;
}

/**
 * A unit carrying this plugin's own tool traffic: a call to one of our tools (including a device
 * call aimed at one), or the reply proving a call ran (#9).
 *
 * The summary is history, and so is the record of what was folded: a range that swallows the
 * model's own `compress` call — or the answer that shows it executed — leaves the model unable to
 * see what it already folded and which refs stay recoverable, so it re-folds the same span or
 * loses the thread. bili guards the same idea with `ALWAYS_PROTECTED_TOOLS`, for the same reason:
 * decompress and the "a summary is historical" contract are built on those records surviving.
 *
 * Only the tool traffic is protected, never an `[acp]` marker message: folding a summary is a
 * legitimate second-level fold (its quality is guarded on its own ticket), and refusing it would
 * forbid chained folding outright.
 */
export function ownToolUnit(unit) {
  for (const call of unit?.toolCalls || []) {
    if (isOwnToolName(call?.name)) return true;
    const target = deviceTarget(call?.name, call?.input);
    const tail = target ? (target.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "") : "";
    if (tail && isOwnToolName(tail)) return true;
  }
  const text = String(unit?.text || "");
  return ACK_AT_START.test(text.trimStart()) || text.includes(COMPRESS_ACK);
}

/**
 * Some hosts route every tool through one generic device call, naming the real tool inside the
 * arguments rather than on the wire: measured on omp 2026-11-07, a compress call is replayed as
 * `write {path:"xd://mcp__magpie_acp_context_compress", content:"{...}"}`, so the tool name the
 * transcript shows is `write`. Nothing on the wire says "compress" except the target, and the
 * payload sits in the device's own argument - both are read here, and only for a target that
 * really is our tool (a plain `write` to a file is never a fold).
 */
const DEVICE_TARGET_KEYS = ["path", "url", "target", "uri"];

function deviceCompressPayload(name, input) {
  if (isCompressToolName(name)) return null;
  const args = parseJsonObject(input);
  if (!args) return null;
  for (const key of DEVICE_TARGET_KEYS) {
    const target = args[key];
    if (typeof target !== "string" || !target) continue;
    // Only an address that points at a tool, never a filesystem path a user asked to write.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.includes("/mcp/")) continue;
    const tail = target.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
    if (!isCompressToolName(tail)) continue;
    const payload = args.content ?? args.arguments ?? args.body ?? args.input;
    if (payload === undefined) return "";
    return typeof payload === "string" ? payload : JSON.stringify(payload);
  }
  return null;
}

/** The tool a device call aims at, for reporting a shape this plugin could not read. */
export function deviceTarget(name, input) {
  if (isCompressToolName(name)) return "";
  const args = parseJsonObject(input);
  if (!args) return "";
  for (const key of DEVICE_TARGET_KEYS) {
    const target = args[key];
    if (typeof target === "string" && target) return target;
  }
  return "";
}

function parseJsonObject(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Codex reaches MCP tools from inside its `exec` JavaScript orchestrator:
 * `const r = await tools.mcp__magpie_acp_context__compress({content:"m00002–m00005 …"})`.
 * The transcript therefore records a call named `exec` whose arguments are a script, not an
 * object - so the call has to be read out of the script, and only when the content argument is
 * a plain string literal (anything computed stays unread: guessing a summary is the one thing
 * this plugin never does).
 */
function scriptCompressCalls(name, input) {
  if (!EXEC_SURFACES.has(canonical(String(name ?? "")))) return [];
  // opencode reaches the servers through an index (measured 2026-11-07:
  // `tools["magpie-acp-context"].compress({...})`), so fold that spelling into the dotted
  // one before matching - the argument parser below is the part that has to stay honest.
  const text = scriptText(input);
  const out = [];
  const re = /tools\s*\.\s*([A-Za-z0-9_$.-]+)\s*\(/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (!isCompressToolName(match[1]) && !isCompressToolName(match[1].split(".").pop())) continue;
    const args = parenthesized(text, re.lastIndex - 1);
    if (args === null) continue;
    const content = contentArgument(args);
    if (content === null) continue;
    out.push(...parseCompressPayload(content));
  }
  return out;
}

function scriptMentionsOurTool(name, input) {
  if (!EXEC_SURFACES.has(canonical(String(name ?? "")))) return false;
  return /tools\s*\.\s*[A-Za-z0-9_$.-]*compress/i.test(scriptText(input));
}

/**
 * The program a host handed over: codex sends the script as a string (custom_tool_call),
 * opencode sends the call's arguments object (its `execute` takes {code}), and opencode
 * reaches the servers through an index (`tools["magpie-acp-context"].compress(...)`), which
 * is folded into the dotted spelling here so one matcher serves both.
 */
function scriptText(input) {
  let value = input;
  // opencode sends its `execute` call's arguments as the JSON string it read off the wire
  // (`{"code":"const r = await tools[\"magpie-acp-context\"].compress({…})"}`), so the script
  // is one unescape away - and while it stays escaped, every pattern below misses.
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
  }
  const raw = value && typeof value === "object" ? (value.code ?? value.script ?? value.source ?? JSON.stringify(value)) : value;
  return String(raw ?? "").replace(/tools\s*\[\s*(["'])([^"']+)\1\s*\]/g, "tools.$2");
}

/** The text between the parens that open at `openIndex`, honouring string literals. */
function parenthesized(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

function contentArgument(args) {
  const at = /\bcontent\s*:\s*/.exec(args);
  if (!at) return null;
  let rest = args.slice(at.index + at[0].length);
  const wrapped = /^JSON\.parse\s*\(/.exec(rest);
  if (wrapped) rest = rest.slice(wrapped[0].length).trim();
  return stringLiteral(rest);
}

function stringLiteral(text) {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      const raw = text.slice(0, i + 1);
      if (quote === '"') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      // A template literal is a literal only while nothing is interpolated: `${...}` is
      // computed, and a computed summary is exactly what must never be guessed.
      if (quote === "`") return raw.includes("${") ? null : decodeTemplate(raw);
      return singleQuoted(raw);
    }
    i += 1;
  }
  return null;
}

/** A template literal carries the same escapes as a single-quoted one, minus interpolation. */
function decodeTemplate(raw) {
  const body = raw.slice(1, -1);
  return body.replace(/\\(.)/g, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch === "r" ? "\r" : ch));
}

/** Single-quoted literals are not JSON; decode only the escapes that cannot change the text. */
function singleQuoted(raw) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "\\" || next === "'" || next === '"') out += next;
    else return null;
    i += 1;
  }
  return out;
}
