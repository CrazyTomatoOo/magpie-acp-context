/**
 * The matrix: every gate, every wire, both directions.
 *
 * Row format (this is the thing #12 asked us to decide):
 *
 *   { gate, direction, turns, over, expect }
 *
 * - `gate`      one name from `GATES`; the name a failure prints.
 * - `direction` "fires" (the gate acts: it refuses, widens, clips, or stamps) or "holds"
 *               (the gate steps aside and the request behaves as if it were not there).
 * - `turns`     one abstract transcript, translated to each wire by `wireBody` — so a row is
 *               written once and executed four times, which is the whole point: a gate that
 *               reads the body differently across wires shows up as a red row on one wire.
 * - `over`      option overrides for the run.
 * - `expect`    one assertion function over `{ out, body, wire, record, session, units }`.
 *
 * A gate that never reads the body (`knownLimit`, `session.elide`, `overLimit`) lives in
 * `ELSEWHERE` instead: asserting it four times would be one assertion copied four times.
 *
 * The drift guard is `§7 rows map to gates`: every identifier in the design doc's decision
 * table must belong to a matrix gate. Adding a gate means adding a §7 row (docs/agents/
 * coding-standards.md), which turns that guard red until the rows exist here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest, planFolds } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";
import { scanStore } from "../src/maintenance.mjs";
import { adapterFor, SUPPORTED } from "../src/protocol.mjs";
import { blockIdOf } from "../src/text.mjs";

const WIRES = SUPPORTED;
const FOLDER = "call_fold";
const SYSTEM_TEXT = "You are a careful agent. Keep answers short.";

const store = () => ({ dir: mkdtempSync(join(tmpdir(), "acp-matrix-")) });
const opts = (over = {}) => ({ enabled: true, keepRecentTurns: 1, minRangeBytes: 1000, store: store(), ...over });
const ctxOf = (options, wire) => ({ protocol: wire, origin: "local", session: "matrix", options });
const sessionOf = (options) => scanStore(options.store.dir).sessions[0];
const ackText = (id = FOLDER) => `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。(${id})`;
const ref = (n) => `m${String(n).padStart(5, "0")}`;

/* ------------------------------------------------------------------ the abstract turns */

const U = (text) => ({ kind: "user", text });
const A = (text) => ({ kind: "assistant", text });
const CALL = (name, args, id = "call_1") => ({ kind: "call", name, args, id });
const RES = (id, text) => ({ kind: "tool", id, text });
const MEDIA = (text) => ({ kind: "media", text });

const PAD = "x".repeat(500);
const prose = (turns = 3, size = PAD) => {
  const out = [];
  for (let i = 1; i <= turns; i += 1) {
    out.push(U(`第 ${i} 轮提问,内容只是填充,用来把窗口撑到字节下限以上。${"x".repeat(size.length)}`));
    out.push(A(`第 ${i} 轮回答,同样只是填充,不需要逐字保留。${"y".repeat(size.length)}`));
  }
  return out;
};

/** The turn a fold is asked from: a request of its own, so the fold settles and the request stays legal. */
const foldTurn = (range, body = "前几轮问答都是填充内容,已经完成,不需要逐字保留。", name = "compress") => [
  U("把前面那几轮折掉。"),
  CALL(name, { content: `${range} 早期需求\n${body}` }, FOLDER),
  RES(FOLDER, ackText()),
  U("继续"),
];

/* ---------------------------------------------------------------- the four wire forms */

function chatTurn(turn) {
  switch (turn.kind) {
    case "user":
      return { role: "user", content: turn.text };
    case "assistant":
      return { role: "assistant", content: turn.text };
    case "call":
      return { role: "assistant", content: "", tool_calls: [{ id: turn.id, type: "function", function: { name: turn.name, arguments: JSON.stringify(turn.args) } }] };
    case "tool":
      return { role: "tool", tool_call_id: turn.id, content: turn.text };
    case "media":
      return { role: "user", content: [{ type: "text", text: turn.text }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] };
    default:
      throw new Error(`unknown turn ${turn.kind}`);
  }
}

