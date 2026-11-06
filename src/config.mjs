import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
  enabled: false,
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
  // windowTokens is ours, not the provider's: a hook is never told the model's window,
  // so the percentage has to be taken of a number the owner states.
  nudge: { windowTokens: 200000, minContextPct: 0.45, growthFloor: 50000, growthRatio: 0.45, emergencyPct: 0.95 },
  store: { dir: "~/.local/share/magpie-acp", maxBytes: 536870912, ttlDays: 30 },
  gatewayTimeoutMs: 3000,
  failOpen: true,
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
  if (process.env.MAGPIE_ACP_WINDOW) cfg.nudge = { ...cfg.nudge, windowTokens: Number(process.env.MAGPIE_ACP_WINDOW) };
  if (process.env.MAGPIE_ACP_MIN_PCT) cfg.nudge = { ...cfg.nudge, minContextPct: Number(process.env.MAGPIE_ACP_MIN_PCT) };
  if (process.env.MAGPIE_ACP_EMERGENCY_PCT) cfg.nudge = { ...cfg.nudge, emergencyPct: Number(process.env.MAGPIE_ACP_EMERGENCY_PCT) };
  if (process.env.MAGPIE_ACP_GROWTH_FLOOR) cfg.nudge = { ...cfg.nudge, growthFloor: Number(process.env.MAGPIE_ACP_GROWTH_FLOOR) };
  if (process.env.MAGPIE_ACP_AGENTS !== undefined) {
    cfg.agents = String(process.env.MAGPIE_ACP_AGENTS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.agents = Array.isArray(cfg.agents) ? cfg.agents.map(String).filter(Boolean) : [];
  if (process.env.MAGPIE_ACP_ORIGINS !== undefined) {
    cfg.origins = String(process.env.MAGPIE_ACP_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  cfg.origins = Array.isArray(cfg.origins) ? cfg.origins.map(String).filter(Boolean) : [];
  cfg.storeDir = resolveDir(cfg.store.dir);
  cfg.budgetMs = Math.max(200, Math.min(2000, Number(cfg.gatewayTimeoutMs) - 200));
  return cfg;
}

export function resolveDir(dir) {
  const raw = String(dir || DEFAULTS.store.dir);
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  return expanded;
}
