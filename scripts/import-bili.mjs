#!/usr/bin/env node
// Import billion-context's local store into this plugin's store.
//
// Read-only on bili's side: everything is opened with `readOnly: true`, and nothing outside
// --store is written. bili keeps folded originals forever (messages.retired_at is set, the
// text stays in `content` as plaintext JSON, keyed by sha256), so this recovers what our
// own store never saw.
//
//   node scripts/import-bili.mjs --db ~/.local/share/billion-context/sessions/index.db \
//                                --store ~/.local/share/magpie-acp [--session <id> ...] [--all]
//                                [--limit N] [--dry-run] [--json]

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const blockIdOf = (role, text) =>
  createHash("sha256").update(`${role}\u0000${text}`).digest("hex").slice(0, 16);
const expand = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p));

function parseArgs(argv) {
  const out = { db: null, store: null, sessions: [], namespaces: [], all: false, limit: 0, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--store") out.store = argv[++i];
    else if (a === "--session") out.sessions.push(argv[++i]);
    else if (a === "--namespace") out.namespaces.push(argv[++i]);
    else if (a === "--all") out.all = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.db) throw new Error("--db is required");
  if (!out.store) throw new Error("--store is required");
  if (!out.all && out.sessions.length === 0 && out.namespaces.length === 0) out.all = true;
  return out;
}

