/**
 * Per-protocol reading and rewriting.
 *
 * Every function here is pure: they mutate the body copy they are handed and never
 * look at anything outside it. That is what makes "same input -> same bytes" testable.
 */

function asText(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(asText).join("");
  return "";
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === undefined && typeof block.text === "string") return block.text; // gemini parts
  switch (block.type) {
    case "text":
    case "input_text":
    case "output_text":
      return asText(block.text);
    case "tool_use":
      return `tool_use ${block.name} ${JSON.stringify(block.input ?? {})}`;
    // A real client hands the result back as an array of blocks, not one string -
    // reading only the string shape made the ack invisible and the fold never landed.
    case "tool_result":
      return `tool_result ${partsText(block.content)}`;
    case "function_call":
      return `function_call ${block.name ?? ""} ${asText(block.arguments)}`;
    case "function_call_output":
      return `function_call_output ${partsText(block.output)}`;
    // Codex's exec orchestrator: the call name is `exec` and the arguments are a script.
    case "custom_tool_call":
      return `custom_tool_call ${block.name ?? ""} ${asText(block.input)}`;
    case "custom_tool_call_output":
      return `custom_tool_call_output ${partsText(block.output)}`;
    case "image":
    case "input_image":
      return "[image]";
    case "file":
    case "input_file":
      return "[file]";
    default:
      return JSON.stringify(block);
  }
}

function partsText(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(blockText).join("");
}

/**
 * Payloads whose bytes a unit's text projection cannot carry.
 *
 * A fold's stored original is `{role, text}` and `decompress` hands that text back, so an
 * `[image]` placeholder is all that survives a fold - the picture is gone from the context and
 * unrecoverable from the store. `image_url`, gemini `inlineData` and the rest are listed for the
 * same reason: whatever the fallback branch happens to serialize, what the model saw was not text.
 */
const MEDIA_TYPES = new Set(["image", "input_image", "image_url", "file", "input_file", "document", "audio", "input_audio", "video"]);

function isMediaPart(part) {
  if (!part || typeof part !== "object") return false;
  if (MEDIA_TYPES.has(part.type)) return true;
  if (part.inlineData || part.fileData) return true; // gemini
  // A tool result can hand back an image inside its own content: folding the result folds it.
  if (Array.isArray(part.content)) return part.content.some(isMediaPart);
  if (Array.isArray(part.output)) return part.output.some(isMediaPart);
  return false;
}

function hasMedia(content) {
  if (!Array.isArray(content)) return false;
  return content.some(isMediaPart);
}

/**
 * A writable handle on the text a turn is made of. Works for both shapes every protocol
 * uses: a bare string, or an array of parts where exactly one part carries the prose.
 * Returns null when the turn has no prose at all (a pure tool turn) - those are never
 * rewritten, only folded as a whole.
 */
function textSlot(owner, key) {
  if (!owner || typeof owner !== "object") return null;
  const value = owner[key];
  if (typeof value === "string") return { get: () => value, set: (t) => { owner[key] = t; } };
  if (!Array.isArray(value)) return null;
  for (let i = 0; i < value.length; i += 1) {
    const part = value[i];
    if (typeof part === "string") return { get: () => part, set: (t) => { value[i] = t; } };
    const isText =
      part &&
      typeof part === "object" &&
      (part.type === "text" || part.type === "input_text" || part.type === "output_text" ||
        (part.type === undefined && typeof part.text === "string")); // gemini parts carry no type
    if (isText) {
      return { get: () => asText(part.text), set: (t) => { part.text = t; } };
    }
  }
  return null;
}

/** Stamp a ref in front of existing text. A blank turn gets no ref: "[m00006] " on an
 *  empty assistant message is noise the model can only misread. */
function stampInto(slot, refText) {
  if (!slot) return false;
  const text = slot.get();
  if (typeof text !== "string" || text.trim() === "") return false;
  slot.set(`${refText} ${text}`);
  return true;
}

/**
 * The head/tail cut, in one place so a marker's "已省略 N 字符" is exactly what the two slices
 * left out. The adapter hands over the payload it found and writes the result back; nothing
 * else about the unit changes. `marker` is a function because the count it names is only known
 * once the slices are measured.
 */
function clipPayload(text, keepChars, marker) {
  const head = text.slice(0, keepChars);
  const tail = text.slice(text.length - keepChars);
  const omitted = text.length - head.length - tail.length;
  if (omitted <= 0) return null;
  return { text: `${head}\n\n${marker(omitted)}\n\n${tail}`, omitted };
}

