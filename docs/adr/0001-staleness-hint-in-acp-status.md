# A staleness hint lives in `acp_status`, not in the hook

## Status

accepted

## Context

Nothing tells a user their installed copy is behind the moving pointer. `magpie plugin update` is
the only writer, magpie records no resolved version for a third-party plugin (only the typed spec,
`store.go:46-70`), and it offers no notice API a plugin could raise: What's New is built from
magpie's own release feed (`internal/gui/whatsnew.go`), and the panel's `Notice` field is filled
only by magpie's own agents. A plugin's only user-visible surfaces are its own page/panels and the
log.

## Decision

The staleness hint is produced inside the `acp_status` tool — the one call a user makes on purpose
— and nowhere else. The tool reads its own installed version from
`<cwd>/plugins/node_modules/<pkg>/package.json` (falling back to its own `package.json` for a
checkout), fetches the version at the `magpie-plugin` pointer from
`raw.githubusercontent.com/<owner>/<repo>/magpie-plugin/package.json` (one unauthenticated GET),
and reports both versions as a flat fact. The answer is cached in the store directory for 24 hours;
a failed check is silent and pushes the next attempt 6 hours out. `updateCheck: false` removes the
line and the call.

## Considered Options

- **Check in `onRequest`** — would reach the user without them asking, but the hook is invariant:
  it never calls the network and never calls a model, which is what makes `failOpen` and the 1 s
  budget safe. Every turn would also pay the latency.
- **Self-update** — magpie owns the install (`bun add`/`bun update` inside
  `~/.config/magpie/plugins`); writing there behind its back would fight the one-writer rule that
  #991 established on the billion-context side.
- **Own page/panel** — the only real UI a plugin can draw, but it means a page nav item for one
  line of text, and nobody opens it.

## Consequences

The hint only reaches a user who runs `acp_status`, and only reaches them through the model's
transcript. That is accepted: the alternative was a banner nobody can put up. Whether "newer
version exists" is the same question as "should you upgrade" is deliberately left to the reader —
the line states two versions and stops.
