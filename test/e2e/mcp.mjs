// Minimal MCP client (Streamable HTTP) for the test: initialize, list tools, call one.
// Bun is the only HTTP client in the image; no SDK, so the wire stays visible in the test.
const [base, ...rest] = process.argv.slice(2);
const url = `${base}/mcp/magpie/tools`;

let session = null;
let id = 0;

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers, body });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  const text = await res.text();
  let payload = null;
  for (const line of text.split("\n")) {
    const t = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!t) continue;
    try {
      payload = JSON.parse(t);
    } catch {
      /* not this line */
    }
  }
  if (!payload) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 400), status: res.status };
    }
  }
  return payload;
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "acp-e2e", version: "0" },
});
await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});

const list = await rpc("tools/list", {});
const names = (list?.result?.tools ?? []).map((t) => t.name);
console.log(`[mcp] init=${init?.result ? "ok" : JSON.stringify(init)} tools=${names.length}: ${names.join(",")}`);

const calls = [];
for (let i = 0; i < rest.length; i += 2) {
  const name = rest[i];
  const args = JSON.parse(rest[i + 1] ?? "{}");
  const res = await rpc("tools/call", { name, arguments: args });
  const text = (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  calls.push({ name, isError: Boolean(res?.result?.isError), text });
  console.log(`[mcp] ${name}(${JSON.stringify(args)}) → isError=${Boolean(res?.result?.isError)}`);
}

await Bun.write(`${process.env.OUT ?? "/out"}/mcp.json`, JSON.stringify({ names, calls }, null, 2));
