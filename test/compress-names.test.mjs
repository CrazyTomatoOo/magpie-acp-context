import { describe, expect, test } from "bun:test";
import { canCallOwnTools, compressCalls, isCompressToolName } from "../src/compress.mjs";
import { advertisedToolNames } from "../src/protocol.mjs";

const ACK = "解析到 1 段;折叠会在下一次请求时按历史里真实的 ref 结算(本工具不写历史)。";

function units(name) {
  return [
    { index: 0, role: "user", text: "m00001 读文件", toolCalls: [], stampable: true },
    {
      index: 1,
      role: "assistant",
      text: "",
      stampable: false,
      toolCalls: [{ name, input: { content: "m00001–m00001 读文件\n用户要求读 a.txt。" } }],
    },
    { index: 2, role: "tool", text: ACK, toolCalls: [], stampable: false },
  ];
}

describe("compress tool names a real client replays", () => {
  test("the name magpie serves, and the name a client wraps it in", () => {
    expect(isCompressToolName("magpie-acp-context_compress")).toBe(true);
    expect(isCompressToolName("mcp__magpie__magpie-acp-context_compress")).toBe(true);
    expect(isCompressToolName("compress")).toBe(true);
    expect(isCompressToolName("ACP_Compress")).toBe(true);
  });

  test("a wire that folds dashes and dots to underscores is the same tool", () => {
    expect(isCompressToolName("_mcp__magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("_mcp__magpie__magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("_mcp__magpie_acp_context_decompress")).toBe(false);
    expect(isCompressToolName("_mcp__magpie_acp_context_acp_status")).toBe(false);
    expect(isCompressToolName("_mcp__other_acp_context_compress")).toBe(false);
  });

  test("the spellings claude and codex replay on the wire", () => {
    // Measured 2026-11-07 through a real gateway: Claude Code keeps the MCP wrapper and doubles
    // the separator (mcp__<server>__<tool>), Codex namespaces with a slash (<server>/<tool>).
    // Neither settled a fold while the canonical form only folded dashes, dots and spaces.
    expect(isCompressToolName("mcp__magpie-acp-context__compress")).toBe(true);
    expect(isCompressToolName("magpie-acp-context/compress")).toBe(true);
    expect(isCompressToolName("magpie-acp-context/acp_status")).toBe(false);
    expect(isCompressToolName("mcp__magpie__compress")).toBe(false);
  });

  test("a call under either spelling settles", () => {
    expect(compressCalls(units("mcp__magpie-acp-context__compress"))).toHaveLength(1);
    expect(compressCalls(units("magpie-acp-context/compress"))).toHaveLength(1);
  });

  test("neighbouring tools and lookalikes are not a compress call", () => {
    expect(isCompressToolName("mcp__magpie__magpie-acp-context_decompress")).toBe(false);
    expect(isCompressToolName("magpie-acp-context_search_context")).toBe(false);
    expect(isCompressToolName("compressor")).toBe(false);
    expect(isCompressToolName("other-server_compress")).toBe(false);
    expect(isCompressToolName("mcp__other__read_compress")).toBe(false);
    expect(isCompressToolName("")).toBe(false);
    expect(isCompressToolName(undefined)).toBe(false);
  });

  test("a call made under the served name settles", () => {
    const calls = compressCalls(units("mcp__magpie__magpie-acp-context_compress"));
    expect(calls).toHaveLength(1);
    expect(calls[0].acknowledged).toBe(true);
    expect(calls[0].entries).toHaveLength(1);
  });

  test("a decompress reply is not mistaken for a compress call", () => {
    expect(compressCalls(units("mcp__magpie__magpie-acp-context_decompress"))).toHaveLength(0);
  });
});

describe("codex reaches MCP from inside its exec orchestrator", () => {
  // Measured on codex-cli 0.167 (responses wire, 2026-11-07): the transcript records a call
  // named `exec` whose argument is JavaScript, and our tool is invoked inside it.
  const script = (content) =>
    `const r = await tools.mcp__magpie_acp_context__compress({content:${content}}); text(r)`;

  const withCall = (input) => [
    { index: 0, role: "user", text: "m00001 读文件", toolCalls: [], stampable: true },
    { index: 1, role: "assistant", text: "", stampable: false, toolCalls: [{ name: "exec", input }] },
    { index: 2, role: "tool", text: ACK, toolCalls: [], stampable: false },
    { index: 3, role: "user", text: "继续", toolCalls: [], stampable: true },
  ];

  test("a plain string literal is read out of the script", () => {
    const calls = compressCalls(withCall(script(JSON.stringify("m00002–m00005 早期\n用户要求读 a.txt。"))));
    expect(calls).toHaveLength(1);
    expect(calls[0].entries[0]).toMatchObject({ startId: "m00002", endId: "m00005" });
    expect(calls[0].acknowledged).toBe(true);
  });

  test("a computed argument is reported instead of guessed", () => {
    const calls = compressCalls(withCall(script("build()")));
    expect(calls).toHaveLength(1);
    expect(calls[0].unreadable).toBe(true);
    expect(calls[0].entries).toHaveLength(0);
  });

  test("a script that never touches our tool is not a compress call", () => {
    expect(compressCalls(withCall("const r = await tools.mcp__magpie_acp_context__acp_status({}); text(r)"))).toHaveLength(0);
  });
});

describe("codex CLI's namespace-shaped declaration (#15 lane probe)", () => {
  // Measured on codex-cli 0.166 (responses wire) through a real magpie gateway: the MCP
  // server arrives as one namespace entry and the callable names live one level down.
  const declared = [
    { type: "function", name: "exec_command" },
    {
      type: "namespace",
      name: "mcp__magpie",
      tools: [
        { type: "function", name: "magpie_acp_context_compress" },
        { type: "function", name: "magpie_acp_context_acp_status" },
      ],
    },
  ];

  test("the nested callable names are read, the bare namespace is not enough", () => {
    expect(advertisedToolNames({ tools: declared })).toContain("magpie_acp_context_compress");
    expect(canCallOwnTools(advertisedToolNames({ tools: declared }))).toBe(true);
    expect(canCallOwnTools(advertisedToolNames({ tools: [declared[1]] }))).toBe(true);
    expect(canCallOwnTools(advertisedToolNames({ tools: [{ type: "namespace", name: "mcp__other", tools: [] }] }))).toBe(false);
  });

  test("codex's shell tool is a way in even without our names", () => {
    expect(canCallOwnTools(["exec_command"])).toBe(true);
    expect(canCallOwnTools(["apply_patch", "view_image"])).toBe(false);
  });

  test("pi reaches MCP from its code surface, and names it with underscores", () => {
    expect(canCallOwnTools(["read", "bash", "edit", "write", "codemode"])).toBe(true);
    expect(canCallOwnTools(["codemode"])).toBe(true);
    expect(isCompressToolName("mcp__magpie__magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("mcp__magpie__magpie-acp-context_compress")).toBe(true);
  });

  test("the name codex replays is the underscored plugin tool", () => {
    expect(isCompressToolName("magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("mcp__magpie__magpie_acp_context_compress")).toBe(true);
    expect(isCompressToolName("other_acp_context_compress")).toBe(false);
  });
});
