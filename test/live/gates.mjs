// Live gate proof (wayfinder #15): one good range folds, three bad ranges are refused with
// their reasons, and `acp_status` shows all four.
//
// This talks to a REAL gateway over HTTP - the container lane runs it against the fake
// provider, so the same hook code a user runs decides here. Bun is the only HTTP client, no
// SDK, so the wire stays visible. Nothing is asserted on the model's reply: the ledger is
// the evidence.
//
//   GW=http://127.0.0.1:3425 MODEL=fake/fake-1 SESSION=live-gates OUT=/out bun gates.mjs
//
// Ranges are derived, never typed. Three facts make that safe, and all three are checked:
//   - a ref is allocated once per distinct text and kept in the store, so refs are positions
//     only while no text changes. The first request therefore carries every message the
//     script will ever send, with a placeholder range on every call ("m00002–m00001",
//     refused as 起点在终点之后, can never fold), and the real ranges are patched into the
//     arguments afterwards. A unit's text includes its tool arguments, so the four patched
//     calls get FRESH refs at the end of the ledger, while every unchanged unit keeps the
//     one it was given in order - which is why no range below has a call for an endpoint.
//     That is the mistake this file exists to not repeat twice: refs are ledger order,
//     not positions in the request, and the ledger keeps what earlier requests added;
//   - the foldable window is read back from `acp_status`, so the same script holds under
//     `keepRecentTurns: 3` and under the container lane's 1;
//   - the history is shaped the way the hook judges it: our own tool traffic is a barrier
//     the offer may not start before, so the calls come first and the turns to fold sit
//     wholly after them. Putting the calls next to the last user message is worse than
//     untidy - the window's own end lands on a call, the barrier trim then starts after
//     it, and the offer collapses to null.

const GW = (process.env.GW ?? "http://127.0.0.1:3425").replace(/\/$/, "");
const MODEL = process.env.MODEL ?? "fake/fake-1";
const SESSION = process.env.SESSION ?? `live-gates-${Date.now().toString(36)}`;
const OUT = process.env.OUT ?? "/out";

const failed = [];
const say = (line) => console.log(`[gates] ${line}`);
const check = (name, ok, detail = "") => {
  console.log(`[gates]   ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` - ${detail}`}`);
  if (!ok) failed.push(name);
};

// --- wire ------------------------------------------------------------------------------
async function send(list, label) {
  const body = { model: MODEL, messages: list, stream: false, max_tokens: 16, tools: [COMPRESS_TOOL] };
  let status = 0;
  let text = "";
  try {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test", "x-magpie-session": SESSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    text = `{"error":{"message":"${String(err)}"}}`;
  }
  await Bun.write(`${OUT}/gates-${label}.json`, JSON.stringify({ status, request: body, reply: text.slice(0, 2000) }, null, 2));
  say(`${label}: status=${status} units=${list.length}`);
  return { status, text };
}

let mcpSession = null;
let rpcId = 0;
const MCP_URL = `${GW}/mcp/magpie/tools`;