function anthropicTurn(turn) {
  switch (turn.kind) {
    case "user":
      return { role: "user", content: [{ type: "text", text: turn.text }] };
    case "assistant":
      return { role: "assistant", content: [{ type: "text", text: turn.text }] };
    case "call":
      return { role: "assistant", content: [{ type: "tool_use", id: turn.id, name: turn.name, input: turn.args }] };
    case "tool":
      return { role: "user", content: [{ type: "tool_result", tool_use_id: turn.id, content: turn.text }] };
    case "media":
      return {
        role: "user",
        content: [{ type: "text", text: turn.text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
      };
    default:
      throw new Error(`unknown turn ${turn.kind}`);
  }
}

function responsesTurn(turn) {
  switch (turn.kind) {
    case "user":
      return { type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] };
    case "assistant":
      return { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] };
    case "call":
      return { type: "function_call", call_id: turn.id, name: turn.name, arguments: JSON.stringify(turn.args) };
    case "tool":
      return { type: "function_call_output", call_id: turn.id, output: turn.text };
    case "media":
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: turn.text }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }],
      };
    default:
      throw new Error(`unknown turn ${turn.kind}`);
  }
}

function geminiTurn(turn) {
  switch (turn.kind) {
    case "user":
      return { role: "user", parts: [{ text: turn.text }] };
    case "assistant":
      return { role: "model", parts: [{ text: turn.text }] };
    case "call":
      return { role: "model", parts: [{ functionCall: { name: turn.name, args: turn.args } }] };
    case "tool":
      return { role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: turn.text } } }] };
    case "media":
      return { role: "user", parts: [{ text: turn.text }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] };
    default:
      throw new Error(`unknown turn ${turn.kind}`);
  }
}

const TURN_OF = { chat: chatTurn, anthropic: anthropicTurn, responses: responsesTurn, gemini: geminiTurn };

/** One abstract transcript → the four bodies. Nothing wire-specific leaks into a row. */
function wireBody(wire, turns, { system = SYSTEM_TEXT } = {}) {
  const convert = TURN_OF[wire];
  if (!convert) throw new Error(`no wire ${wire}`);
  if (wire === "chat") return { model: "m", messages: [{ role: "system", content: system }, ...turns.map(convert)] };
  if (wire === "anthropic") return { model: "m", system, messages: turns.map(convert) };
  if (wire === "responses") return { model: "m", instructions: system, input: turns.map(convert) };
  return { model: "m", systemInstruction: { role: "system", parts: [{ text: system }] }, contents: turns.map(convert) };
}

const readOf = (body, wire) => adapterFor(wire).read(body);
const findUnit = (units, needle) => units.findIndex((unit) => unit.text.includes(needle));
const unitsOf = (body, wire) => adapterFor(wire).unitArray(body);
const systemOf = (body, wire) => {
  if (wire === "chat") return String(body.messages?.[0]?.content ?? "");
  if (wire === "anthropic") return String(body.system ?? "");
  if (wire === "responses") return String(body.instructions ?? "");
  return String(body.systemInstruction?.parts?.[0]?.text ?? "");
};
const summaryOf = (options, out, wire) => ({
  out,
  units: readOf(out, wire),
  session: sessionOf(options),
  record: sessionOf(options)?.request,
});

function run(wire, turns, over = {}, system) {
  const options = opts(over);
  const body = wireBody(wire, turns, { system: system ?? SYSTEM_TEXT });
  return onRequest(structuredClone(body), ctxOf(options, wire)).then((out) => ({
    body,
    out: out ?? structuredClone(body),
    changed: out !== undefined,
    options,
    wire,
    ...summaryOf(options, out ?? structuredClone(body), wire),
  }));
}

/* ----------------------------------------------------------------------- the rows */

/** `gate` → its rows. Both directions are mandatory; the runner multiplies by wire. */
const ROWS = [];

const row = (gate, direction, turns, expect, over = {}, system) => ROWS.push({ gate, direction, turns, over, expect, system });

