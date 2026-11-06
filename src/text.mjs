import { createHash } from "node:crypto";

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** Stable identity of a piece of transcript content: survives folding and renumbering. */
export function blockIdOf(text) {
  return sha256(text).slice(0, 16);
}

export function utf8Bytes(text) {
  return Buffer.byteLength(String(text), "utf8");
}

/**
 * 模型写出来的摘要和转述都可能含有 ref 形状的文本。若不转义，模型可以伪造一条
 * "已折叠" 的边界，把真实历史挤出去。转义必须确定性、可逆性无所谓（原文另有存档）。
 */
export function neutralizeMarkers(text) {
  return String(text)
    .replace(/\bm(\d{5})\b/g, "m#$1")
    .replace(/\[\s*acp[\s\]]/gi, "[acp ]");
}

export function formatRef(n, format = "m%05d") {
  const width = /%0(\d+)d/.exec(format)?.[1];
  const out = format.replace(/%0?\d*d/, String(n).padStart(width ? Number(width) : 1, "0"));
  return out;
}

/** "m00120" -> 120 */
export function refNumber(ref) {
  const m = /^m0*(\d{1,9})$/.exec(String(ref).trim());
  return m ? Number(m[1]) : null;
}

/** Short stable hash of a sorted list, for detecting "this turned shape changed". */
export function digestJson(value) {
  return blockIdOf(JSON.stringify(value));
}
