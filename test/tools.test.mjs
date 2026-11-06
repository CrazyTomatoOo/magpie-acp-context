import { describe, expect, test, afterEach } from "bun:test";
import { COMPRESS_ACK } from "../src/compress.mjs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("acp_status version check cache", () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
  });

  const statusTool = async (dir, store = {}) => (await acpTools(undefined, { store: { dir, ...store } })).tool.acp_status;

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

  const cacheFile = (dir) => join(dir, "version-check.json");

  const writeCache = (dir, latest, at) => writeFileSync(cacheFile(dir), JSON.stringify({ latest, at }));

  test("cold store: exactly one fetch, cache entry written; an untouched second call fetches nothing and prints the same line", async () => {
    installCopy("0.2.2");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const dir = store();
    const tool = await statusTool(dir);
    const first = await tool.execute({});
    expect(calls.length).toBe(1);
    expect(first.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
    const entry = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
    expect(entry.latest).toBe("0.2.3");
    expect(entry.at).toBeGreaterThan(Date.now() - 60000);
    const second = await tool.execute({});
    expect(calls.length).toBe(1);
    expect(second).toBe(first);
  });

  test("a check younger than 24 hours renders from the cache; past 24 hours it refetches once and refreshes the entry", async () => {
    installCopy("0.2.2");
    const calls = stubFetch(() => Response.json({ version: "0.2.4" }));
    const dir = store();
    writeCache(dir, "0.2.3", Date.now() - 23 * 60 * 60 * 1000);
    const warm = await (await statusTool(dir)).execute({});
    expect(calls.length).toBe(0);
    expect(warm.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
    const old = Date.now() - 25 * 60 * 60 * 1000;
    writeCache(dir, "0.2.3", old);
    const stale = await (await statusTool(dir)).execute({});
    expect(calls.length).toBe(1);
    expect(stale.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.4");
    const entry = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
    expect(entry.latest).toBe("0.2.4");
    expect(entry.at).toBeGreaterThan(old);
  });

  test("a cache that cannot be parsed or trusted is no cache: one fetch, the line still prints, the file is rewritten", async () => {
    installCopy("0.2.2");
    const dir = store();
    for (const content of [
      '{"latest":"9.9.9","at":',
      "",
      "not json at all",
      "[1,2,3]",
      JSON.stringify({ at: Date.now() }),
      JSON.stringify({ latest: "9.9.9" }),
      JSON.stringify({ latest: 1, at: "yesterday" }),
    ]) {
      writeFileSync(cacheFile(dir), content);
      const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
      const out = await (await statusTool(dir)).execute({});
      expect(calls.length).toBe(1);
      expect(out.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
      const entry = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
      expect(entry.latest).toBe("0.2.3");
      expect(entry.at).toBeGreaterThan(Date.now() - 60000);
    }
  });

  test("an unreadable cache file is no cache either: one fetch, the line still prints, never an error", async () => {
    installCopy("0.2.2");
    const dir = store();
    mkdirSync(cacheFile(dir));
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool(dir)).execute({});
    expect(calls.length).toBe(1);
    expect(out.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
    expect(existsSync(cacheFile(dir))).toBe(true);
  });

  test("an eviction pass neither deletes nor needs to read the cache entry", async () => {
    installCopy("0.2.2");
    const dir = store();
    const seedEvictable = () => {
      mkdirSync(join(dir, "blocks"), { recursive: true });
      mkdirSync(join(dir, "sessions"), { recursive: true });
      for (const [id, text] of [
        ["a".repeat(16), "old ".repeat(200)],
        ["b".repeat(16), "new ".repeat(200)],
      ]) {
        writeFileSync(join(dir, "blocks", `${id}.json`), JSON.stringify({ blockId: id, text, at: 0 }));
      }
      writeFileSync(
        join(dir, "sessions", "s1.json"),
        JSON.stringify({ v: 1, next: 3, refs: {}, folds: [{ id: "f1", blocks: ["a".repeat(16)] }] }),
      );
    };
    seedEvictable();
    writeCache(dir, "0.2.3", Date.now());
    const before = readFileSync(cacheFile(dir), "utf8");
    const calls = stubFetch(() => Response.json({ version: "9.9.9" }));
    const out = await (await statusTool(dir, { maxBytes: 300 })).execute({ evict: true });
    expect(calls.length).toBe(0);
    expect(out.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
    expect(readdirSync(join(dir, "blocks"))).toHaveLength(0);
    expect(readFileSync(cacheFile(dir), "utf8")).toBe(before);
    rmSync(cacheFile(dir));
    mkdirSync(cacheFile(dir));
    seedEvictable();
    const calls2 = stubFetch(() => Response.json({ version: "9.9.9" }));
    const out2 = await (await statusTool(dir, { maxBytes: 300 })).execute({ evict: true });
    expect(calls2.length).toBe(1);
    expect(out2.split("\n")[1]).toBe("version 0.2.2 · latest 9.9.9");
    expect(readdirSync(join(dir, "blocks"))).toHaveLength(0);
    expect(existsSync(cacheFile(dir))).toBe(true);
  });
});

describe("acp_status updateCheck gate", () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const realEnv = process.env.MAGPIE_ACP_UPDATE_CHECK;

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    if (realEnv === undefined) delete process.env.MAGPIE_ACP_UPDATE_CHECK;
    else process.env.MAGPIE_ACP_UPDATE_CHECK = realEnv;
  });

  const statusTool = async (options = {}) =>
    (await acpTools(undefined, { store: { dir: store() }, ...options })).tool.acp_status;

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

  const cacheFile = (dir) => join(dir, "version-check.json");
  const writeCache = (dir, latest, at) => writeFileSync(cacheFile(dir), JSON.stringify({ latest, at }));

  test("on by default: a cold call performs exactly one fetch and prints the line", async () => {
    installCopy("0.2.2");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool()).execute({});
    expect(calls.length).toBe(1);
    expect(out.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
  });

  test("updateCheck: false prints no version line and performs zero fetches", async () => {
    installCopy("0.2.2");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool({ updateCheck: false })).execute({});
    expect(calls.length).toBe(0);
    expect(out).not.toContain("version ");
    expect(out).not.toContain("latest");
    expect(out.split("\n")[1]).toMatch(/^store /); // the store report sits where the line would be
  });

  test("updateCheck: false reads no cache: an entry stale enough to force a fetch stays unread and untouched", async () => {
    installCopy("0.2.2");
    const dir = store();
    writeCache(dir, "9.9.9", Date.now() - 25 * 60 * 60 * 1000); // past the 24 h TTL: a read would force a fetch
    const before = readFileSync(cacheFile(dir), "utf8");
    const calls = stubFetch(() => Response.json({ version: "0.2.3" }));
    const out = await (await statusTool({ store: { dir }, updateCheck: false })).execute({});
    expect(calls.length).toBe(0); // a read would have found the entry stale and fetched
    expect(out).not.toContain("version ");
    expect(readFileSync(cacheFile(dir), "utf8")).toBe(before); // and never refreshed it
  });

  test("MAGPIE_ACP_UPDATE_CHECK wins over user options in both directions", async () => {
    installCopy("0.2.2");

    process.env.MAGPIE_ACP_UPDATE_CHECK = "0";
    const off = stubFetch(() => Response.json({ version: "0.2.3" }));
    const offOut = await (await statusTool()).execute({}); // no option: the default is on
    expect(off.length).toBe(0);
    expect(offOut).not.toContain("version ");

    process.env.MAGPIE_ACP_UPDATE_CHECK = "1";
    const on = stubFetch(() => Response.json({ version: "0.2.3" }));
    const onOut = await (await statusTool({ updateCheck: false })).execute({}); // the option says off
    expect(on.length).toBe(1);
    expect(onOut.split("\n")[1]).toBe("version 0.2.2 · latest 0.2.3");
  });
});
