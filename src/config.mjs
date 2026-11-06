import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
  // On by default (owner decision, wayfinder ticket #14): a plugin installed and loaded but
  // silent is indistinguishable from a broken one, and it is the failure the first real-client
  // run actually hit. What "on" costs is a ~100-character prompt and `[mNNNNN]` prefixes - the
  // hook never folds anything the agent did not hand it through the compress tool - and an
  // operator turns it off with the host's own switch: `magpie plugin off magpie-acp-context`.
  enabled: true,
  // agents: a canary list. Empty means "every agent"; naming agents means "only these"
  // (magpie reports the client in ctx.agent). Rollout is then one client at a time and a
  // client left out of the list sees byte-identical requests.
  agents: [],
  // origins: which callers this plugin serves at all. magpie derives this itself
  // (`local` for a loopback request, `magpie-key` for the owner's own sharing key,
  // `gateway-key`/`remote` for anyone else's), so a request proxied in from another
  // machine cannot write into this store or be recorded here. An unknown origin
  // (an older host, or no value) is not local and is skipped.
  origins: ["local", "magpie-key"],
  mode: "assist", // assist | render
  injectStyle: "append-user", // append-user | system-suffix
  refFormat: "m%05d",
  minRangeBytes: 5000,
  maxSummaryChars: 20000,
  keepRecentTurns: 3,
  // One knob, because there is one trigger: growth since the last fold. billion-context
  // pins the cadence at a flat 50K for every window size, and a hook is never told the
  // model's window, so a percentage here would be a guess.
  nudge: { growthFloor: 50000 },
  store: { dir: "~/.local/share/magpie-acp", maxBytes: 536870912, ttlDays: 30 },
  gatewayTimeoutMs: 3000,
  failOpen: true,
  // updateCheck: the staleness hint in `acp_status` costs one unauthenticated GET a day. A user
  // who wants nothing to leave the machine turns it off — and off means no line, no request,
  // and no read of the cache entry either.
  updateCheck: true,
  // debug: the fold decision of every request onto the host's stderr, plus the stack of
  // anything the hook swallowed. A hook never breaks a request, so this is the only way
  // to see why a compression the agent reported did not reach the wire.
  debug: false,
};

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** `magpie plugin options` wins over the manifest defaults; env wins over both (tests). */
export function loadConfig(options = {}) {
  const cfg = merge(DEFAULTS, options);
  if (process.env.MAGPIE_ACP_MODE) cfg.mode = process.env.MAGPIE_ACP_MODE;
  if (process.env.MAGPIE_ACP_STORE) cfg.store = { ...cfg.store, dir: process.env.MAGPIE_ACP_STORE };
  if (process.env.MAGPIE_ACP_ENABLED === "1") cfg.enabled = true;
  if (process.env.MAGPIE_ACP_INJECT_STYLE) cfg.injectStyle = process.env.MAGPIE_ACP_INJECT_STYLE;
  if (process.env.MAGPIE_ACP_KEEP_TURNS) cfg.keepRecentTurns = Number(process.env.MAGPIE_ACP_KEEP_TURNS);
  if (process.env.MAGPIE_ACP_MIN_BYTES) cfg.minRangeBytes = Number(process.env.MAGPIE_ACP_MIN_BYTES);
  if (process.env.MAGPIE_ACP_GROWTH_FLOOR) cfg.nudge = { ...cfg.nudge, growthFloor: Number(process.env.MAGPIE_ACP_GROWTH_FLOOR) };
  if (process.env.MAGPIE_ACP_AGENTS !== undefined) {
    cfg.agents = String(process.env.MAGPIE_ACP_AGENTS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.agents = Array.isArray(cfg.agents) ? cfg.agents.map(String).filter(Boolean) : [];
  if (process.env.MAGPIE_ACP_DEBUG === "1") cfg.debug = true;
  if (process.env.MAGPIE_ACP_ORIGINS !== undefined) {
    cfg.origins = String(process.env.MAGPIE_ACP_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.origins = Array.isArray(cfg.origins) ? cfg.origins.map(String).filter(Boolean) : [];
  cfg.storeDir = resolveDir(cfg.store.dir);
  cfg.budgetMs = Math.max(200, Math.min(2000, Number(cfg.gatewayTimeoutMs) - 200));
  // Tri-state: 1/true and 0/false win over user options in both directions; unset (or an
  // unrecognized value) leaves what the options resolved to.
  if (process.env.MAGPIE_ACP_UPDATE_CHECK !== undefined) {
    const on = process.env.MAGPIE_ACP_UPDATE_CHECK.toLowerCase();
    if (on === "1" || on === "true") cfg.updateCheck = true;
    else if (on === "0" || on === "false") cfg.updateCheck = false;
  }
  return cfg;
}

export function resolveDir(dir) {
  const raw = String(dir || DEFAULTS.store.dir);
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return expanded;
}
