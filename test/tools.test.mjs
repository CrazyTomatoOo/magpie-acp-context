import { describe, expect, test, afterEach } from "bun:test";
import { COMPRESS_ACK } from "../src/compress.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const PUBLISHED_URL = "https://raw.githubusercontent.com/CrazyTomatooOo/magpie-acp-context/magpie-plugin/package.json";

describe("acp_status version line", () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
  });

  const statusTool = async () => (await acpTools(undefined, { store: { dir: store() } })).tool.acp_status;

  const stubFetch = (respond) => {
    const calls = [];
    globalThis.fetch = (input, init) => {
      calls.push({ input: String(input), init });
      return respond();
    };
    return calls;
  };

  const installCopy = (version) => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-version-"));
    const dir = join(cwd, "plugins", "node_modules", "magpie-acp-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "magpie-acp-context", version }));
    process.chdir(cwd);
    return cwd;
  };

  test("prints own · latest when the installed copy is behind, one fetch at the moving pointer", async () => {
    installCopy("0.2.2");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool()).execute({});
    expect(out.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
    expect(calls.length).toBe(1);
    expect(calls[0].input).toBe(PUBLISHED_URL);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("names only the running version when current", async () => {
    installCopy("0.2.3");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool()).execute({});
    expect(out.split("\n")[1]).toBe("version 0.2.3");
    expect(out).not.toContain("latest");
    expect(calls.length).toBe(1);
  });

  test("no version line and no error text when the fetch rejects, answers non-2xx, or answers unparsable JSON", async () => {
    installCopy("0.2.2");
    const failures = [
      () => Promise.reject(new Error("offline")),
      () => new Response("nope", { status: 500 }),
      () => new Response("{oops", { status: 200 }),
    ];
    for (const respond of failures) {
      stubFetch(respond);
      const out = await (await statusTool()).execute({});
      expect(out).not.toContain("version ");
      expect(out).not.toContain("latest");
    }
  });

  test("prefers the installed copy's manifest over the checkout's own", async () => {
    installCopy("0.1.0");
    stubFetch(() => Response.json({ version: "9.9.9" }));
    const out = await (await statusTool()).execute({});
    expect(out.split("\n")[1]).toBe("version 0.1.0 · latest 9.9.9");
  });

  test("falls back to the package's own manifest when no installed copy exists", async () => {
    process.chdir(mkdtempSync(join(tmpdir(), "acp-version-")));
    stubFetch(() => Response.json({ version: "9.9.9" }));
    const out = await (await statusTool()).execute({});
    const own = JSON.parse(readFileSync(join(realCwd, "package.json"), "utf8")).version;
    expect(out.split("\n")[1]).toBe(`version ${own} · latest 9.9.9`);
  });
});