const REFUSE = (reason) => ({ ok: false, reason });

/* ------------------------------------------------------------------ anthropic */

const anthropic = {
  name: "anthropic",
  unitArray: (body) => body.messages,
  read(body) {
    const items = body.messages || [];
    return items.map((m, index) => {
      const content = m?.content;
      const text = partsText(content);
      const isToolOnly =
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b) => b && (b.type === "tool_result" || b.type === "tool_use" || b.type === "image"));
      return {
        index,
        role: m?.role ?? "user",
        text,
        stampable: !isToolOnly && text.trim() !== "" && textSlot(m, "content") !== null,
        media: hasMedia(content),
        toolCalls: Array.isArray(content) ? content.filter((b) => b?.type === "tool_use").map((b) => ({ name: b.name, input: b.input })) : [],
      };
    });
  },
  stamp(body, index, refText) {
    return stampInto(textSlot(body.messages[index], "content"), refText);
  },
  /**
   * A tool result is a block, not a string: the prose sits in `content[0].content` and the
   * unit's text projection prefixes it with `tool_result `. Cutting the projection and writing
   * it back would inject that prefix into the payload, so the cut runs on the payload itself.
   */
  clipInto(body, index, { keepChars, marker }) {
    const m = body.messages?.[index];
    if (!m) return REFUSE("没有这个单元");
    if (typeof m.content === "string") {
      const cut = clipPayload(m.content, keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      m.content = cut.text;
      return { ok: true, ...cut };
    }
    const parts = Array.isArray(m.content) ? m.content : [];
    if (parts.length === 1) {
      const block = parts[0];
      if (block?.type === "tool_result") {
        if (typeof block.content === "string") {
          const cut = clipPayload(block.content, keepChars, marker);
          if (!cut) return REFUSE("工具结果太短,裁不出可省的部分");
          block.content = cut.text;
          return { ok: true, ...cut };
        }
        if (Array.isArray(block.content) && block.content.length === 1 && typeof block.content[0]?.text === "string") {
          const cut = clipPayload(block.content[0].text, keepChars, marker);
          if (!cut) return REFUSE("工具结果太短,裁不出可省的部分");
          block.content = [{ type: "text", text: cut.text }];
          return { ok: true, ...cut };
        }
      }
      if (typeof block?.text === "string") {
        const cut = clipPayload(block.text, keepChars, marker);
        if (!cut) return REFUSE("正文太短,裁不出可省的部分");
        block.text = cut.text;
        return { ok: true, ...cut };
      }
    }
    return REFUSE("这个单元由多个块拼成,裁了会动到结构");
  },
  makeMarker(text) {
    return { role: "user", content: [{ type: "text", text }] };
  },
  appendNote(body, note) {
    const msgs = body.messages || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role !== "user") continue;
      const slot = textSlot(msgs[i], "content");
      if (slot) {
        slot.set(`${slot.get()}\n\n${note}`);
        return true;
      }
    }
    return false;
  },
  appendSystem(body, note) {
    if (typeof body.system === "string") body.system = `${body.system}\n\n${note}`;
    else if (Array.isArray(body.system)) body.system.push({ type: "text", text: note });
    else if (body.system === undefined) body.system = note;
    else return false;
    return true;
  },
};

/* ----------------------------------------------------------------------- chat */

