/**
 * Extracts the part of billion-context's behaviour this plugin actually mirrors.
 *
 * The plugin never imports billion-context: it re-implements the same seam inside
 * magpie. So an upstream release cannot break us — it can only make us *stale*.
 * Staleness is exactly what this file measures: a small set of contract values,
 * read out of source text rather than out of line numbers, so an upstream commit
 * that only moves code produces no diff while a commit that changes a default,
 * a schema or a prompt produces one.
 *
 *   node scripts/parity-check.mjs --repo /tmp/bc-upstream
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCES = {
  config: "kernel/src/config.ts",
  compress: "kernel/src/compress.ts",
  tools: "kernel/src/compress-tools.ts",
  refs: "kernel/src/refs.ts",
  marker: "src/loop/tag-echo-filter.ts",
  prompts: "kernel/src/compress-tools.ts",
};

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A tiny literal parser: enough for TS object literals of numbers/strings/booleans. */
function parseLiteral(src, i) {
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src.startsWith("//", i)) {
        const nl = src.indexOf("\n", i);
        i = nl < 0 ? src.length : nl + 1;
        continue;
      }
      if (src.startsWith("/*", i)) {
        const close = src.indexOf("*/", i);
        i = close < 0 ? src.length : close + 2;
        continue;
      }
      return;
    }
  };

  const parseString = (quote) => {
    let out = "";
    i += 1;
    while (i < src.length && src[i] !== quote) {
      if (src[i] === "\\") {
        out += src[i + 1];
        i += 2;
        continue;
      }
      out += src[i];
      i += 1;
    }
    i += 1;
    return out;
  };

  const parseValue = () => {
    skip();
    if (src[i] === "{") {
      const obj = {};
      i += 1;
      for (;;) {
        skip();
        if (src[i] === "}") {
          i += 1;
          return obj;
        }
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        if (src[i] === "." && src[i + 1] === "." && src[i + 2] === ".") {
          i += 3;
          continue;
        }
        let key;
        if (src[i] === '"' || src[i] === "'" || src[i] === "`") key = parseString(src[i]);
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!m) {
            i += 1;
            continue;
          }
          key = m[0];
          i += key.length;
        }
        skip();
        if (src[i] === ":") {
          i += 1;
          obj[key] = parseValue();
          continue;
        }
        // Shorthand `{ a, b }` or a method name: record the key with the raw token.
        obj[key] = { __ref: key };
        if (src[i] === ",") i += 1;
      }
    }
    if (src[i] === "[") {
      const arr = [];
      i += 1;
      for (;;) {
        skip();
        if (src[i] === "]") {
          i += 1;
          return arr;
        }
        if (src[i] === ",") {
          i += 1;
          continue;
        }
        arr.push(parseValue());
      }
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") return parseString(src[i]);
    const m = /^-?[0-9.]+|^(true|false|null|undefined)|^[A-Za-z_$][\w$.]*/.exec(src.slice(i));
    if (!m) {
      i += 1;
      return null;
    }
    i += m[0].length;
    const token = m[0];
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null" || token === "undefined") return null;
    if (/^-?[0-9.]+$/.test(token)) return Number(token);
    return { __ref: token };
  };

  return { value: parseValue(), end: i };
}

/** Flattens numbers and booleans of an object literal into dotted paths. */
function flattenScalars(value, prefix = "", out = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__ref") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "number" || typeof child === "boolean") out[path] = child;
    else if (child && typeof child === "object" && !Array.isArray(child) && !child.__ref) flattenScalars(child, path, out);
  }
  return out;
}

/** The object literal that follows `pattern`, parsed. */
function objectAfter(src, pattern) {
  const at = src.search(pattern);
  if (at < 0) return null;
  const brace = src.indexOf("{", at);
  if (brace < 0) return null;
  return parseLiteral(src, brace).value;
}

function templateAfter(src, pattern) {
  const at = src.search(pattern);
  if (at < 0) return null;
  const open = src.indexOf("`", at);
  if (open < 0) return null;
  let out = "";
  for (let i = open + 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      out += src[i] + src[i + 1];
      i += 1;
      continue;
    }
    if (src[i] === "`") break;
    out += src[i];
  }
  return out;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The pipeline node list, in the order the kernel runs it. */
function nodeOrder(src) {
  const at = src.search(/const base: PipelineNode\[\] = \[/);
  if (at < 0) return [];
  const eq = src.slice(at).indexOf("= [");
  if (eq < 0) return [];
  const body = stripComments(src.slice(at + eq + 3));
  const out = [];
  let depth = 0;
  let acc = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      const item = acc.trim();
      if (item) out.push((/^([A-Za-z_$][\w$]*)/.exec(item) || [null, item])[1]);
      acc = "";
      continue;
    }
    acc += ch;
  }
  const item = acc.trim();
  if (item) out.push((/^([A-Za-z_$][\w$]*)/.exec(item) || [null, item])[1]);
  return out;
}

