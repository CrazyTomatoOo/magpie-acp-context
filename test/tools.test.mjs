import { describe, expect, test } from "bun:test";
import { COMPRESS_ACK } from "../src/compress.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acpTools from "../tools.mjs";
import { onRequest } from "../hooks.mjs";

const store = () => mkdtempSync(join(tmpdir(), "acp-tools-"));

function chatHistory() {
  return {
    model: "x",
    messages: [
      { role: "user", content: "请读一下这个文件并总结。" },
      {
        role: "assistant",
        content: "好的,我先读。",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "数据库连接串:postgres://localhost:5432/app" },
      { role: "assistant", content: "总结:这是一个 PostgreSQL 连接串。" },
      { role: "user", content: "把更早的细节压掉吧。" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "compress", arguments: JSON.stringify({ content: "m00002–m00005 早期需求\n用户要求读文件并总结。" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_2", content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` },
      { role: "user", content: "继续" },
    ],
  };
}

const toolsFor = async (options) => {
  const set = await acpTools({ directory: "/tmp" }, options);
  return set.tool;
};

describe("tools", () => {
  test("compress parses every line of the payload", async () => {
    const tool = (await toolsFor({ store: { dir: store() }, maxSummaryChars: 20000 })).compress;
    const out = await tool.execute({ content: "m00002–m00005 早期需求\n用户要求读文件。\n\nm00007–m00009 部署\n走 Docker。" });
    expect(out).toContain("解析到 2 段");
    expect(out).toContain("m00002–m00005 「早期需求」");
    expect(out).toContain("m00007–m00009 「部署」");
  });

  test("compress refuses text that holds no range", async () => {
    const tool = (await toolsFor({ store: { dir: store() } })).compress;
    expect(await tool.execute({ content: "随便写点什么都行" })).toContain("没有解析到范围");
  });

  test("decompress returns the original the hook stored, by ref and by id", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir }, keepRecentTurns: 1, minRangeBytes: 10 };
    await onRequest(structuredClone(chatHistory()), {
      protocol: "chat",
      origin: "local", session: "s1", options });

    const tool = (await toolsFor(options)).decompress;
    const byRef = await tool.execute({ id: "m00003" });
    expect(byRef).toContain("postgres://localhost:5432/app");
    expect(byRef).toContain("role=tool");

    const id = /# ([0-9a-f]{16})/.exec(byRef)?.[1];
    expect(id).toBeTruthy();
    expect(await tool.execute({ id })).toContain("postgres://localhost:5432/app");
  });

  test("decompress says how big the store is when the id is unknown", async () => {
    const tool = (await toolsFor({ store: { dir: store() } })).decompress;
    expect(await tool.execute({ id: "m09999" })).toContain("没有这个块");
  });

  test("search_context ranks the folded original and quotes the hit", async () => {
    const dir = store();
    const options = { enabled: true, store: { dir }, keepRecentTurns: 1, minRangeBytes: 10 };
    await onRequest(structuredClone(chatHistory()), {
      protocol: "chat",
      origin: "local", session: "s1", options });

    const tool = (await toolsFor(options)).search_context;
    const out = await tool.execute({ query: "postgres" });
    expect(out).toContain("postgres://localhost:5432/app");
    expect(out).toContain("score=");
    expect(await tool.execute({ query: "完全不存在的东西" })).toContain("没有命中");
  });
});
