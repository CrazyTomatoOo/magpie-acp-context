// Fake upstream provider. Records every body it receives so the test can assert
// on what magpie actually sent. Loopback only — the container runs --network none.
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.UPSTREAM_PORT ?? 8099);
const OUT = process.env.CAPTURE_DIR ?? "/out/capture";
mkdirSync(OUT, { recursive: true });

let n = 0;
Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      // not JSON: recorded as-is, answered as a non-streaming completion
    }
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      // not JSON: recorded as-is, answered as a non-streaming completion
    }
    const seq = String(++n).padStart(3, "0");
    writeFileSync(`${OUT}/${seq}.path`, `${req.method} ${url.pathname}`);
    writeFileSync(`${OUT}/${seq}.headers`, JSON.stringify(Object.fromEntries(req.headers)));
    if (body) writeFileSync(`${OUT}/${seq}.body`, body);

    if (url.pathname.endsWith("/messages")) {
      return Response.json({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "fake-1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    // A streamed reply: the usage arrives in a final chunk with an empty `choices`, the way
    // OpenAI-compatible providers report it. The gateway consolidates the copy for onResponse.
    if (parsed?.stream === true) {
      const chunk = (delta, extra = {}) =>
        `data: ${JSON.stringify({ id: "chatcmpl_fake", object: "chat.completion.chunk", model: "fake-1", choices: delta, ...extra })}\n\n`;
      const sse = [
        chunk([{ index: 0, delta: { role: "assistant", content: "ok" } }]),
        chunk([], { usage: { prompt_tokens: 2222, completion_tokens: 3, total_tokens: 2225 } }),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    // A streamed reply: the usage arrives in a final chunk with an empty `choices`, the way
    // OpenAI-compatible providers report it. The gateway consolidates the copy for onResponse.
    if (parsed?.stream === true) {
      const chunk = (choices, extra = {}) =>
        `data: ${JSON.stringify({ id: "chatcmpl_fake", object: "chat.completion.chunk", model: "fake-1", choices, ...extra })}\n\n`;
      const sse = [
        chunk([{ index: 0, delta: { role: "assistant", content: "ok" } }]),
        chunk([], { usage: { prompt_tokens: 2222, completion_tokens: 3, total_tokens: 2225 } }),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    return Response.json({
      id: "chatcmpl_fake",
      object: "chat.completion",
      model: "fake-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      // A realistic bill: the hook records this as the billed prompt of the turn.
      usage: { prompt_tokens: 1234, completion_tokens: 7, total_tokens: 1241 },
    });
  },
});
console.log(`upstream listening on 127.0.0.1:${PORT}, capturing to ${OUT}`);
