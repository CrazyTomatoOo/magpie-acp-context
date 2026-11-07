import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const importer = join(here, "..", "scripts", "import-bili.mjs");

// The importer is documented as `node scripts/import-bili.mjs` and reads bili's SQLite through
// `node:sqlite`, which Bun does not implement: run both the fixture and the script on node.
const NODE = process.env.BILI_IMPORT_NODE || "node";
const NODE_HAS_SQLITE = spawnSync(NODE, ["-e", "require('node:sqlite')"], { encoding: "utf8" }).status === 0;

// bili's real schema, copied column for column: `namespace` sits on `sessions`, never on
// `messages`. The importer used to read it off `messages` and died on any real database
// ("no such column: namespace") — this fixture is what makes that regression loud.
const SCHEMA = `
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, parent_session_id TEXT, fork_point_seq INTEGER,
  protocol TEXT, label TEXT, title TEXT, host_title TEXT, namespace TEXT NOT NULL DEFAULT 'proxy',
  origin TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  next_block_id INTEGER NOT NULL DEFAULT 1, next_run_id INTEGER NOT NULL DEFAULT 1,
  meta_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}', kstate_json TEXT NOT NULL DEFAULT '{}',
  tail_json TEXT NOT NULL DEFAULT '{}', ccr_json TEXT, last_ingested_seq INTEGER, orphans_json TEXT);
CREATE TABLE content (hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL, refcount INTEGER NOT NULL DEFAULT 0,
  algo TEXT NOT NULL DEFAULT 'sha256', bytes BLOB NOT NULL);
CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL, ref TEXT,
  ref_num INTEGER, role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
  content_hash TEXT NOT NULL REFERENCES content(hash), identity TEXT NOT NULL DEFAULT '',
  retired_at INTEGER, ts INTEGER, PRIMARY KEY (session_id, seq),
  UNIQUE (session_id, msg_id, content_hash));
CREATE TABLE blocks (block_id TEXT NOT NULL, session_id TEXT NOT NULL, ord INTEGER NOT NULL,
  start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, start_ref INTEGER, end_ref INTEGER,
  tier INTEGER NOT NULL, summary_hash TEXT NOT NULL REFERENCES content(hash), one_hash TEXT,
  supersedes_block_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  covered_hash TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (session_id, block_id));
`;

const BUILDER = `
const { DatabaseSync } = require("node:sqlite");
const { writeFileSync } = require("node:fs");
const [dbPath, schemaPath, fixturePath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec(require("node:fs").readFileSync(schemaPath, "utf8"));
const fixture = JSON.parse(require("node:fs").readFileSync(fixturePath, "utf8"));

const putContent = db.prepare("INSERT INTO content (hash, byte_len, refcount, bytes) VALUES (?, ?, 0, ?)");
const putMessage = db.prepare(
  "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, retired_at, ts) VALUES (?, ?, ?, ?, ?, ?, 'message', ?, ?, 1)",
);
const putBlock = db.prepare(
  "INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, active, created_at, covered_hash, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, ?, ?)",
);
const putSession = db.prepare(
  "INSERT INTO sessions (session_id, namespace, created_at, updated_at) VALUES (?, ?, 1, 1)",
);

for (const s of fixture.sessions) {
  putSession.run(s.session_id, s.namespace);
  for (const m of s.messages) {
    const bytes = Buffer.from(JSON.stringify({ id: m.ref, role: m.role, contentType: "text", text: m.text }));
    putContent.run(m.hash, bytes.length, bytes);
    putMessage.run(s.session_id, m.seq, m.ref, m.ref, Number(m.ref.slice(1)), m.role, m.hash, m.retired_at ?? null);
  }
  for (const b of s.blocks ?? []) {
    const bytes = Buffer.from(JSON.stringify({ text: b.summary }));
    putContent.run(b.summary_hash, bytes.length, bytes);
    putBlock.run(b.block_id, s.session_id, b.ord, b.start_seq, b.end_seq, b.start_ref, b.end_ref, b.summary_hash, b.covered_hash, b.payload_json);
  }
}
db.close();
`;