/* stampable: prose wears a ref, tool traffic does not. */
row(
  "stampable",
  "fires",
  [...prose(2), U("继续")],
  ({ units }) => {
    const proseUnits = units.filter((unit) => unit.role !== "system");
    expect(proseUnits[0].text.startsWith(`[${ref(1)}] `)).toBe(true);
    expect(proseUnits[1].text.startsWith(`[${ref(2)}] `)).toBe(true);
  },
);
row(
  "stampable",
  "holds",
  [...prose(1), CALL("read_file", { path: "a.txt" }, "r1"), RES("r1", "文件内容".repeat(200)), U("继续")],
  ({ units, body, wire }) => {
    const call = units[findUnit(units, "read_file")];
    expect(call.text.startsWith("[m")).toBe(false);
    const tool = findUnit(units, "文件内容");
    expect(units[tool].text).toBe(readOf(body, wire)[tool].text);
    expect(systemOf(body, wire)).not.toContain("[m0");
  },
);

/* pairSafe: a call is never folded away from its result.
 *
 * A call closes its own turn (the tool result opens the next one), so `atTurnEnd` lets a range end
 * there; `pairSafe` then reaches one unit further so the result goes with it. The start direction
 * is unreachable from apply - a start must be `citable`, and tool traffic never is - and stays as
 * the belt for the offer side. */
const pairedTurns = [
  ...prose(2),
  U("先读一下这个文件,再继续。"),
  CALL("read_file", { path: "a.txt" }, "r1"),
  RES("r1", `文件内容${"内容".repeat(400)}`),
  A("读完了,内容是重复的填充。"),
  ...foldTurn(`${ref(1)}–${ref(6)}`, "前两轮问答都是填充内容,已经完成,不需要逐字保留。"),
];
row("pairSafe", "fires", pairedTurns, ({ record, session, units }) => {
  // The wires disagree on one thing only: anthropic and gemini spell a tool result as a user
  // message, so `turnStarts` sees a turn opening there and the call is a legal end - `pairSafe`
  // then reaches one unit further. chat and responses keep their own role for tool traffic, the
  // call sits mid-turn, and the range is refused instead. Either way no fold may split the pair.
  if (record.folds === 1) {
    expect(session.foldList[0].endRef).toBe(ref(7));
  } else {
    expect(record.rejected.join(";")).toContain("两端的消息不可折叠");
  }
  const callKept = units.some((unit) => unit.toolCalls.some((c) => c.name === "read_file"));
  expect(callKept).toBe(findUnit(units, "文件内容") > -1);
});
row("pairSafe", "holds", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)], ({ record, session }) => {
  expect(record.folds).toBe(1);
  // Nothing to reach for: prose ends the turn, so the endpoints stay as written.
  expect(session.foldList[0]).toMatchObject({ startRef: ref(1), endRef: ref(4) });
});

/* tool-name normalisation: our tool wears many spellings, another server's does not wear ours. */
row("tool-name", "fires", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`, "前两轮问答都是填充内容,已经完成,不需要逐字保留。", "mcp__magpie-acp-context__compress")], ({ record }) => {
  expect(record.folds).toBe(1);
});
row("tool-name", "holds", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`, "前两轮问答都是填充内容,已经完成,不需要逐字保留。", "mcp__other-server__compress")], ({ record }) => {
  expect(record.folds).toBe(0);
});

/* device call: a host that reaches MCP through `write {path:"xd://…"}`. */
const deviceTurns = (path) => [
  ...prose(2),
  U("把前面那几轮折掉。"),
  CALL("write", { path, content: JSON.stringify({ content: `${ref(1)}–${ref(4)} 早期需求\n前两轮问答都是填充内容,已经完成,不需要逐字保留。` }) }, FOLDER),
  RES(FOLDER, ackText()),
  U("继续"),
];
row("device", "fires", deviceTurns("xd://mcp__magpie_acp_context_compress"), ({ record }) => {
  expect(record.folds).toBe(1);
});
row("device", "holds", deviceTurns("notes.md"), ({ record, units }) => {
  expect(record.folds).toBe(0);
  expect(units.some((unit) => unit.text.includes("notes.md"))).toBe(true);
});

