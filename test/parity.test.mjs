import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.mjs";
import { diffContract, extractContractFromSources, lookupMapping, renderDiff } from "../parity/extract.mjs";

const FIXTURE = {
  config: `export const defaultConfig = () => {
  const base: Config = {
    tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
    nudge: {
      // a comment inside the literal, with a { brace } in it
      minContextLimitPct: 0.45,
      growthFloor: 50000,
      label: "not a number",
    },
    compress: { minCompressRange: 5000 },
    protectedTools: [],
  };
  return base;
};`,
  refs: `const REF_WIDTH = 5;
export const formatRef = (index) => \`m\${String(index).padStart(REF_WIDTH, "0")}\`;`,
  tools: `export const COMPRESS_TOOL_NAME = "compress";
export const READONLY_STATUS = "acp_status";
export const ACP_TOOL_NAMES: ReadonlySet<string> = new Set([
  COMPRESS_TOOL_NAME,
  READONLY_STATUS,
  // comments do not become tools
  "decompress",
]);
export const COMPRESS_PARAMETERS = {
  type: "object",
  properties: {
    content: { type: "string" },
  },
};
export const ACP_TAGS_TIMESTAMPED = \`ACP TAGS
line two\`;`,
  compress: `class X {
  buildNodes(strategy: RenderStrategy): PipelineNode[] {
    const base: PipelineNode[] = [
      reconcileLiveIdsNode,
      createStampTimestampsNode(timestampsOn),
      // EXPERIMENTAL, see #4252: a comment with, a comma
      assignRefsNode,
    ];
  }
}`,
  marker: `    MARKER_LINE = /^\\p{So}(?:[ \\t])?\\[ACP\\][^\\n]*\\n?/gmu;`,
  prompts: `export function buildCompressSystemPrompt(prompts, sections) {
  return "x";
}
export function other() {}`,
};

describe("extraction", () => {
  const contract = () => extractContractFromSources({ ...FIXTURE });

  test("reads nested numbers even when the object is written on one line", () => {
    const c = contract();
    expect(c.config["tiers.tier2Trigger"]).toBe(1000);
    expect(c.config["tiers.enabled"]).toBe(true);
    expect(c.config["nudge.minContextLimitPct"]).toBe(0.45);
    expect(c.config["compress.minCompressRange"]).toBe(5000);
    expect(c.config["nudge.label"]).toBeUndefined();
    // The comment inside the literal holds a brace; it must not derail the parse.
    expect(c.config["nudge.growthFloor"]).toBe(50000);
  });

  test("resolves tool name constants and ignores comments", () => {
    expect(contract().tools.names).toEqual(["acp_status", "compress", "decompress"]);
  });

  test("reports what the advertised compress schema actually offers", () => {
    const c = contract();
    expect(c.tools.compressToolKeys).toEqual(["type", "properties"]);
    expect(c.tools.compressPropertyKeys).toEqual(["content"]);
    expect(c.tools.advertisesTopic).toBe(false);
    expect(c.tools.advertisesAnyOf).toBe(false);
  });

  test("keeps the pipeline order and drops comments and arguments", () => {
    expect(contract().pipeline).toEqual(["reconcileLiveIdsNode", "createStampTimestampsNode", "assignRefsNode"]);
  });

  test("derives the ref format from REF_WIDTH", () => {
    expect(contract().refs).toEqual({ width: 5, format: "m%05d" });
  });

  test("hashes prompt text so a rewrite shows up as a change", () => {
    const before = contract().prompts;
    const after = extractContractFromSources({ ...FIXTURE, tools: FIXTURE.tools.replace("line two", "line three") }).prompts;
    expect(before.acpTags).not.toBe(after.acpTags);
    expect(before.systemPrompt).toBe(after.systemPrompt);
  });
});

