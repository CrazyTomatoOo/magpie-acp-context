import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A release is three files agreeing with each other: the manifest, the changelog and the tag the
// install follows. Only the first two live in the repo, and they drift silently — a bump without a
// heading ships a version nobody can read up, a heading without a bump ships a lie. The tag itself
// cannot be checked from here; `#26` ties it to this commit instead.
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const readme = readFileSync(new URL("README.md", root), "utf8");

const changelog = readme.slice(readme.indexOf("## Changelog"), readme.indexOf("## Tests"));
const releases = [];
for (const line of changelog.split("\n")) {
  const heading = /^\*\*(\d+\.\d+\.\d+)\*\*/.exec(line);
  if (heading) releases.push({ version: heading[1], at: changelog.indexOf(line), body: "" });
}
for (let i = 0; i < releases.length; i += 1) {
  const end = i + 1 < releases.length ? releases[i + 1].at : changelog.length;
  releases[i].body = changelog.slice(releases[i].at + 1, end);
}
const bullets = (body) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/\s+/g, " ").trim());

describe("the changelog and the manifest", () => {
  test("the changelog has at least one released version", () => {
    expect(releases.length).toBeGreaterThan(0);
  });

  test("the manifest names the newest version in the changelog", () => {
    expect(manifest.version).toBe(releases[0].version);
  });

  test("nothing is left unreleased above the newest version", () => {
    const before = changelog.slice(0, releases[0].at);
    expect(before).not.toContain("Unreleased");
    expect(before).not.toContain("unreleased");
  });

  test("versions descend and each one carries its own bullets", () => {
    for (let i = 0; i < releases.length; i += 1) {
      expect(bullets(releases[i].body).length).toBeGreaterThan(0);
      if (i > 0) {
        const [older, newer] = [releases[i].version.split(".").map(Number), releases[i - 1].version.split(".").map(Number)];
        const descends = newer[0] > older[0] || (newer[0] === older[0] && (newer[1] > older[1] || (newer[1] === older[1] && newer[2] > older[2])));
        expect(descends).toBe(true);
      }
    }
  });

  test("no bullet repeats across releases", () => {
    // A release note that copies an earlier one hides a version that shipped nothing new.
    const seen = new Map();
    const repeated = [];
    for (const release of releases) {
      for (const bullet of bullets(release.body)) {
        const owner = seen.get(bullet);
        if (owner) repeated.push(`${bullet} (${owner} and ${release.version})`);
        else seen.set(bullet, release.version);
      }
    }
    expect(repeated).toEqual([]);
  });
});