/* window: the protected tail is outside the foldable window, and says so. */
row("window", "fires", [...prose(2), ...foldTurn(`${ref(1)}–${ref(2)}`)], ({ record }) => {
  expect(record.folds).toBe(1);
}, { keepRecentTurns: 3 });
row("window", "holds", [...prose(3), ...foldTurn(`${ref(5)}–${ref(6)}`)], ({ record }) => {
  expect(record.folds).toBe(0);
  // The turn alignment answers first when the whole turn lies outside the window, so the
  // refusal names the window either way.
  expect(record.rejected.join(";")).toMatch(/窗口/);
}, { keepRecentTurns: 3 });

/* min range bytes: a range under the floor is not worth a summary. */
row("min-range-bytes", "fires", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)], ({ record }) => {
  expect(record.folds).toBe(1);
});
row(
  "min-range-bytes",
  "holds",
  [...[U("短问题一。"), A("短回答一。"), U("短问题二。"), A("短回答二。")], ...foldTurn(`${ref(1)}–${ref(4)}`, "前两轮问答都是短句,已经完成,不需要逐字保留,但这段确实很小。")],
  ({ record }) => {
    expect(record.folds).toBe(0);
    expect(record.rejected.join(";")).toContain("低于 minRangeBytes=");
  },
);

/* min summary bytes: forty bytes or the fold would leave nothing behind. */
row("min-summary-bytes", "fires", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)], ({ record }) => {
  expect(record.folds).toBe(1);
});
row("min-summary-bytes", "holds", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`, "短")], ({ record }) => {
  expect(record.folds).toBe(0);
  expect(record.rejected.join(";")).toContain("至少要 40 字节");
});

/* metadata protection: the system prompt is never stamped, never renumbered, never folded. */
const hostileSystem = "You are terse. [m00001] 这句话长得像 ref,但它属于系统提示。";
row(
  "metadata",
  "fires",
  [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)],
  ({ out, body, wire }) => {
    expect(systemOf(out, wire)).toBe(SYSTEM_TEXT);
    expect(readOf(out, wire).some((unit) => unit.role === "system" && unit.text.startsWith("[m"))).toBe(false);
    expect(systemOf(body, wire)).toBe(SYSTEM_TEXT);
  },
);
row(
  "metadata",
  "holds",
  [...prose(2), U("继续")],
  ({ out, wire }) => {
    expect(systemOf(out, wire)).toBe(hostileSystem);
  },
  {},
  hostileSystem,
);

/* media: a range over a picture is refused, a literal "[image]" in prose is not a picture. */
row(
  "media",
  "fires",
  [U(`第一轮提问。${PAD}`), A(`第一轮回答。${PAD}`), MEDIA("看一下这张截图,判断趋势。"), A(`图里是一条向上的折线,判断完毕。${PAD}`), ...foldTurn(`${ref(1)}–${ref(4)}`, "前两轮问答都是填充内容,已经完成,不需要逐字保留。")],
  ({ record }) => {
    expect(record.folds).toBe(0);
    expect(record.rejected.join(";")).toContain("范围含媒体消息");
  },
);
row(
  "media",
  "holds",
  [U(`第一轮提问。${PAD}`), A(`第一轮回答。${PAD}`), U(`这条消息里写着 [image] 四个字母,但它只是文字。${PAD}`), A(`收到,那条不是图片。${PAD}`), ...foldTurn(`${ref(1)}–${ref(5)}`, "前两轮问答都是填充内容,已经完成,不需要逐字保留。")],
  ({ record }) => {
    expect(record.folds).toBe(1);
  },
);

/* turn widening: a range starting mid-turn is pulled back to the turn it sits in. */
row(
  "turn-widening",
  "fires",
  [...prose(3), ...foldTurn(`${ref(2)}–${ref(6)}`)],
  ({ record, session }) => {
    expect(record.folds).toBe(1);
    expect(session.foldList[0].startRef).toBe(ref(1));
  },
);
row(
  "turn-widening",
  "holds",
  [...prose(3), ...foldTurn(`${ref(1)}–${ref(6)}`)],
  ({ record, session }) => {
    expect(record.folds).toBe(1);
    expect(session.foldList[0].startRef).toBe(ref(1));
    expect(session.foldList[0].endRef).toBe(ref(6));
  },
);

/* citable start: an endpoint that cannot carry a ref cannot carry a range. */
row(
  "citable-start",
  "fires",
  [...prose(1), CALL("read_file", { path: "a.txt" }, "r1"), RES("r1", "文件内容".repeat(400)), A("读完了。"), ...foldTurn(`${ref(3)}–${ref(4)}`)],
  ({ record }) => {
    expect(record.folds).toBe(0);
    expect(record.rejected.join(";")).toContain("两端的消息不可折叠");
  },
);
row("citable-start", "holds", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)], ({ record, session }) => {
  expect(record.folds).toBe(1);
  expect(session.foldList[0].startRef).toBe(ref(1));
});

/* own record: our own traffic is a barrier, in both directions. */
row(
  "own-record",
  "fires",
  [...prose(2), U("把前面连同记录一起折掉。"), CALL("compress", { content: `${ref(1)}–${ref(7)} 早期需求\n前两轮问答都是填充内容,这一版故意把记录也圈进去。` }, FOLDER), RES(FOLDER, ackText()), U("继续")],
  ({ record }) => {
    expect(record.folds).toBe(0);
    expect(record.rejected.join(";")).toContain("范围含插件自己的压缩记录");
  },
);
row("own-record", "holds", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`)], ({ record }) => {
  expect(record.folds).toBe(1);
});