describe("diff", () => {
  const base = () => extractContractFromSources({ ...FIXTURE });

  test("reports a changed default, an added tool and nothing else", () => {
    const after = extractContractFromSources({
      ...FIXTURE,
      config: FIXTURE.config.replace("minCompressRange: 5000", "minCompressRange: 8000"),
      tools: FIXTURE.tools.replace('"decompress",', '"decompress", "search_context",'),
    });
    const diff = diffContract(base(), after);
    expect(diff.map((d) => `${d.kind} ${d.path}`)).toEqual([
      "changed config.compress.minCompressRange",
      "changed tools.names",
    ]);
  });

  test("a reordered pipeline is a change, a reformatted one is not", () => {
    expect(diffContract(base(), base())).toEqual([]);
    const swapped = extractContractFromSources({
      ...FIXTURE,
      compress: FIXTURE.compress.replace("      reconcileLiveIdsNode,\n", "").replace("      assignRefsNode,", "      assignRefsNode,\n      reconcileLiveIdsNode,"),
    });
    expect(diffContract(base(), swapped).map((d) => d.path)).toEqual(["pipeline"]);
  });

  test("annotates each difference with our option, our note, or nothing", () => {
    const after = extractContractFromSources({
      ...FIXTURE,
      config: FIXTURE.config.replace("minCompressRange: 5000", "minCompressRange: 8000").replace("tier2Trigger: 1000", "tier2Trigger: 4000"),
    });
    const out = renderDiff(diffContract(base(), after), {
      "config.compress.minCompressRange": { option: "minRangeBytes" },
      "config.tiers.*": { note: "分级蒸馏做不到" },
    });
    expect(out).toContain("→ 本插件 minRangeBytes");
    expect(out).toContain("→ 不对齐:分级蒸馏做不到");
  });

  test("wildcards are looked up from the deepest path outwards", () => {
    const mapping = { "config.tiers.*": { note: "tiers" }, "config.*": { note: "config" } };
    expect(lookupMapping(mapping, "config.tiers.tier2Trigger")).toEqual({ note: "tiers" });
    expect(lookupMapping(mapping, "config.compress.minCompressRange")).toEqual({ note: "config" });
    expect(lookupMapping(mapping, "refs.format")).toBeNull();
  });
});

describe("the pinned snapshot", () => {
  const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "..", "parity", "bili-0.1.211.json"), "utf8"));
  const mapping = JSON.parse(readFileSync(join(import.meta.dir, "..", "parity", "mapping.json"), "utf8"));

  // `config` is flattened to dotted keys in the snapshot, the rest is nested
  const resolves = (path) => {
    const wildcard = path.endsWith(".*");
    const flat = wildcard ? path.slice(0, -2) : path;
    if (flat.startsWith("config.")) {
      const key = flat.slice("config.".length);
      return wildcard ? Object.keys(snapshot.config).some((k) => k === key || k.startsWith(`${key}.`)) : key in snapshot.config;
    }
    let cur = snapshot;
    for (const part of flat.split(".")) {
      if (cur === null || typeof cur !== "object" || !(part in cur)) return false;
      cur = cur[part];
    }
    return true;
  };

  test("every mapped path still exists upstream", () => {
    const dangling = Object.keys(mapping).filter((path) => !resolves(path));
    expect(dangling).toEqual([]);
  });

  test("the ref format we emit is the one the snapshot pins", () => {
    expect(DEFAULTS.refFormat).toBe(snapshot.refs.format);
    expect(DEFAULTS.minRangeBytes).toBe(snapshot.config["compress.minCompressRange"]);
    expect(DEFAULTS.maxSummaryChars).toBe(snapshot.config["compress.maxSummaryLength"]);
    // One trigger, one number: the same flat floor upstream pins for every window.
    expect(DEFAULTS.nudge.growthFloor).toBe(snapshot.config["nudge.growthFloor"]);
    expect(snapshot.config["nudge.growthCap"]).toBe(snapshot.config["nudge.growthFloor"]);
  });
});
