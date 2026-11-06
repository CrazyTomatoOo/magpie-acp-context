// Usage as the provider billed it, read from the client-facing reply magpie hands
// onResponse, plus a fallback estimate for when a provider sends no usage at all.

const pick = (o, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The reply's usage in one shape, whichever API the client speaks. */
export function readUsage(reply, protocol) {
  if (!reply || typeof reply !== "object") return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  if (protocol === "chat") {
    input = num(pick(reply, "usage.prompt_tokens"));
    output = num(pick(reply, "usage.completion_tokens"));
    cacheRead = num(pick(reply, "usage.prompt_tokens_details.cached_tokens"));
  } else if (protocol === "anthropic") {
    input = num(pick(reply, "usage.input_tokens"));
    output = num(pick(reply, "usage.output_tokens"));
    cacheRead = num(pick(reply, "usage.cache_read_input_tokens"));
    cacheWrite = num(pick(reply, "usage.cache_creation_input_tokens"));
  } else if (protocol === "responses") {
    input = num(pick(reply, "usage.input_tokens"));
    output = num(pick(reply, "usage.output_tokens"));
    cacheRead = num(pick(reply, "usage.input_tokens_details.cached_tokens"));
  } else if (protocol === "gemini") {
    input = num(pick(reply, "usageMetadata.promptTokenCount"));
    output = num(pick(reply, "usageMetadata.candidatesTokenCount"));
    cacheRead = num(pick(reply, "usageMetadata.cachedContentTokenCount"));
  }
  if (!input && !output) return null;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Tokens a text costs, near enough for a threshold: ASCII runs about four
 * characters a token, and every non-ASCII character (CJK, emoji) costs about a
 * token of its own. Providers never bill exactly this; it only decides whether
 * to whisper, never what to send.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) > 127) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

/** Tokens a request body already holds, for the first turn of a session. */
export function estimateBodyTokens(body) {
  try {
    return estimateTokens(JSON.stringify(body));
  } catch {
    return 0;
  }
}