/* cap: one oversized unit is cut, its original stored — and a wire that cannot cut says so. */
const bigTool = (chars) => [
  ...prose(1),
  U("读一下那个大文件。"),
  CALL("read_file", { path: "big.txt" }, "r1"),
  RES("r1", `${"y".repeat(chars)}END-OF-FILE`),
  U("继续"),
];
row("cap", "fires", bigTool(200000), ({ out, body, wire, session }) => {
  const tool = findUnit(readOf(out, wire), "END-OF-FILE");
  if (wire === "gemini") {
    // Gemini's functionResponse is JSON: there is no single text run to cut, and the gate
    // says so instead of mangling the payload. That divergence is exactly what this matrix
    // exists to pin — it must be a recorded refusal, not a silent pass.
    expect(readOf(out, wire)[tool].text).toBe(readOf(body, wire)[tool].text);
    expect(session.clipRefusals.length).toBeGreaterThan(0);
    return;
  }
  expect(readOf(out, wire)[tool].text).toContain("已省略");
  expect(readOf(out, wire)[tool].text).toContain("原文 id");
  expect(session.clips.length).toBeGreaterThan(0);
});
row("cap", "holds", bigTool(1200), ({ out, body, wire, session }) => {
  const tool = findUnit(readOf(out, wire), "END-OF-FILE");
  expect(readOf(out, wire)[tool].text).toBe(readOf(body, wire)[tool].text);
  expect(session.clipRefusals).toEqual([]);
});

/* elide: over a known ceiling, whole turns leave behind one mechanical statement. */
const long = (turns) => {
  const out = [];
  for (let i = 1; i <= turns; i += 1) {
    out.push(U(`第 ${i} 轮提问。${"x".repeat(4000)}`), A(`第 ${i} 轮回答。${"y".repeat(4000)}`));
  }
  return out;
};
row("elide", "fires", [...long(6), U("继续")], ({ units, record }) => {
  expect(record.overLimit).toBe(true);
  expect(record.elided).not.toBe(null);
  expect(units.some((unit) => unit.text.includes("已省略"))).toBe(true);
  expect(units.some((unit) => unit.text.includes("第 1 轮提问"))).toBe(false);
}, { fallback: "full", contextLimit: 6000 });
row("elide", "holds", [...long(6), U("继续")], ({ units, record }) => {
  expect(record.overLimit).toBeFalsy();
  expect(units.some((unit) => unit.text.includes("已省略"))).toBe(false);
}, { fallback: "cap", contextLimit: 6000 });