/** Resolves the identifiers used inside ACP_TOOL_NAMES to their string values. */
function toolNames(src) {
  const consts = new Map();
  for (const m of src.matchAll(/export const ([A-Z0-9_]+)(?::[^=]+)?\s*=\s*"([^"]+)"/g)) consts.set(m[1], m[2]);
  const at = src.search(/export const ACP_TOOL_NAMES[^=]*=\s*new Set\(\[/);
  if (at < 0) return [];
  const from = src.indexOf("[", at) + 1;
  const body = src.slice(from, src.indexOf("])", from));
  const out = [];
  for (const token of body.split(",")) {
    const name = token.replace(/\/\/.*$/gm, "").trim();
    if (!name) continue;
    if (consts.has(name)) out.push(consts.get(name));
    else if (/^".*"$/.test(name)) out.push(name.slice(1, -1));
  }
  return [...new Set(out)].sort();
}

export function extractContractFromSources(sources) {
  const configObject = objectAfter(sources.config ?? "", /const base: Config = \{/);
  const config = flattenScalars(configObject ?? {});
  const toolsSrc = sources.tools ?? "";
  const parameters = (objectAfter(toolsSrc, /export const COMPRESS_PARAMETERS\s*=/) ?? {}) || {};
  const properties = parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  const width = /const REF_WIDTH\s*=\s*(\d+)/.exec(sources.refs ?? "");
  return {
    version: null,
    refs: {
      width: width ? Number(width[1]) : null,
      format: width ? `m%0${width[1]}d` : null,
    },
    tools: {
      names: toolNames(toolsSrc),
      compressToolKeys: Object.keys(parameters).filter((k) => !k.startsWith("__")),
      compressPropertyKeys: Object.keys(properties).filter((k) => !k.startsWith("__")),
      advertisesTopic: Object.hasOwn(properties, "topic"),
      advertisesAnyOf: Object.hasOwn(parameters, "anyOf"),
    },
    pipeline: nodeOrder(sources.compress ?? ""),
    marker: /MARKER_LINE\s*=\s*(\/[^\n]*?\/[a-z]*)\s*;/.exec(sources.marker ?? "")?.[1] ?? null,
    prompts: {
      acpTags: sha(templateAfter(sources.tools ?? "", /export const (TEXT_)?ACP_TAGS_TIMESTAMPED/) ?? ""),
      systemPrompt: sha(
        ((sources.prompts ?? "").match(/export function buildCompressSystemPrompt[\s\S]*?\n\}/) ?? [""])[0],
      ),
    },
    config,
  };
}

export function extractContract(repoDir) {
  const sources = {};
  for (const [key, rel] of Object.entries(SOURCES)) {
    try {
      sources[key] = readFileSync(join(repoDir, rel), "utf8");
    } catch {
      sources[key] = "";
    }
  }
  const contract = extractContractFromSources(sources);
  try {
    contract.version = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version ?? null;
  } catch {
    /* version is informational only */
  }
  return contract;
}

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Flat list of differences: added, removed and changed leaves. */
export function diffContract(before, after, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before?.[key];
    const b = after?.[key];
    if (isPlain(a) && isPlain(b)) {
      out.push(...diffContract(a, b, path));
      continue;
    }
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (same) continue;
    if (a === undefined) out.push({ path, kind: "added", from: null, to: b });
    else if (b === undefined) out.push({ path, kind: "removed", from: a, to: null });
    else out.push({ path, kind: "changed", from: a, to: b });
  }
  return out;
}

/** Looks up a mapping entry, allowing `config.tiers.*` style wildcards. */
export function lookupMapping(mapping, path) {
  if (mapping[path]) return mapping[path];
  const parts = path.split(".");
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const wildcard = `${parts.slice(0, i).join(".")}.*`;
    if (mapping[wildcard]) return mapping[wildcard];
  }
  return null;
}

export function renderDiff(diff, mapping = {}) {
  if (!diff.length) return "上游契约未变(逐项比对无差异)。";
  const lines = [];
  for (const d of diff) {
    const entry = typeof lookupMapping(mapping, d.path) === "string" ? null : lookupMapping(mapping, d.path);
    const entryText =
      typeof entry === "string" ? `本插件 ${entry}` : entry?.option ? `本插件 ${entry.option}` : entry?.note ? `不对齐:${entry.note}` : "";
    const ours = entryText ? ` → ${entryText}` : "";
    const fmt = (v) => (v === null ? "-" : typeof v === "string" ? v : JSON.stringify(v));
    lines.push(`${d.kind.padEnd(7)} ${d.path}: ${fmt(d.from)} → ${fmt(d.to)}${ours}`);
  }
  return lines.join("\n");
}
