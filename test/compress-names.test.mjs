import { describe, expect, test } from "bun:test";
import { compressCalls, isCompressToolName } from "../src/compress.mjs";

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