async function rpc(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  const text = await res.text();
  let payload = null;
  for (const line of text.split("\n")) {
    const raw = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!raw) continue;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* not a json line */
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

const toolName = async (suffix) => {
  const names = (await rpc("tools/list", {}))?.result?.tools?.map((t) => t.name) ?? [];
  const found = names.includes(suffix) ? suffix : names.find((n) => n.endsWith(`_${suffix}`));
  if (!found) throw new Error(`no ${suffix} tool: ${names.join(",") || "none"}`);
  return found;
};

async function callTool(suffix, args) {
  if (!mcpSession) {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acp-gates", version: "0" } });
    await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(mcpSession ? { "mcp-session-id": mcpSession } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  }
  const res = await rpc("tools/call", { name: await toolName(suffix), arguments: args });
  return (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** The ledger of this session's last request, in prose. One file per phase: the phase that
 *  fails is the one worth reading, and a single file keeps only the last. */
async function status(label) {
  const text = await callTool("acp_status", { session: SESSION });
  await Bun.write(`${OUT}/gates-status-${label}.txt`, text);
  return text;
}

// --- fixture ---------------------------------------------------------------------------
// CJK costs ~1 token per char, so 600 chars is ~1800 bytes: a turn clears any sane
// minRangeBytes and the send stays small enough for a real provider.
const CJK = "上下文压缩会把历史折成一段摘要,原文存在本地按内容寻址,需要时再取回来。";
const filler = (chars, tag) => `${tag}:` + CJK.repeat(Math.ceil(chars / CJK.length)).slice(0, chars);

const COMPRESS_TOOL = {
  type: "function",
  function: {
    name: "compress",
    description: "Fold a range of the transcript into a summary.",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
  },
};

const summary = "早期需求是把方案讲清楚,这件事已经做完,结论记在这儿。";
// The arguments are a placeholder until the real ranges are known; out of order, so the
// first pass can settle nothing.
const PLACEHOLDER = "m00002–m00001";
const callMessage = (id) => ({
  role: "assistant",
  content: `把 ${id} 指的那几轮折掉。`,
  tool_calls: [{ id, type: "function", function: { name: "compress", arguments: JSON.stringify({ content: `${PLACEHOLDER} 早期需求\n${summary}` }) } }],
});
const ackMessage = (id, template) => ({ role: "tool", tool_call_id: id, content: `${template} (${id})` });

/** Turns start at a user message, or at an assistant answering a tool output. */
function turnsOf(list) {
  const turns = [];
  for (let i = 0; i < list.length; i += 1) {
    const starts = list[i].role === "user" || (list[i].role === "assistant" && list[i - 1]?.role === "tool");
    if (starts || turns.length === 0) turns.push({ start: i, end: i });
    else turns[turns.length - 1].end = i;
  }
  return turns;
}

const textOf = (message) => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n");
};

// --- the run ---------------------------------------------------------------------------
// The ack is the plugin's own sentence, taken from the tool rather than copied: a fixture
// that spells it by hand drifts the first time the wording changes.
const template = await callTool("compress", { content: "m00001–m00001 请求流水\n这是一次演示调用,只为取得本插件自己的回执句。" });
say(`ack template: ${JSON.stringify(template.slice(0, 40))}`);

const messages = [];
const push = (message) => messages.push(message) - 1;
const refAt = (index) => `m${String(index + 1).padStart(5, "0")}`;
const spanOf = (from, to) => `${refAt(from)}–${refAt(to)}`;

// 0..2 - a screenshot with text on both sides, so a media unit sits between two citable
// messages and a range can name it without hitting a tool endpoint first.
const mediaUser = push({ role: "user", content: "看一下这张截图,判断趋势。" });
push({
  role: "user",
  content: [
    { type: "text", text: "截图里是一条折线。" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==" } },
  ],
});
const mediaReply = push({ role: "assistant", content: "图里是一条向上的折线。" });

// 3 - the turn that asks for the four folds, then the four calls and their acks. Our own
// traffic is a barrier the offer may not start before, so it belongs before the turns to
// fold, not beside the last user message. It also supplies the own-record gate: the range
// below spans these calls, so the hook has a real record on the wire to refuse.
const ownRecordFrom = push({ role: "user", content: "把这四件事分别折一下,顺序来。" });
const goodCall = push(callMessage("call_good"));
push(ackMessage("call_good", template));
const ownCall = push(callMessage("call_own"));
push(ackMessage("call_own", template));
const mediaCall = push(callMessage("call_media"));
push(ackMessage("call_media", template));
const newestCall = push(callMessage("call_newest"));
push(ackMessage("call_newest", template));
// 12 - one plain answer after the last ack. Without it the window's end would be a call of
// ours, and the barrier trim would start after it - leaving no window at all.
const ownRecordTo = push({ role: "assistant", content: "记下了,下面几轮是新的内容。" });

// 13..28 - the turns a fold should take.
for (let i = 1; i <= 8; i += 1) {
  push({ role: "user", content: `${filler(600, `第${i}轮`)}\n把方案讲清楚第${i}点。` });
  push({ role: "assistant", content: filler(600, `回答${i}`) });
}
// 29 - a last user message: the newest turn is protected, which is what the newest-turn gate
// refuses.
const last = push({ role: "user", content: "继续,先到这儿。" });

// A ref is a position only while no two units share a text, and only because this first
// request introduces every one of them. Prove it instead of trusting it - a repeated
// sentence here would move every ref after it and every range below would name the wrong
// span.
const keys = messages.map((m) => `${m.role}\u0000${textOf(m)}`);
const twin = keys.find((key, i) => keys.indexOf(key) !== i);
check("every unit is its own block, so a ref is a position", twin === undefined, JSON.stringify(twin?.slice(0, 60)));

// 1. One request with the whole history, every call naming a range that cannot settle. It
//    numbers the units and answers with the foldable window the gate request will see.
await send(messages, "probe");
const probe = await status("probe");
const window = /可折窗口 (m\d+)–(m\d+)/.exec(probe);
if (!window) {
  say("the probe carried no foldable window; the hook is off, the tool gate refused it, or the store is empty");
  say(probe.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}
const indexOfRef = (ref) => Number(ref.slice(1)) - 1;
const turns = turnsOf(messages);
const winFrom = indexOfRef(window[1]);
const winTo = indexOfRef(window[2]);
if (winFrom >= messages.length || winTo >= messages.length) {
  say(`the window ${window[1]}–${window[2]} reaches past the history this script built`);
  process.exit(1);
}
// The offer names citable units, and a fold settles whole turns: the range to ask for starts
// where the window's first turn starts and ends at the last turn that closes inside the
// window. Asking for the window's own end would drag in a turn that has not closed yet.
const turnOf = (index) => turns.find((t) => index >= t.start && index <= t.end) ?? turns[turns.length - 1];
const lastTurnEnd = turns.filter((t) => t.end <= winTo).pop()?.end ?? winTo;
const good = spanOf(turnOf(winFrom).start, lastTurnEnd);
say(`window ${window[1]}–${window[2]} -> folding ${good}`);
check("a range that cannot resolve settles nothing", /folds=0\b/.test(probe), probe.split("\n")[0]);

// 2. The same history, four real ranges. Patching a call's arguments gives that one unit a
//    new text, so it takes a fresh ref at the end of the ledger; every unchanged unit keeps
//    the ref it was given in the first send, which is why `good` and the three bad spans
//    still resolve where the window said. No range below has a call for an endpoint.
const ownRecord = spanOf(ownRecordFrom, ownRecordTo);
const media = spanOf(mediaUser, mediaReply);
const newest = spanOf(last, last);
const patch = (index, range) => {
  messages[index].tool_calls[0].function.arguments = JSON.stringify({ content: `${range} 早期需求\n${summary}` });
};
patch(goodCall, good);
patch(ownCall, ownRecord);
patch(mediaCall, media);
patch(newestCall, newest);
say(`refusals: own record ${ownRecord} · media ${media} · newest turn ${newest}`);

await send(messages, "gates");
const gates = await status("gates");
check("one good range folds", /folds=1\b/.test(gates), gates.split("\n")[0]);
const foldRow = gates.split("\n").find((line) => line.includes(good) && line.includes("字节("));
check("the fold is the span that was asked for", Boolean(foldRow), good);
const reasons = [
  ["own record", ownRecord, "范围含插件自己的压缩记录"],
  ["media", media, "范围含媒体消息"],
  ["newest turn", newest, "范围对不齐整轮"],
];
for (const [label, range, reason] of reasons) {
  const line = gates.split("\n").find((l) => l.includes(`${range}:`) && l.includes(reason));
  check(`${label} is refused with its reason`, Boolean(line), `${range} / ${reason}`);
}

// 3. A rejection is advice, not a fold: the ledger still says one.
check("a refused range never folds", /folds=1\b/.test(gates), gates.split("\n")[0]);

say(failed.length ? `${failed.length} gate(s) did not fire: ${failed.join(", ")}` : "OK - one fold, three refusals, all four in acp_status");
process.exit(failed.length ? 1 : 0);