const FIXTURE = {
  sessions: [
    {
      session_id: "sess-dsh",
      namespace: "dsh",
      messages: [
        { seq: 1, ref: "m00001", role: "user", hash: "h1", text: "第一条消息", retired_at: 1700000000 },
        { seq: 2, ref: "m00002", role: "assistant", hash: "h2", text: "第二条消息" },
        { seq: 3, ref: "m00003", role: "user", hash: "h3", text: "第三条消息" },
      ],
      blocks: [
        {
          block_id: "b1",
          ord: 1,
          start_seq: 0,
          end_seq: 0,
          start_ref: 1,
          end_ref: 2,
          summary_hash: "sum1",
          covered_hash: "cov1",
          payload_json: JSON.stringify({ summary: "前两条的摘要", topic: "开场" }),
          summary: "前两条的摘要",
        },
      ],
    },
    {
      session_id: "sess-omp",
      namespace: "omp",
      messages: [
        { seq: 1, ref: "m00001", role: "user", hash: "h4", text: "omp 的第一条" },
        { seq: 2, ref: "m00002", role: "assistant", hash: "h5", text: "omp 的第二条" },
        { seq: 3, ref: "m00003", role: "user", hash: "h6", text: "omp 的第三条" },
        { seq: 4, ref: "m00004", role: "assistant", hash: "h7", text: "omp 的第四条" },
      ],
    },
  ],
};

function biliDb() {
  const dir = mkdtempSync(join(tmpdir(), "acp-import-"));
  const schemaPath = join(dir, "schema.sql");
  const fixturePath = join(dir, "fixture.json");
  const builderPath = join(dir, "build.cjs");
  writeFileSync(schemaPath, SCHEMA);
  writeFileSync(fixturePath, JSON.stringify(FIXTURE));
  writeFileSync(builderPath, BUILDER);
  const dbPath = join(dir, "index.db");
  const built = spawnSync(NODE, [builderPath, dbPath, schemaPath, fixturePath], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`fixture failed: ${built.stderr || built.stdout}`);
  return { dir, dbPath };
}

function importStore({ dbPath, dir, args }) {
  const store = join(dir, "store");
  const run = spawnSync(NODE, [importer, "--db", dbPath, "--store", store, ...args], { encoding: "utf8" });
  return { store, run };
}

const report = ({ run }) => JSON.parse(run.stdout);

describe.skipIf(!NODE_HAS_SQLITE)("import-bili reads bili's store as it actually is", () => {
  test("--all lists every session and its namespace, without a namespace column on messages", () => {
    const fixture = biliDb();
    const result = importStore({ ...fixture, args: ["--all", "--dry-run", "--json"] });

    expect(result.run.status).toBe(0);
    const out = report(result);
    expect(out.sessions.map((s) => s.session).sort()).toEqual(["sess-dsh", "sess-omp"]);
    expect(out.sessions.map((s) => s.namespace).sort()).toEqual(["dsh", "omp"]);
    expect(out.folds).toBe(1);
    expect(out.blocks).toBe(7);
    expect(existsSync(join(result.store, "sessions"))).toBe(false);
  });

  test("--namespace narrows to that client's sessions", () => {
    const fixture = biliDb();
    const result = importStore({ ...fixture, args: ["--namespace", "dsh", "--dry-run", "--json"] });

    expect(result.run.status).toBe(0);
    const out = report(result);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({ session: "sess-dsh", namespace: "dsh", messages: 3, folds: 1 });
  });

  test("a real run writes the state, its refs and the fold that covers m00001–m00002", () => {
    const fixture = biliDb();
    const result = importStore({ ...fixture, args: ["--namespace", "dsh", "--json"] });

    expect(result.run.status).toBe(0);
    const state = JSON.parse(readFileSync(join(result.store, "sessions", "sess-dsh.json"), "utf8"));
    const refs = Object.values(state.refs);
    expect(refs.sort()).toEqual(["m00001", "m00002", "m00003"]);
    expect(state.next).toBe(4);
    expect(state.folds).toHaveLength(1);
    expect(state.folds[0]).toMatchObject({ startRef: "m00001", endRef: "m00002", topic: "开场", refs: 2 });
    expect(state.folds[0].summary).toBe("前两条的摘要");

    const blocks = readdirSync(join(result.store, "blocks"));
    expect(blocks).toHaveLength(3);
    const folded = JSON.parse(readFileSync(join(result.store, "blocks", `${state.folds[0].startBlock}.json`), "utf8"));
    expect(folded).toMatchObject({ role: "user", ref: "m00001", session: "sess-dsh", source: { from: "billion-context" } });
  });
});
