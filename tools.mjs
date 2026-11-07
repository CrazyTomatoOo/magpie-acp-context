/**
 * The tools half of the plugin: magpie serves these over its own MCP server
 * (`/mcp/magpie/tools`), so any agent can call them, and the client runs them.
 *
 * Why tools and not the hook: the hook cannot execute anything (no network, no clock, 250 ms)
 * and cannot inject a tool result mid-stream. A tool runs in the plugin host with Bun's full
 * runtime, and its answer goes back through the client as an ordinary tool result — which is
 * exactly where a fold can be settled, because the hook reads the transcript on the next turn.
 */
import { loadConfig } from "./src/config.mjs";
import { COMPRESS_ACK, parseCompressPayload } from "./src/compress.mjs";
import { findBlock, listBlocks, searchBlocks } from "./src/blocks.mjs";
import { cleanup } from "./src/store.mjs";
import { renderStatus, scanStore } from "./src/maintenance.mjs";
import { versionLine } from "./src/version.mjs";

const COMPRESS_ARGS = {
  type: "object",
  properties: {
    content: { type: "string", description: "要折叠的范围:每行 `m00002–m00005 主题`,空行后是这一段的中文摘要。" },
  },
  required: ["content"],
};

const DECOMPRESS_ARGS = {
  type: "object",
  properties: {
    id: { type: "string", description: "块 id(16 位十六进制)或它显示过的 ref(如 m00003)。" },
  },
  required: ["id"],
};

const SEARCH_ARGS = {
  type: "object",
  properties: {
    query: { type: "string", description: "要找回的原文关键词。" },
    limit: { type: "number", description: "最多返回几条,默认 5。" },
  },
  required: ["query"],
};

const STATUS_ARGS = {
  type: "object",
  properties: {
    session: { type: "string", description: "只看这个会话;" },
    limit: { type: "number", description: "最多列几个会话,默认 5。" },
    evict: { type: "boolean", description: "顺带做一次回收(按 maxBytes / ttlDays)。" },
  },
};

const num = (n) => new Intl.NumberFormat("en-US").format(n);

function budget(text) {
  return new TextEncoder().encode(String(text)).length;
}

function compressTool(cfg) {
  return {
    description:
      "把一段旧历史折成摘要。返回解析结果;真正的折叠在客户端把这个结果写回历史后的下一次请求里结算。",
    args: COMPRESS_ARGS,
    execute(args) {
      const ranges = parseCompressPayload(args?.content ?? "");
      if (!ranges.length) return "没有解析到范围。每行写成 `m00002–m00005 主题`,空行后接摘要正文。";
      const lines = ranges.map((r) => {
        const bytes = budget(r.summary);
        const ok = bytes <= cfg.maxSummaryChars;
        return `${r.startId}–${r.endId} ${r.topic ? `「${r.topic}」` : ""}摘要 ${num(bytes)} 字节${ok ? "" : `(超过 maxSummaryChars=${num(cfg.maxSummaryChars)},会被截断)`}`;
      });
      return [
        `解析到 ${ranges.length} 段;${COMPRESS_ACK}(本工具不写历史)。`,
        ...lines,
      ].join("\n");
    },
  };
}

function decompressTool(cfg) {
  return {
    description: "取回被折叠掉的原文(按块 id 或 ref)。原文在宿主磁盘上,不在上下文里。",
    args: DECOMPRESS_ARGS,
    execute(args) {
      const found = findBlock(cfg.storeDir, args?.id);
      if (!found) {
        const total = listBlocks(cfg.storeDir).length;
        return `没有这个块:${args?.id ?? "(空)"};store 里有 ${num(total)} 个块(${cfg.storeDir})。`;
      }
      return [
        `# ${found.blockId}${found.ref ? ` (${found.ref})` : ""} role=${found.role || "?"} ${num(budget(found.text))} 字节`,
        String(found.text ?? ""),
      ].join("\n");
    },
  };
}

function searchTool(cfg) {
  return {
    description: "在被折叠的原文里检索(子串 + 词频,按分数与新近度排序)。",
    args: SEARCH_ARGS,
    execute(args) {
      const hits = searchBlocks(cfg.storeDir, args?.query, Number(args?.limit ?? 5));
      if (!hits.length) return `没有命中:${args?.query ?? "(空)"}`;
      return hits
        .map((h, i) => `[${i + 1}] ${h.blockId}${h.ref ? ` ${h.ref}` : ""} role=${h.role || "?"} score=${h.score}\n${h.snippet}`)
        .join("\n\n");
    },
  };
}

function statusTool(cfg) {
  return {
    description: "看一眼上下文用量:每轮被计费的 prompt tokens、折叠数、nudge 状态、store 体积。",
    args: STATUS_ARGS,
    async execute(args) {
      const scan = scanStore(cfg.storeDir);
      const wanted = args?.session ? scan.sessions.filter((s) => s.key === args.session) : [];
      const shown = wanted.length ? wanted : scan.sessions;
      const out = [
        [
          `开关:${cfg.enabled ? "开" : "关"}`,
          `mode=${cfg.mode}`,
          "工具门:声明了工具、却既无本插件的工具也无可执行(code/shell)面时不介入",
          `agents=${cfg.agents.length ? cfg.agents.join(",") : "全部"}`,
          `origins=${cfg.origins.join(",")}`,
        ].join(" · "),
        renderStatus({ ...scan, sessions: shown }, { growthFloor: Number(cfg.nudge.growthFloor) || 50000, limit: Number(args?.limit ?? 5) }),
      ];
      if (!wanted.length && args?.session) out.push(`没有这个会话:${args.session}。用 acp_status 不带参数列出现有会话。`);
      if (!cfg.enabled) out.push("关着时不会压缩任何请求;打开:magpie plugin options magpie-acp-context '{\"enabled\":true}'。");
      if (args?.evict) {
        const done = cleanup(cfg.storeDir, { maxBytes: cfg.store.maxBytes, ttlDays: cfg.store.ttlDays });
        out.push(`回收:删了 ${num(done.removed)} 个块,释放 ${num(done.freed)} 字节,标记 ${num(done.evictedFolds)} 个 fold 为已淘汰。`);
      }
      // Off skips the whole check: no line, no request, and the cache entry is never even read.
      const line = cfg.updateCheck ? await versionLine(process.cwd(), cfg.storeDir, cfg.debug) : null;
      if (line) out.splice(1, 0, line);
      return out.join("\n");
    },
  };
}

/** magpie calls this once per load with the plugin's options as the user set them. */
export default async function acpTools(_input, options) {
  const cfg = loadConfig(options);
  return {
    tool: {
      compress: compressTool(cfg),
      decompress: decompressTool(cfg),
      search_context: searchTool(cfg),
      acp_status: statusTool(cfg),
    },
  };
}

export { compressTool, decompressTool, searchTool, statusTool };
