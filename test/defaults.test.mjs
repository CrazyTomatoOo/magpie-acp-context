import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { advertisedToolNames } from "../src/protocol.mjs";
import { canCallOwnTools, isOwnToolName } from "../src/compress.mjs";
import { onRequest } from "../hooks.mjs";
import acpTools from "../tools.mjs";

const store = () => mkdtempSync(join(tmpdir(), "acp-defaults-"));
const ctxOf = (options, extra = {}) => ({ protocol: "chat", session: "s1", origin: "local", options, ...extra });
const filler = (n) => "填充文本。".repeat(Math.ceil(n / 5)).slice(0, n);

const chat = (tools) => {
  const body = {
    model: "x",
    messages: [
      { role: "user", content: "请读一下这个文件并总结。" },
      { role: "assistant", content: "好的,我先读。" },
      { role: "tool", tool_call_id: "call_1", content: filler(6000) },
      { role: "assistant", content: "总结:内容是一段填充文本。" },
      { role: "user", content: "继续" },
    ],
  };
  if (tools !== undefined) body.tools = tools;
  return body;
};

const served = async (options, tools) => {
  const out = await onRequest(chat(tools), ctxOf(options));
  return out !== undefined && JSON.stringify(out).includes("[m00001]");
};

describe("the switch is on by default", () => {
  test("no options at all still serves the request", async () => {
    expect(loadConfig().enabled).toBe(true);
    const options = { keepRecentTurns: 1, minRangeBytes: 1000, store: { dir: store() } };
    expect(await served(options)).toBe(true);
  });

  test("the manifest's editor default agrees with the code", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(manifest.magpie.options.enabled).toBe(loadConfig().enabled);
  });

  test("an explicit off still wins over the default", async () => {
    const options = { enabled: false, keepRecentTurns: 1, minRangeBytes: 1000, store: { dir: store() } };
    expect(loadConfig({ enabled: false }).enabled).toBe(false);
    expect(await served(options)).toBe(false);
    expect(existsSync(join(options.store.dir, "sessions"))).toBe(false);
  });
});

describe("tool gate", () => {
  const options = () => ({ keepRecentTurns: 1, minRangeBytes: 1000, store: { dir: store() } });

  const owns = [
    "magpie-acp-context_compress",
    "mcp__magpie__magpie-acp-context_search_context",
    "_mcp__magpie_acp_context_decompress",
    "MAGPIE.ACP.CONTEXT.compress",
  ];
  // A bare `compress` is a tool some other server could serve; only the plugin's own prefix
  // proves the client can reach ours.
  const foreign = ["compress", "read", "web_search", "mcp__other__compress", "other-acp-context_compress"];
  // A client can call our tools without naming them: code and shell surfaces reach MCP, which
  // is how omp (the magpie lane's host) does it.
  const execSurfaces = ["_bash", "eval", "run_code", "terminal", "mcp__shell__bash"];

  test("every name our tools travel under is recognised", () => {
    for (const name of owns) expect(isOwnToolName(name)).toBe(true);
    for (const name of foreign) expect(isOwnToolName(name)).toBe(false);
    for (const name of execSurfaces) expect(isOwnToolName(name)).toBe(false);
    expect(isOwnToolName("")).toBe(false);
    expect(isOwnToolName(null)).toBe(false);
  });

  test("code and shell surfaces count as able to call our tools", () => {
    for (const name of execSurfaces) expect(canCallOwnTools([name])).toBe(true);
    for (const name of [...owns, ...execSurfaces]) expect(canCallOwnTools([name])).toBe(true);
    for (const name of foreign) expect(canCallOwnTools([name])).toBe(false);
    expect(canCallOwnTools([])).toBe(false);
  });

  test("the real omp toolset is served", async () => {
    const omp = ["_read", "_bash", "_edit", "_eval", "_glob", "_grep", "_task", "_wait", "_todo", "web_search", "_write"];
    expect(await served(options(), omp.map((name) => ({ type: "function", function: { name } })))).toBe(true);
  });

  test("a client that declares tools without ours is left byte-identical", async () => {
    const o = options();
    expect(await served(o, foreign.map((name) => ({ type: "function", function: { name } })))).toBe(false);
    // Not even a ledger: a request this plugin does not serve leaves no trace of itself.
    expect(existsSync(join(o.store.dir, "sessions"))).toBe(false);
  });

  test("a client that declares one of our tools is served", async () => {
    for (const name of ["magpie-acp-context_compress", "_mcp__magpie_acp_context_compress"]) {
      expect(await served(options(), [{ type: "function", function: { name } }])).toBe(true);
    }
  });

  test("an empty declaration list can call nothing", async () => {
    expect(await served(options(), [])).toBe(false);
  });

  test("a host that declares no tools at all is served as before", async () => {
    expect(await served(options(), undefined)).toBe(true);
  });

  test("reads the shape each wire declares tools in", () => {
    expect(advertisedToolNames({ tools: [{ name: "a" }, { function: { name: "b" } }] })).toEqual(["a", "b"]);
    expect(advertisedToolNames({ tools: [{ type: "function", name: "c" }] })).toEqual(["c"]);
    expect(advertisedToolNames({ tools: [{ functionDeclarations: [{ name: "d" }] }] })).toEqual(["d"]);
    expect(advertisedToolNames({ tools: [] })).toEqual([]);
    expect(advertisedToolNames({ messages: [] })).toBeNull();
  });
});

describe("acp_status says which switch is on", () => {
  test("on by default, and the off state explains how to turn it back on", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("no network in tests"));
    try {
      const dir = store();
      const on = await acpTools(undefined, { store: { dir } });
      const onOut = await on.tool.acp_status.execute({});
      expect(onOut.split("\n")[0]).toContain("开关:开");
      expect(onOut.split("\n")[0]).toContain("工具门");

      const off = await acpTools(undefined, { enabled: false, store: { dir } });
      const lines = (await off.tool.acp_status.execute({})).split("\n");
      expect(lines[0]).toContain("开关:关");
      expect(lines.join("\n")).toContain('"enabled":true');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