/** bili stores every message body as JSON: {"id","role","contentType","text"}. */
function textOf(bytes, kind) {
  const raw = Buffer.from(bytes).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.text === "string") return parsed.text;
    if (typeof parsed?.content === "string") return parsed.content;
    if (Array.isArray(parsed?.content)) return parsed.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  } catch {
    /* not JSON: keep the bytes */
  }
  return kind === "reasoning" ? "" : raw;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = expand(args.db);
  const storeDir = expand(args.store);
  if (!existsSync(dbPath)) throw new Error(`no such database: ${dbPath}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const contentOf = db.prepare("SELECT bytes FROM content WHERE hash = ?");
  const summaryOf = (hash) => {
    const row = contentOf.get(hash);
    return row ? textOf(row.bytes, "text") : "";
  };

  // bili keys a session by the client's own conversation id and files it under the client
  // that named it (`sessions.namespace`: proxy|pi|omp|dsh|opencode|…), so `--namespace`
  // imports exactly one client's history.
  const sessions = args.sessions.length
    ? args.sessions.map((id) => ({ session_id: id }))
    : args.namespaces.length
      ? db
          .prepare(
            `SELECT session_id, namespace FROM sessions WHERE namespace IN (${args.namespaces.map(() => "?").join(",")})
             ORDER BY updated_at DESC`,
          )
          .all(...args.namespaces)
      : db
          .prepare(
            `SELECT m.session_id, s.namespace, count(*) n
               FROM messages m JOIN sessions s ON s.session_id = m.session_id
              GROUP BY m.session_id ORDER BY n DESC`,
          )
          .all();
  const chosen = args.limit > 0 ? sessions.slice(0, args.limit) : sessions;

  const report = { db: dbPath, store: storeDir, sessions: [], blocks: 0, folds: 0, dryRun: args.dryRun };

  for (const { session_id: sessionId, namespace } of chosen) {
    const rows = db
      .prepare(
        `SELECT m.seq, m.ref, m.role, m.kind, m.content_hash, m.retired_at, c.bytes
           FROM messages m JOIN content c ON c.hash = m.content_hash
          WHERE m.session_id = ?
          ORDER BY m.seq`,
      )
      .all(sessionId);
    if (!rows.length) continue;

    const state = { v: 1, next: 1, seq: 0, refs: {}, folds: [], usage: [], request: null, nudge: null };
    const skipped = [];
    const bySeq = new Map();
    const byRef = new Map();
    let written = 0;

    for (const row of rows) {
      const text = textOf(row.bytes, row.kind);
      if (!text.trim()) continue;
      const blockId = blockIdOf(row.role, text);
      // `ref` is normally `m01234`, but bili also writes the literal `BLOCKED` for folded media
      // turns and leaves it NULL for some rows: only a real ref may enter the ledger.
      const ref = /^m\d{5,}$/.test(String(row.ref ?? "")) ? String(row.ref) : null;
      const entry = { blockId, ref, role: row.role, text, seq: row.seq };
      bySeq.set(row.seq, entry);
      if (ref) {
        byRef.set(ref, entry);
        state.refs[blockId] = ref;
        const refNum = Number(ref.slice(1));
        if (refNum >= state.next) state.next = refNum + 1;
      }
      if (!args.dryRun) {
        writeJson(join(storeDir, "blocks", `${blockId}.json`), {
          role: row.role,
          text,
          ref,
          session: sessionId,
          at: Number(row.retired_at ?? 0) || null,
          source: { from: "billion-context", session: sessionId, seq: row.seq, contentHash: row.content_hash },
        });
      }
      written += 1;
    }

    const blockRows = db
      .prepare(
        `SELECT block_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash,
                payload_json, active
           FROM blocks WHERE session_id = ? AND active = 1 ORDER BY ord`,
      )
      .all(sessionId);

    for (const b of blockRows) {
      // bili leaves start_seq/end_seq at 0 in this version; start_ref/end_ref are authoritative.
      const refStart = b.start_ref ? `m${String(b.start_ref).padStart(5, "0")}` : null;
      const refEnd = b.end_ref ? `m${String(b.end_ref).padStart(5, "0")}` : null;
      const start = (refStart && byRef.get(refStart)) || bySeq.get(b.start_seq);
      const end = (refEnd && byRef.get(refEnd)) || bySeq.get(b.end_seq);
      if (!start || !end) {
        skipped.push({ block: b.block_id, reason: "range not found", refStart, refEnd });
        continue;
      }
      let payload = {};
      try {
        payload = JSON.parse(b.payload_json);
      } catch {
        /* payload is optional */
      }
      const summary = String(payload.summary ?? summaryOf(b.summary_hash) ?? "");
      if (!summary.trim()) continue;
      const covered = [];
      for (const [seq, m] of bySeq) if (seq >= start.seq && seq <= end.seq) covered.push(m);
      state.folds.push({
        id: `bili-${sessionId}-${b.block_id}`,
        startRef: `m${String(b.start_ref ?? 0).padStart(5, "0")}`,
        endRef: `m${String(b.end_ref ?? 0).padStart(5, "0")}`,
        startBlock: start.blockId,
        endBlock: end.blockId,
        topic: String(payload.topic ?? "").slice(0, 120),
        summary,
        bytes: covered.reduce((n, m) => n + Buffer.byteLength(m.text), 0),
        blocks: covered.map((m) => ({ blockId: m.blockId, ref: m.ref, role: m.role, text: m.text })),
        refs: covered.length,
        importedFrom: { store: "billion-context", block: b.block_id, tier: b.tier },
      });
    }

    if (!args.dryRun) writeJson(join(storeDir, "sessions", `${sessionId}.json`), state);
    report.sessions.push({
      session: sessionId,
      namespace: namespace ?? null,
      messages: written,
      folds: state.folds.length,
      refs: Object.keys(state.refs).length,
      skipped: skipped.length,
    });
    report.blocks += written;
    report.folds += state.folds.length;
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${args.dryRun ? "[dry-run] " : ""}${report.blocks} 个消息块 / ${report.folds} 个折叠来自 ${report.sessions.length} 个会话`);
    for (const s of report.sessions.slice(0, 10)) {
      console.log(`  · ${s.session} [${s.namespace ?? "?"}] 消息 ${s.messages} 折叠 ${s.folds} refs ${s.refs}`);
    }
    if (report.sessions.length > 10) console.log(`  … 还有 ${report.sessions.length - 10} 个会话`);
    console.log(`写入 ${report.store}`);
  }
}

main();
