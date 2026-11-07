import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acpTools from "../tools.mjs";
import { compareVersions } from "../src/version.mjs";

describe("compareVersions", () => {
  test("tolerates the leading v a git tag carries: v0.2.3 equals 0.2.3", () => {
    expect(compareVersions("v0.2.3", "0.2.3")).toBe(0);
    expect(compareVersions("0.2.3", "v0.2.3")).toBe(0);
  });

  test("orders components numerically, not as strings: 0.2.10 is newer than 0.2.9", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.9", "0.2.10")).toBeLessThan(0);
  });

  test("a prerelease orders below its release", () => {
    expect(compareVersions("0.2.3-rc.1", "0.2.3")).toBeLessThan(0);
    expect(compareVersions("0.2.3", "0.2.3-rc.1")).toBeGreaterThan(0);
  });

  test("an unparsable version on either side compares to nothing", () => {
    expect(compareVersions("0.2.x", "0.2.3")).toBe(null);
    expect(compareVersions("0.2.3", "main")).toBe(null);
  });
});

describe("acp_status comparison edges", () => {
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
  });

  const statusOut = async () => {
    const tools = await acpTools(undefined, { store: { dir: mkdtempSync(join(tmpdir(), "acp-ver3-")) } });
    return tools.tool.acp_status.execute({});
  };

  const stubFetch = (version) => {
    globalThis.fetch = () => Response.json({ version });
  };

  const installCopy = (version) => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-ver3-copy-"));
    const dir = join(cwd, "plugins", "node_modules", "magpie-acp-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "magpie-acp-context", version }));
    process.chdir(cwd);
  };

  test("a local build ahead of anything published is named, never a fake latest", async () => {
    installCopy("0.3.0");
    stubFetch("0.2.3");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.3.0 · local build");
    expect(out).not.toContain("latest");
  });

  test("the opposite direction: an older running copy shows the published newest, not local build", async () => {
    installCopy("0.2.3");
    stubFetch("0.2.4");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.3 · latest 0.2.4");
    expect(out).not.toContain("local build");
  });

  test("a leading v, as a git tag carries, compares equal: current is not behind", async () => {
    installCopy("0.2.3");
    stubFetch("v0.2.3");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.3");
    expect(out).not.toContain("latest");
    expect(out).not.toContain("local build");
  });

  test("a leading v on a newer published version still counts as newer", async () => {
    installCopy("0.2.3");
    stubFetch("v0.2.4");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.3 · latest v0.2.4");
  });

  test("a prerelease running copy is behind its release", async () => {
    installCopy("0.2.3-rc.1");
    stubFetch("0.2.3");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.3-rc.1 · latest 0.2.3");
  });

  test("a release running against a published prerelease of the same number is a local build", async () => {
    installCopy("0.2.3");
    stubFetch("0.2.3-rc.1");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.3 · local build");
  });

  test("behind by several releases still names the newest, not a count", async () => {
    installCopy("0.2.0");
    stubFetch("0.2.5");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.0 · latest 0.2.5");
  });

  test("numeric per component at the entry point: 0.2.10 is newer than 0.2.9", async () => {
    installCopy("0.2.9");
    stubFetch("0.2.10");
    const out = await statusOut();
    expect(out.split("\n")[1]).toBe("version 0.2.9 · latest 0.2.10");
  });

  test("an unparsable published version is a failed check: no line, no claim of being current", async () => {
    installCopy("0.2.3");
    stubFetch("main");
    const out = await statusOut();
    expect(out.split("\n")[1]).not.toContain("version ");
    expect(out).not.toContain("latest");
    expect(out).not.toContain("local build");
  });

  test("an unparsable running version is a failed comparison: no line, no claim of being current", async () => {
    installCopy("0.2.x");
    stubFetch("0.2.5");
    const out = await statusOut();
    expect(out.split("\n")[1]).not.toContain("version ");
    expect(out).not.toContain("latest");
    expect(out).not.toContain("local build");
  });

  test("a published version carrying a newline never reaches the tool result", async () => {
    installCopy("0.2.3");
    stubFetch("0.2.4\nstore 伪造");
    const out = await statusOut();
    expect(out).not.toContain("伪造");
  });

  test("an unparsable published version backs off like any other failure", async () => {
    installCopy("0.2.3");
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Response.json({ version: "main" });
    };
    const store = { store: { dir: mkdtempSync(join(tmpdir(), "acp-ver3-unp-")) } };
    const out1 = await (await acpTools(undefined, store)).tool.acp_status.execute({});
    const out2 = await (await acpTools(undefined, store)).tool.acp_status.execute({});
    expect(calls).toBe(1);
    expect(out1).not.toContain("version ");
    expect(out2).not.toContain("version ");
  });
});

describe("compareVersions prerelease ordering", () => {
  test("numeric identifiers order below alphanumeric ones", () => {
    expect(compareVersions("0.2.3-rc.2", "0.2.3-rc.beta")).toBeLessThan(0);
    expect(compareVersions("0.2.3-rc.beta", "0.2.3-rc.2")).toBeGreaterThan(0);
  });

  test("a shorter identifier list orders below its extension", () => {
    expect(compareVersions("0.2.3-rc", "0.2.3-rc.1")).toBeLessThan(0);
    expect(compareVersions("0.2.3-rc.1", "0.2.3-rc")).toBeGreaterThan(0);
  });
});