/* ref order: what a client reads back is ascending, and a marker keeps the span's start ref. */
row("ref-order", "fires", [...prose(2), ...foldTurn(`${ref(1)}–${ref(4)}`), U("再看看历史。")], ({ out, wire }) => {
  const numbers = readOf(out, wire)
    .map((unit) => /^\s*(?:\[)?(m\d{5})/.exec(unit.text)?.[1])
    .filter(Boolean)
    .map((id) => Number(id.slice(1)));
  expect(numbers.length).toBeGreaterThan(1);
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
});
row("ref-order", "holds", [...prose(2), U("继续")], ({ out, wire }) => {
  const numbers = readOf(out, wire)
    .map((unit) => /^\s*(?:\[)?(m\d{5})/.exec(unit.text)?.[1])
    .filter(Boolean)
    .map((id) => Number(id.slice(1)));
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
});

/* --------------------------------------------------------------- the gate registry */

const GATES = [...new Set(ROWS.map((entry) => entry.gate))];

/** §7 decisions that never read the body: four copies of one assertion would prove nothing. */
const ELSEWHERE = {
  "knownLimit": "src/fallback.mjs: the ceiling is three sources and a number; test/elide.test.mjs",
  "session.elide": "src/store.mjs: the latch and its streak; test/elide.test.mjs",
  "overLimit": "hooks.mjs: off unless `fallback: full` with a ceiling; test/elide.test.mjs",
};

/** §7 table row → the matrix gate that carries it. A new row without an entry fails the guard. */
const MAP = {
  "citable(unit)": "citable-start",
  "citableStart": "citable-start",
  "citableEnd": "citable-start",
  "alignToTurns": "turn-widening",
  "atTurnEnd": "turn-widening",
  "unitIds": "ref-order",
  "startIndexFor": "ref-order",
  "endIndexFor": "ref-order",
  "uniqueRef": "ref-order",
  "pairSafe": "pairSafe",
  "barriers": "own-record",
  "media": "media",
  "trimPastBarriers": "media",
  "foldable": "window",
  "apply 检查顺序": "citable-start",
  "planClips": "cap",
  "clipBlocker": "cap",
  "clipInto": "cap",
  "knownLimit": "knownLimit",
  "planElide": "elide",
  "elideBlocker": "elide",
  "elideMarker": "elide",
  "elideHead": "elide",
  "session.elide": "session.elide",
  "overLimit": "overLimit",
};

const DESIGN = readFileSync(join(import.meta.dir, "..", "docs", "magpie-acp-plugin-design.md"), "utf8");
const section7 = DESIGN.split("## 7.")[1].split("## 8.")[0];
const tableRows = section7
  .split("\n")
  .filter((line) => line.startsWith("| `"))
  .map((line) => line.split("|")[1])
  .map((cell) => cell.replace(/`/g, "").trim())
  .flatMap((cell) => cell.split("/").map((part) => part.trim()));

describe("the matrix has rows for every gate, in both directions", () => {
  test("every gate carries a positive and a negative row", () => {
    for (const gate of GATES) {
      for (const direction of ["fires", "holds"]) {
        const count = ROWS.filter((entry) => entry.gate === gate && entry.direction === direction).length;
        expect({ gate, direction, count }).toEqual({ gate, direction, count: 1 });
      }
    }
  });

  test("no row names a gate nobody declared", () => {
    for (const entry of ROWS) expect(GATES).toContain(entry.gate);
  });

  test("every decision in the design doc belongs to a gate", () => {
    const unmapped = tableRows.filter((identifier) => !(identifier in MAP) && !(identifier in ELSEWHERE));
    expect(unmapped).toEqual([]);
  });

  test("every gate the map claims is one the body can switch", () => {
    for (const gate of GATES) expect(Object.keys(ELSEWHERE)).not.toContain(gate);
  });
});

describe("every gate, on every wire", () => {
  for (const wire of WIRES) {
    test(`${wire}: the wire is one this plugin reads`, () => {
      expect(adapterFor(wire)).not.toBe(null);
    });
    for (const entry of ROWS) {
      test(`${wire} · ${entry.gate} · ${entry.direction}`, async () => {
        const result = await run(wire, entry.turns, entry.over, entry.system);
        await entry.expect(result);
      });
    }
  }
});
