// Live gate proof: every safety gate, in phases, against a REAL gateway over HTTP.
//
// Phase 1 (wayfinder #15) was one run: one good range folds, three bad ranges are refused with
// their reasons, and `acp_status` shows all four. The legs added after 0.4.0 (the cap, the
// doubled floor over summaries, the elision and its latch) each need their own history shape and
// their own store, so each is a phase: its own session (and therefore its own store) and its own
// fixture. `PHASES=cap` runs one; the lane runs all of them, and any FAIL fails the release.
//
//   GW=http://127.0.0.1:3425 MODEL=fake/fake-1 SESSION=live-gates OUT=/out PHASES=cap bun gates.mjs
//
// Nothing is asserted on the model's reply: the ledger and the body the provider received
// (`CAPTURE=<dir>` holds one file per request) are the evidence. The cap and the elision are
// rewrites of the request, so a claim about them that only reads `acp_status` would be reading
// the plugin's own opinion of its work.
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

import { readdirSync, readFileSync, statSync } from "node:fs";

const GW = (process.env.GW ?? "http://127.0.0.1:3425").replace(/\/$/, "");
const MODEL = process.env.MODEL ?? "fake/fake-1";
const BASE = process.env.SESSION ?? `live-gates-${Date.now().toString(36)}`;
const OUT = process.env.OUT ?? "/out";
// The upstream's copy of the last request. The lane mounts it; a run outside the lane must say
// where it is, because `cap` and `elide` are claims about the bytes on the wire.
const CAPTURE = process.env.CAPTURE ?? `${OUT}/capture`;
const PHASES = String(process.env.PHASES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// The session under test. Every phase sets its own: the store is keyed by session, so a phase
// that ran before cannot hand its ledger to the next one, and a phase can be re-run alone.
let session = BASE;
let phase = "";
const failed = [];
const say = (line) => console.log(`[gates] ${line}`);
const check = (name, ok, detail = "") => {
  const full = `${phase}/${name}`;
  console.log(`[gates]   ${ok ? "ok  " : "FAIL"} ${full}${ok ? "" : ` - ${detail}`}`);
  if (!ok) failed.push(full);
};

// --- wire ------------------------------------------------------------------------------
async function send(list, label) {
  const body = { model: MODEL, messages: list, stream: false, max_tokens: 16, tools: [COMPRESS_TOOL] };
  let status = 0;
  let text = "";
  try {
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test", "x-magpie-session": session },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    text = `{"error":{"message":"${String(err)}"}}`;
  }
  await Bun.write(`${OUT}/gates-${phase}-${label}.json`, JSON.stringify({ status, request: body, reply: text.slice(0, 2000) }, null, 2));
  if (status === 0) say(`WARNING ${label}: the gateway did not answer - ${text.slice(0, 160)}`);
  say(`${label}: status=${status} units=${list.length}`);
  return { status, text };
}

/** What the provider received for the request just sent: the newest capture file. */
function upstreamBody() {
  let names = [];
  try {
    names = readdirSync(CAPTURE).filter((f) => f.endsWith(".body"));
  } catch {
    return "";
  }
  // By mtime, not by name: the counter restarts at 1 in every run, and a lane that runs twice
  // into one output directory would otherwise read a body left by an earlier, longer run.
  let last = "";
  let at = -1;
  for (const name of names) {
    const seen = statSync(`${CAPTURE}/${name}`).mtimeMs;
    if (seen > at) {
      at = seen;
      last = name;
    }
  }
  return last ? readFileSync(`${CAPTURE}/${last}`, "utf8") : "";
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

/** The ledger of this phase's session, in prose. One file per phase: the phase that fails is
 *  the one worth reading, and a single file keeps only the last. */
async function status(label) {
  const text = await callTool("acp_status", { session });
  await Bun.write(`${OUT}/gates-status-${phase}-${label}.txt`, text);
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

const refAt = (index) => `m${String(index + 1).padStart(5, "0")}`;
const spanOf = (from, to) => `${refAt(from)}–${refAt(to)}`;
const indexOfRef = (ref) => Number(String(ref).slice(1)) - 1;

/** The window the hook advertises, in message indices, or null when it advertised none. */
function windowOf(report) {
  const found = /可折窗口 (m\d+)–(m\d+)/.exec(report);
  return found ? { from: indexOfRef(found[1]), to: indexOfRef(found[2]), fromRef: found[1], toRef: found[2] } : null;
}

// --- phases ----------------------------------------------------------------------------
const phases = new Map();
const phaseOf = (name, fn) => phases.set(name, fn);

// The ack is the plugin's own sentence, taken from the tool rather than copied: a fixture
// that spells it by hand drifts the first time the wording changes.
async function ackTemplate() {
  const template = await callTool("compress", { content: "m00001–m00001 请求流水\n这是一次演示调用,只为取得本插件自己的回执句。" });
  say(`ack template: ${JSON.stringify(template.slice(0, 40))}`);
  return template;
}

// 1. The 0.4.0 trio: one good range folds, three bad ones are refused with their reasons.
phaseOf("default", async () => {
  const template = await ackTemplate();

  const messages = [];
  const push = (message) => messages.push(message) - 1;

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
  const window = windowOf(probe);
  if (!window) {
    say("the probe carried no foldable window; the hook is off, the tool gate refused it, or the store is empty");
    say(probe.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }
  const turns = turnsOf(messages);
  if (window.from >= messages.length || window.to >= messages.length) {
    say(`the window ${window.fromRef}–${window.toRef} reaches past the history this script built`);
    process.exit(1);
  }
  // The offer names citable units, and a fold settles whole turns: the range to ask for starts
  // where the window's first turn starts and ends at the last turn that closes inside the
  // window. Asking for the window's own end would drag in a turn that has not closed yet.
  const turnOf = (index) => turns.find((t) => index >= t.start && index <= t.end) ?? turns[turns.length - 1];
  const lastTurnEnd = turns.filter((t) => t.end <= window.to).pop()?.end ?? window.to;
  const good = spanOf(turnOf(window.from).start, lastTurnEnd);
  say(`window ${window.fromRef}–${window.toRef} -> folding ${good}`);
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
});

// 2. The cap: one unit over the threshold is cut, its original stored first, and the request that
// goes out carries a marker where the middle was.
phaseOf("cap", async () => {
  const SENTINEL = "MIDDLE-SENTINEL";
  // 34,000 CJK characters on each side of the sentinel is ~34,000 tokens: over the 32,000
  // default with room to spare, and far over the 2,000 characters the cap keeps. Pure CJK, no
  // punctuation, because every ASCII character costs a quarter token and this must not be a
  // borderline case. It is a tool result because prose is stamped, and a stamped unit is exempt
  // (`clipBlocker`: cutting it would leave a ref pointing at text the store no longer holds).
  const heavy = (n) => "摘要上下文".repeat(Math.ceil(n / 5)).slice(0, n);
  const huge = `CAP-HEAD:${heavy(17000)}${SENTINEL}${heavy(17000)}:CAP-TAIL`;
  const messages = [
    { role: "user", content: "读一下这份报告,只回答有几章。" },
    {
      role: "assistant",
      content: "先读文件。",
      tool_calls: [{ id: "call_read", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "report.md" }) } }],
    },
    { role: "tool", tool_call_id: "call_read", content: huge },
    { role: "assistant", content: "读完了,只有一章。" },
  ];

  await send(messages, "cap");
  const report = await status("cap");
  check("the cap cuts the oversized unit", /clips=1\b/.test(report), report.split("\n")[0]);
  const row = report.split("\n").find((line) => line.includes("裁剪:"));
  const id = /原文 id ([0-9a-f]{16})/.exec(row ?? "")?.[1] ?? "";
  check("the clipped original is named", Boolean(id), row ?? "no 裁剪 line");
  const lastRefusal = report.split("\n").find((line) => line.includes("没裁成"));
  check("no exempt unit was silently cut", !lastRefusal, lastRefusal ?? "");

  const wire = upstreamBody();
  check("the request that went out carries the marker", /\[acp\] 已省略 [\d,]+ 字符,原文 id [0-9a-f]{16}/.test(wire), wire.slice(0, 200));
  check("the cut removed the middle", wire !== "" && !wire.includes(SENTINEL), "sentinel still on the wire");
  check("the cut kept both edges", wire.includes("CAP-HEAD") && wire.includes("CAP-TAIL"), "an edge is missing");

  // The whole point of cutting before storing: the way back has to work.
  const back = id ? await callTool("decompress", { id }) : "";
  check("decompress returns the clipped original", back.includes(SENTINEL), back.slice(0, 160));
});

// 3. The doubled floor over summaries (#14): a range that is mostly summaries is refused a
// summary a plain range accepts.
phaseOf("condensed", async () => {
  const template = await ackTemplate();
  // A summary over the plain floor (40) and under the doubled one (80): 20 CJK characters are
  // 60 bytes, so this one sentence is the whole difference between the two gates.
  const thin = "折过了,详细内容在原处,这里只记一句。";
  say(`the thin summary is ${new TextEncoder().encode(thin).length} bytes (plain floor 40, condensed floor 80)`);

  // Half A: the material is fold markers, so the range is *all* summary. The markers are written
  // by hand - the hook only reads their shape and a real fold needs a client - and they sit after
  // our own call, because our traffic is a barrier the window may not start before.
  session = `${BASE}-condensed-summaries`;
  const markers = [
    `[acp] m00002–m00009 早期需求\n${filler(200, "摘要1")}`,
    `[acp] m00010–m00017 方案对比\n${filler(200, "摘要2")}`,
    `[acp] m00018–m00025 结论与遗留\n${filler(200, "摘要3")}`,
  ];
  const condensedCall = callMessage("call_condensed");
  condensedCall.tool_calls[0].function.arguments = JSON.stringify({ content: `${spanOf(3, 5)} 前面几段\n${thin}` });
  const condensed = [
    { role: "user", content: "把前面几段折掉,然后把要点理一遍。" },
    condensedCall,
    ackMessage("call_condensed", template),
    ...markers.map((text) => ({ role: "assistant", content: text })),
    { role: "user", content: "继续。" },
  ];
  await send(condensed, "summaries");
  const report = await status("summaries");
  const why = report.split("\n").find((l) => l.includes("没生效")) ?? report.split("\n")[0];
  const refused = report.split("\n").find((line) => line.includes("已经是你写的摘要") && line.includes("至少要 80 字节"));
  check("a range of summaries is refused a thin summary", Boolean(refused), why);
  // The coding standard: a refusal names the unit that caused it and where the range may start
  // instead. Here the cause is the first marker in the span, and the way out is either a summary
  // that carries the thread or a range that begins after that marker.
  check(
    "the refusal names the earliest summary and a way out",
    Boolean(refused) && /最早一条是 m\d{5}/.test(refused) && /就把范围收在 m\d{5} 之后/.test(refused),
    refused ?? why,
  );
  check("the thin summary settles nothing there", /folds=0\b/.test(report), report.split("\n")[0]);

  // Half B: the same sentence over ordinary prose. Same summary, same config, different material -
  // and the plain floor accepts it. A gate that refused both would be a wall, not a judgment.
  session = `${BASE}-condensed-prose`;
  const proseCall = callMessage("call_plain");
  proseCall.tool_calls[0].function.arguments = JSON.stringify({ content: `${spanOf(0, 1)} 早期\n${thin}` });
  const prose = [
    { role: "user", content: `${filler(600, "第1轮")}\n把方案讲清楚。` },
    { role: "assistant", content: filler(600, "回答1") },
    { role: "user", content: "再说一遍。" },
    proseCall,
    ackMessage("call_plain", template),
  ];
  await send(prose, "prose");
  const plain = await status("prose");
  check("the same summary over prose settles", /folds=1\b/.test(plain), plain.split("\n").find((l) => l.includes("没生效")) ?? plain.split("\n")[0]);
});

// 4. The elision and its latch (#19): a declared ceiling is crossed, whole turns leave the wire,
// a second request over the same history goes out the same way, a real fold clears the latch, and
// the count starts over instead of carrying on.
phaseOf("elide", async () => {
  // 12 short turns: over a 4000-token ceiling (each pair is ~400 tokens), and still deep enough
  // that eliding down to 75% leaves two turns a fold can take.
  const messages = [];
  for (let i = 1; i <= 12; i += 1) {
    messages.push({ role: "user", content: `第${i}轮:${filler(200, `议题${i}`)}` });
    messages.push({ role: "assistant", content: filler(200, `结论${i}`) });
  }
  messages.push({ role: "user", content: "继续,把结论汇总一下。" });
  say(`history: ${messages.length} units, ${messages.reduce((n, m) => n + textOf(m).length, 0)} characters`);

  await send(messages, "over");
  const over = await status("over");
  check("an over-limit request is elided", /elides=1\b/.test(over), over.split("\n")[0]);
  const dropped = over.split("\n").find((line) => line.includes("省略:"));
  check("the ledger names the dropped span", Boolean(dropped), "no 省略 line");

  const first = upstreamBody();
  const statement = /\[acp\] 已省略 (m\d+)–(m\d+) 共 (\d+) 条\(机械省略,没有摘要;每条原文都存着/.exec(first);
  check("the statement reads as mechanical, not as a fold", Boolean(statement), first.slice(0, 240));
  check("the statement is not written as a fold marker", !/\[acp\] m\d{5,}–m\d{5,}/.test(first), "a fold marker is on the wire");
  check("the dropped turn is gone from the wire", !first.includes("议题1:"), "the first turn is still there");
  check("the newest turn survives", first.includes("议题12:") && first.includes("继续,把结论汇总一下。"), "the tail is missing");
  check("the elision starts at the window's first turn", statement?.[1] === "m00001", `starts at ${statement?.[1]}`);

  const restored = statement ? await callTool("decompress", { id: statement[1] }) : "";
  check("decompress returns a dropped turn", restored.includes("议题1:"), restored.slice(0, 160));

  // The same history again: the elision is recomputed to the same statement. The nudge is not
  // part of that claim - it is shown once per growth epoch by design (#20) - so it is stripped
  // before the comparison.
  await send(messages, "again");
  const second = upstreamBody();
  // The nudge is stripped on the decoded messages: on the raw body it sits inside a JSON string,
  // where a newline pattern would swallow the rest of the file instead of one sentence.
  const withoutNudge = (body) => {
    try {
      const parsed = JSON.parse(body);
      parsed.messages = parsed.messages.map((m) =>
        typeof m.content === "string" ? { ...m, content: m.content.replace(/\n?\[acp\] 上下文自上次折叠后[^\n]*/g, "") } : m,
      );
      return JSON.stringify(parsed);
    } catch {
      return body;
    }
  };
  check(
    "the same history is elided the same way",
    statement !== null && second.includes(statement[0]) && withoutNudge(first) === withoutNudge(second),
    `${first.length} vs ${second.length} characters`,
  );
});

phaseOf("latch-cleared", async () => {
  const template = await ackTemplate();
  // The latch (#19) counts passes that are still over the line after the elision, so its history
  // must not be fixable: the newest turn alone is over the ceiling and it is the one turn the
  // elision may not take, so every pass is stuck. Three in a row is when the plugin says to
  // start a new session. The fold that clears the latch goes in front of the turns it names:
  // own tool traffic is a barrier, and the window starts after it.
  session = `${BASE}-elide-latch`;
  const lineOf = (report) => report.split("\n").find((l) => l.includes("窗口:")) ?? "";
  const oldUser = { role: "user", content: `旧的一轮:${filler(500, "旧")}` };
  const oldAnswer = { role: "assistant", content: filler(500, "答") };
  const thick = { role: "user", content: `这一轮很长:${filler(5200, "厚")}` };
  const latched = [oldUser, oldAnswer, thick];
  await send(latched, "latch-1");
  const latchOne = await status("latch-1");
  check(
    "an unfixable pass is elided and counted",
    /elides=1\b/.test(latchOne) && /连续第 1 轮/.test(lineOf(latchOne)),
    lineOf(latchOne) || latchOne.split("\n")[0],
  );
  await send(latched, "latch-2");
  const latchTwo = await status("latch-2");
  check("the latch counts the pass, not the fold", /连续第 2 轮/.test(lineOf(latchTwo)), lineOf(latchTwo) || latchTwo.split("\n")[0]);
  await send(latched, "latch-3");
  const latchThree = await status("latch-3");
  check(
    "three stuck passes say to start a new session",
    /连续第 3 轮/.test(lineOf(latchThree)) && /本轮已经说过:该开一个新会话了/.test(latchThree),
    lineOf(latchThree) || latchThree.split("\n")[0],
  );

  const win = windowOf(latchThree);
  if (!win) {
    // Without a window the fold call would carry "undefined–undefined" and fail for the wrong
    // reason: say what actually went missing.
    say("the latch pass advertised no foldable window, so there is nothing to fold away from the latch");
    say(lineOf(latchThree) || latchThree.split("\n")[0]);
    process.exit(1);
  }
  const foldCall = callMessage("call_latch_fold");
  foldCall.tool_calls[0].function.arguments = JSON.stringify({ content: `${win.fromRef}–${win.toRef} 旧的一轮\n${summary}` });
  const folded = [{ role: "user", content: "开始。" }, foldCall, ackMessage("call_latch_fold", template), ...latched];
  say(`folding ${win.fromRef}–${win.toRef} while the latch is set`);
  await send(folded, "fold");
  const afterFold = await status("fold");
  const windowAfter = lineOf(afterFold);
  check("a real fold settles under pressure", /folds=1\b/.test(afterFold), afterFold.split("\n").find((l) => l.includes("没生效")) ?? afterFold.split("\n")[0]);
  check("the request stayed over the line", /超过 95% 线/.test(windowAfter), windowAfter);
  check("the fold clears the latch", windowAfter !== "" && !/连续第/.test(windowAfter), windowAfter);

  // And the unfixable history again, with the count starting over: a fold answered the pressure,
  // so this is the first pass of a new stuck run.
  await send(latched, "latch-again");
  const againLatch = await status("latch-again");
  check("the next pass counts from one again", /连续第 1 轮/.test(lineOf(againLatch)), lineOf(againLatch) || againLatch.split("\n")[0]);
});

// --- the run ---------------------------------------------------------------------------
const wanted = PHASES.length ? PHASES : [...phases.keys()];
for (const name of wanted) {
  const fn = phases.get(name);
  if (!fn) {
    failed.push(`${name}/exists`);
    say(`no phase ${name}; known: ${[...phases.keys()].join(", ")}`);
    continue;
  }
  phase = name;
  session = `${BASE}-${name}`;
  mcpSession = null;
  say(`=== ${name}: session ${session}`);
  await fn();
  say(`--- ${name}: ${failed.length ? `${failed.length} failure(s) so far` : "clean"}`);
}

say(failed.length ? `${failed.length} gate(s) did not fire: ${failed.join(", ")}` : `OK - ${wanted.length} phase(s) clean: ${wanted.join(", ")}`);
process.exit(failed.length ? 1 : 0);