const chat = {
  name: "chat",
  unitArray: (body) => body.messages,
  read(body) {
    const items = body.messages || [];
    return items.map((m, index) => {
      const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
      const prose = partsText(m?.content);
      const text = prose + calls.map((c) => `tool_call ${c?.function?.name ?? ""} ${asText(c?.function?.arguments)}`).join("");
      // A message whose only substance is a tool call is tool traffic, not a turn of history -
      // the same rule the other three wires state as `!isToolOnly`. Reading the call's
      // arguments as prose gave it a ref (and so a legal range endpoint) on this wire only.
      const stampable = (m?.role === "user" || m?.role === "assistant") && prose.trim() !== "" && textSlot(m, "content") !== null;
      return {
        index,
        role: m?.role ?? "user",
        text,
        stampable,
        media: hasMedia(m?.content),
        toolCalls: calls.map((c) => ({ name: c?.function?.name, input: c?.function?.arguments })),
      };
    });
  },
  stamp(body, index, refText) {
    return stampInto(textSlot(body.messages[index], "content"), refText);
  },
  /** A chat tool message's content is the tool's output verbatim; a prose part is the same cut. */
  clipInto(body, index, { keepChars, marker }) {
    const m = body.messages?.[index];
    if (!m) return REFUSE("没有这个单元");
    if (typeof m.content === "string") {
      const cut = clipPayload(m.content, keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      m.content = cut.text;
      return { ok: true, ...cut };
    }
    const parts = Array.isArray(m.content) ? m.content : [];
    if (parts.length === 1 && typeof parts[0]?.text === "string") {
      const cut = clipPayload(parts[0].text, keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      parts[0].text = cut.text;
      return { ok: true, ...cut };
    }
    return REFUSE("这个单元由多个块拼成,裁了会动到结构");
  },
  makeMarker(text) {
    return { role: "user", content: text };
  },
  appendNote(body, note) {
    const msgs = body.messages || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role !== "user") continue;
      const slot = textSlot(msgs[i], "content");
      if (slot) {
        slot.set(`${slot.get()}\n\n${note}`);
        return true;
      }
    }
    return false;
  },
  appendSystem(body, note) {
    const msgs = body.messages || [];
    const idx = msgs.findIndex((m) => m?.role === "system" || m?.role === "developer");
    if (idx === -1) return false;
    const slot = textSlot(msgs[idx], "content");
    if (!slot) return false;
    slot.set(`${slot.get()}\n\n${note}`);
    return true;
  },
};

/* ------------------------------------------------------------------ responses */

const responses = {
  name: "responses",
  unitArray: (body) => body.input,
  read(body) {
    const items = body.input || [];
    return items.map((item, index) => {
      if (!item || typeof item !== "object") {
        return { index, role: "user", text: asText(item), stampable: false, media: false, toolCalls: [] };
      }
      if (item.type === "function_call") {
        return { index, role: "assistant", text: blockText(item), stampable: false, toolCalls: [{ name: item.name, input: item.arguments }] };
      }
      if (item.type === "function_call_output") {
        return { index, role: "tool", text: blockText(item), stampable: false, media: hasMedia(item.output), toolCalls: [] };
      }
      if (item.type === "custom_tool_call") {
        return { index, role: "assistant", text: blockText(item), stampable: false, toolCalls: [{ name: item.name, input: item.input }] };
      }
      if (item.type === "custom_tool_call_output") {
        return { index, role: "tool", text: blockText(item), stampable: false, media: hasMedia(item.output), toolCalls: [] };
      }
      const text = partsText(item.content);
      return { index, role: item.role ?? "user", text, stampable: text.trim() !== "" && textSlot(item, "content") !== null, media: hasMedia(item.content), toolCalls: [] };
    });
  },
  stamp(body, index, refText) {
    return stampInto(textSlot(body.input[index], "content"), refText);
  },
  /**
   * `function_call_output` / `custom_tool_call_output` carry the payload in `output`, and the
   * projection prefixes it with the item type - so the cut runs on `output`, never on the text.
   */
  clipInto(body, index, { keepChars, marker }) {
    const item = body.input?.[index];
    if (!item || typeof item !== "object") return REFUSE("没有这个单元");
    const cutInto = (owner, key) => {
      const cut = clipPayload(String(owner[key] ?? ""), keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      owner[key] = cut.text;
      return { ok: true, ...cut };
    };
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.output === "string") return cutInto(item, "output");
      if (Array.isArray(item.output) && item.output.length === 1 && typeof item.output[0]?.text === "string") {
        const cut = clipPayload(item.output[0].text, keepChars, marker);
        if (!cut) return REFUSE("工具结果太短,裁不出可省的部分");
        item.output[0].text = cut.text;
        return { ok: true, ...cut };
      }
      return REFUSE("工具结果的形状不是一个整段文本");
    }
    if (typeof item.content === "string") return cutInto(item, "content");
    if (Array.isArray(item.content) && item.content.length === 1 && typeof item.content[0]?.text === "string") {
      const cut = clipPayload(item.content[0].text, keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      item.content[0].text = cut.text;
      return { ok: true, ...cut };
    }
    return REFUSE("这个单元由多个块拼成,裁了会动到结构");
  },
  makeMarker(text) {
    return { type: "message", role: "user", content: [{ type: "input_text", text }] };
  },
  appendNote(body, note) {
    const items = body.input || [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (!it || it.role !== "user" || (it.type && it.type !== "message")) continue;
      const slot = textSlot(it, "content");
      if (slot) {
        slot.set(`${slot.get()}\n\n${note}`);
        return true;
      }
    }
    return false;
  },
  appendSystem(body, note) {
    if (typeof body.instructions === "string") body.instructions = `${body.instructions}\n\n${note}`;
    else if (body.instructions === undefined) body.instructions = note;
    else return false;
    return true;
  },
};

