/**
 * The staleness hint for `acp_status`: one line naming the version the user is
 * actually running, plus the newest published version when the running copy is
 * behind the moving pointer. Everything here must fail silent — a broken check
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

function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * `version <own>` or `version <own> · latest <published>`, or null when anything failed.
 * One uncached fetch per call; the timeout keeps a slow network from stalling the tool.
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
  return isNewer(latest, own) ? `version ${own} · latest ${latest}` : `version ${own}`;
}
