// Live-smoke middleware: logs what the gateway hands us and lets everything pass.
// No fs, no fetch — this runs in magpie's own runtime.
export function onRequest(body, ctx) {
  const msgs = Array.isArray(body?.messages) ? body.messages.length : 0;
  console.log("[probe] onRequest protocol=" + ctx.protocol + " model=" + ctx.model + " messages=" + msgs + " path=" + ctx.path);
  return body;
}
