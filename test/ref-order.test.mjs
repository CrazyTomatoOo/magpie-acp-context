import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onRequest } from "../hooks.mjs";
import { COMPRESS_ACK } from "../src/compress.mjs";

/**
 * A ref is a content id, and that has two consequences the note has to survive (#17):
 *
 *   1. a fold marker is new text standing where older units used to be, so if it were hashed as
 *      new content it would put a high ref in front of lower ones and the note could advertise a
 *      range whose start sorts after its own end (measured: `m00385–m00374` in a 270-block fold);
 *   2. identical content shares one ref, so an endpoint that names two places cannot be
 *      advertised at all - apply would have to guess which copy the note meant.
 *
 * The offer and apply therefore share one judgment, the same discipline #16 established for the
 * start of a range: the note only prints a span that resolves to exactly itself.
 */

const store = () => mkdtempSync(join(tmpdir(), "acp-refs-"));
const opts = (over = {}) => ({ enabled: true, keepRecentTurns: 1, minRangeBytes: 1, store: { dir: store() }, ...over });
const ctxOf = (options, session = "r") => ({ protocol: "chat", origin: "local", session, options });
const stateOf = (options) => JSON.parse(readFileSync(join(options.store.dir, "sessions", "r.json"), "utf8"));
const body = (messages) => ({ model: "x", messages: structuredClone(messages) });
const refOf = (message) => /^\[(m\d+)\]/.exec(String(message?.content ?? ""))?.[1];
const textOf = (out) => out.messages.map((message) => String(message.content ?? "")).join("\n");

/**
 * What the client holds after a turn: its own text without the stamp in front and without the
 * note the hook appended. A storage client is the only one that also keeps a fold marker - which
 * is exactly the case these tests are about.
 */
const clientView = (out) =>
  out.messages.map((message) => ({
    ...message,
    content: String(message.content ?? "")
      .replace(/^\[m\d+\]\s*/, "")
      .replace(/\n\n\[acp\][\s\S]*$/, ""),
  }));
const num = (ref) => Number(String(ref).slice(1));

const para = (i) => `第 ${i} 段:这段背景写下来是为了让这一轮有内容可折,只有细节,读完就知道结论。`;
const turn = (i) => [
  { role: "user", content: `问题 ${i}:${para(i)}` },
  { role: "assistant", content: `回答 ${i}:${para(i)}` },
];

const call = (id, range) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id,
      type: "function",
      function: {
        name: "compress",
        arguments: JSON.stringify({ content: `${range} 早期需求\n早期需求是把方案讲清楚,这件事已经做完,结论记在这儿。` }),
      },
    },
  ],
});
const ack = (id) => ({ role: "tool", tool_call_id: id, content: `解析到 1 段;${COMPRESS_ACK}(本工具不写历史)。` });

/** The call and its reply open the protected tail, so they stay out of the window they fold. */
const foldTurn = (range, label = "把开头那两轮折掉。", id = "c1") => [
  { role: "user", content: label },
  call(id, range),
  ack(id),
];

describe("a marker is not new content", () => {
  test("the marker wears the ref of the span it replaced, so the next request reads in history order", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const first = await onRequest(body([...turn(1), ...turn(2), ...turn(3), ...turn(4), ...foldTurn("m00001–m00002")]), ctx);
    const { folds } = stateOf(options);
    expect(folds.length).toBe(1);
    expect(folds[0].startRef).toBe("m00001");

    const marker = first.messages.find((message) => String(message.content ?? "").startsWith("[acp] "));
    expect(marker).toBeDefined();

    // The client sends history back; the marker now takes the ref of the span it stands for.
    // Hashed as new text it would take the newest ref in the ledger and land in front of units
    // numbered long before it.
    const next = await onRequest(body([...clientView(first), ...turn(5), ...foldTurn("m00003–m00002", "再折一点。", "c2")]), ctx);
    const sent = next.messages.find((message) => String(message.content ?? "").includes("[acp] m00001–m00002"));
    expect(sent).toBeDefined();
    expect(refOf(sent)).toBe(folds[0].startRef);

    // And the whole request numbers in one direction. The defect this test exists for printed
    // `m00385–m00374`: a start sorting after its own end.
    const refs = next.messages.map(refOf).filter(Boolean).map(num);
    expect(refs.length).toBeGreaterThan(4);
    expect(refs).toEqual([...refs].sort((a, b) => a - b));

    const advertised = /当前可以折叠的范围是 (m\d{5})–(m\d{5})/.exec(textOf(next));
    if (advertised) expect(num(advertised[1])).toBeLessThanOrEqual(num(advertised[2]));
  });

  test("the note that follows a marker points past it, never back at it", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const settled = await onRequest(body([...turn(1), ...turn(2), ...turn(3), ...turn(4), ...foldTurn("m00001–m00002")]), ctx);
    expect(stateOf(options).folds.length).toBe(1);

    const next = await onRequest(body([...clientView(settled), ...turn(5), ...foldTurn("m00003–m00002", "先看看窗口。", "c2")]), ctx);
    const { foldableFrom, foldableTo } = stateOf(options).request;
    expect(foldableFrom).toBeTruthy();
    expect(num(foldableFrom)).toBeLessThan(num(foldableTo));
    // The marker is not offered back as a place to fold: it is the fold.
    expect(foldableFrom).not.toBe(stateOf(options).folds[0].startRef);
    const refs = next.messages.map(refOf).filter(Boolean).map(num);
    expect(refs).toEqual([...refs].sort((a, b) => a - b));
  });
});