/* --------------------------------------------------------------------- gemini */

const gemini = {
  name: "gemini",
  unitArray: (body) => body.contents,
  read(body) {
    const items = body.contents || [];
    return items.map((c, index) => {
      const parts = c?.parts || [];
      const calls = parts.filter((p) => p && (p.functionCall || p.functionResponse));
      const text = partsText(parts);
      return {
        index,
        role: c?.role === "model" ? "assistant" : c?.role ?? "user",
        text,
        stampable: text.trim() !== "" && textSlot(c, "parts") !== null,
        media: parts.some(isMediaPart),
        toolCalls: calls.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, input: p.functionCall.args })),
      };
    });
  },
  stamp(body, index, refText) {
    return stampInto(textSlot(body.contents[index], "parts"), refText);
  },
  /**
   * Gemini carries a tool result as `functionResponse`, whose payload is JSON - there is no
   * single text run to cut, so the cap steps aside and says so instead of mangling the object.
   */
  clipInto(body, index, { keepChars, marker }) {
    const c = body.contents?.[index];
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    if (parts.length === 1 && typeof parts[0]?.text === "string") {
      const cut = clipPayload(parts[0].text, keepChars, marker);
      if (!cut) return REFUSE("正文太短,裁不出可省的部分");
      parts[0].text = cut.text;
      return { ok: true, ...cut };
    }
    return REFUSE("gemini 的工具结果是 JSON,没有可以整段裁的文本");
  },
  makeMarker(text) {
    return { role: "user", parts: [{ text }] };
  },
  appendNote(body, note) {
    const items = body.contents || [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.role !== "user") continue;
      const slot = textSlot(items[i], "parts");
      if (slot) {
        slot.set(`${slot.get()}\n\n${note}`);
        return true;
      }
    }
    return false;
  },
  appendSystem(body, note) {
    const si = body.systemInstruction;
    if (!si) {
      body.systemInstruction = { role: "system", parts: [{ text: note }] };
      return true;
    }
    const slot = textSlot(si, "parts");
    if (!slot) return false;
    slot.set(`${slot.get()}\n\n${note}`);
    return true;
  },
};

const ADAPTERS = { anthropic, chat, responses, gemini };

/**
 * The tool names a request declares, in whatever shape its wire uses.
 *
 * `null` means the request carries no declaration list at all - an older host, a probe, a
 * non-agent call - and the caller must not read that as "this client has no tools": only a
 * list that is present but lacks every one of our names proves the client cannot call them.
 */
export function advertisedToolNames(body) {
  const list = body?.tools;
  if (!Array.isArray(list)) return null;
  // Gemini nests its functions one level deeper than every other wire (`tools[0].
  // functionDeclarations`), so a flat `tools[]` reading would report "no tools" for it.
  const declarations = list[0]?.functionDeclarations;
  if (Array.isArray(declarations)) {
    return declarations.map((d) => d?.name).filter((n) => typeof n === "string" && n);
  }
  const names = [];
  for (const t of list) {
    const name = t?.name ?? t?.function?.name;
    if (typeof name === "string" && name) names.push(name);
    // Responses (codex CLI) does not declare an MCP server's tools flat: it declares the
    // server as a namespace and nests the callable names under it -
    // `{type:"namespace", name:"mcp__magpie", tools:[{type:"function", name:"<plugin>_<tool>"}]}`.
    // Reading only the top level reports the namespace, not the tools, and a gate that then
    // asks "can this client call ours?" answers no for a client that just showed us how.
    if (Array.isArray(t?.tools)) {
      for (const nested of t.tools) {
        const sub = nested?.name ?? nested?.function?.name;
        if (typeof sub === "string" && sub) names.push(sub);
      }
    }
  }
  return names;
}

export function adapterFor(protocol) {
  return ADAPTERS[String(protocol || "").toLowerCase()] || null;
}

export const SUPPORTED = Object.keys(ADAPTERS);
