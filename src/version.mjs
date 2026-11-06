/**
 * The staleness hint for `acp_status`: one line naming the version the user is
 * actually running, plus the newest published version when the running copy is
 * behind the moving pointer, and `local build` when it is ahead of anything
 * published. Everything here must fail silent — a broken check
 * may never turn into error text on a tool the user asked for something else.
 *
 * The installed copy is what magpie placed under `<cwd>/plugins/node_modules/<pkg>`;
 * a developer checkout has none, and falls back to this package's own manifest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_URL =
  "https://raw.githubusercontent.com/CrazyTomatooOo/magpie-acp-context/magpie-plugin/package.json";
const ownManifest = fileURLToPath(new URL("../package.json", import.meta.url));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The version of the copy that is actually running, or null when no manifest is readable. */
export function ownVersion(cwd = process.cwd()) {
  const own = readJson(ownManifest);
  const installed = own?.name ? readJson(join(cwd, "plugins", "node_modules", own.name, "package.json")) : null;
  const version = installed?.version ?? own?.version;
  return typeof version === "string" && version ? version : null;
}

function parseVersion(str) {
  if (typeof str !== "string") return null;
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(str);
  if (!m) return null;
  return { core: m[1].split(".").map(Number), pre: m[2] ?? null };
}

function comparePrerelease(a, b) {
  const ia = a.split(".");
  const ib = b.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Numeric per-component comparison with the leading `v` of a git tag tolerated
 * and a prerelease ordered below its release: negative when `a` is older,
 * positive when `a` is newer, 0 when equal, null when either side cannot be
 * parsed.
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d) return d;
  }
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return comparePrerelease(va.pre, vb.pre);
}

/**
 * The line for a running version and the version at the moving pointer: behind
 * names the published newest, ahead says `local build`, and equal or unparsable
 * names the running version only.
 */
function comparisonLine(own, latest) {
  const cmp = compareVersions(own, latest);
  if (cmp === null || cmp === 0) return `version ${own}`;
  return cmp < 0 ? `version ${own} · latest ${latest}` : `version ${own} · local build`;
}

/**
 * `version <own> · latest <published>` when behind the moving pointer,
 * `version <own> · local build` when ahead of anything published, plain
 * `version <own>` when current or when either version cannot be parsed — or
 * null when anything failed. One uncached fetch per call; the timeout keeps a
 * slow network from stalling the tool.
 */
export async function versionLine(cwd = process.cwd()) {
  const own = ownVersion(cwd);
  if (!own) return null;
  let latest;
  try {
    const res = await fetch(PUBLISHED_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    latest = (await res.json())?.version;
  } catch {
    return null;
  }
  if (typeof latest !== "string" || !latest) return null;
  return comparisonLine(own, latest);
}