describe("an endpoint is one place, not two", () => {
  const twin = "这一句在历史里出现了两次,所以它自己说不清是哪一条。";

  test("a repeated start is stepped past, so the printed range is the settled range", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const head = [
      { role: "user", content: twin },
      { role: "assistant", content: `回答甲:${para(1)}` },
      { role: "user", content: twin },
      { role: "assistant", content: `回答乙:${para(2)}` },
    ];
    const messages = [...head, ...turn(3), ...turn(4), ...foldTurn("m00006–m00005", "先看看窗口。")];
    const out = await onRequest(body(messages), ctx);
    const { request } = stateOf(options);
    expect(request.foldableFrom).toBeTruthy();
    // Two copies of the same sentence sit at the head of the window; neither can be named.
    expect(request.foldableFrom).not.toBe(refOf(out.messages[0]));
    expect(request.foldableFrom).not.toBe(refOf(out.messages[2]));
    expect(num(request.foldableFrom)).toBeGreaterThan(num(refOf(out.messages[2])));
    expect(request.foldableFrom).toBe(refOf(out.messages[4]));

    // Folding exactly what the note printed settles exactly that span.
    const inflated = body([...messages, call("c2", `${request.foldableFrom}–${request.foldableTo}`), ack("c2")]);
    await onRequest(inflated, ctx);
    const { folds } = stateOf(options);
    expect(folds.length).toBe(1);
    expect(folds[0].startRef).toBe(request.foldableFrom);
    expect(folds[0].endRef).toBe(request.foldableTo);
    const from = out.messages.findIndex((message) => refOf(message) === request.foldableFrom);
    const to = out.messages.findIndex((message) => refOf(message) === request.foldableTo);
    expect(folds[0].blocks.length).toBe(to - from + 1);
  });

  test("a hand-written range on a repeated ref resolves to the first occurrence", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    // `twin` opens two different turns. A range naming it plus the unit that closes the second
    // copy's turn is six units when the first copy answers for it, and two when the last does.
    await onRequest(
      body([
        { role: "user", content: twin },
        { role: "assistant", content: `回答甲:${para(1)}` },
        { role: "user", content: `问题 2:${para(2)}` },
        { role: "assistant", content: `回答乙:${para(2)}` },
        { role: "user", content: twin },
        { role: "assistant", content: `回答丙:${para(3)}` },
        ...turn(4),
        ...foldTurn("m00001–m00006", "折掉前半段。"),
      ]),
      ctx,
    );
    const { folds } = stateOf(options);
    expect(folds.length).toBe(1);
    expect(folds[0].startRef).toBe("m00001");
    // First occurrence answers: 0..7. Resolving to the later copy would have cut it to 4..7.
    expect(folds[0].blocks.length).toBe(8);
    expect(folds[0].blocks[0].text).toBe(twin);
  });

  test("negative control: distinct refs already in history order are advertised unchanged", async () => {
    const options = opts();
    const ctx = ctxOf(options);
    const out = await onRequest(body([...turn(1), ...turn(2), ...turn(3), ...turn(4), ...foldTurn("m00003–m00002", "先看看窗口。")]), ctx);
    const { request } = stateOf(options);
    expect(request.foldableFrom).toBe(refOf(out.messages[0]));
    expect(request.foldableTo).toBe(refOf(out.messages[7]));
    expect(textOf(out)).toContain(`当前可以折叠的范围是 ${request.foldableFrom}–${request.foldableTo}`);
  });
});
