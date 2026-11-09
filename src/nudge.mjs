// When to ask for a fold. The rule is a pure function of the numbers on disk and in
// this request, so a retry of the same body reaches the same answer and never nudges twice.
//
// One trigger only: growth since the last fold. billion-context pins that cadence at a flat
// 50K for every window size (nudge.growthFloor == nudge.growthCap), and a hook is never told
// the model's window anyway — a percentage here would be a guess dressed up as a gate.
//
// One alert per growth epoch: the fingerprint carries the floor and the fold count and nothing
// else. It used to carry `round(since / 500)`, which moved every 500 tokens of growth, so the
// dedupe never held and a session past the floor was asked again on every request — measured in
// the container as one alert per request, twenty turns, zero folds. Growth moves the numbers a
// reader sees; only a fold starts a new epoch.
//
// And an alert nobody can act on is noise: past the floor the foldable window must reclaim at
// least `nudgeMinGain` tokens, or the nudge is held back with its reason recorded. billion-context
// gates the same way (`minPressureBenefit = max(5000, window × 0.01)`); it knows the window and
// we do not, so the floor's share stands in for it, which lands on the same 5 000 at the shipped
// 50 000 floor and still scales when a canary sets a smaller one.

export const NUDGE_NONE = "none";
export const NUDGE_HINT = "hint";

/** Held-back reasons, spelled out so `acp_status` can say which one fired. */
export const NUDGE_BELOW_FLOOR = "below-floor";
export const NUDGE_NO_WINDOW = "no-window";
export const NUDGE_SMALL_WINDOW = "small-window";

/** The minimum-benefit gate, as shares of what we do know. See the header for why. */
export const MIN_GAIN_OF_FLOOR = 0.1;
export const MIN_GAIN_OF_CONTEXT = 0.01;

/** Tokens the foldable window must hold before asking is worth the model's attention. */
export function nudgeMinGain({ growthFloor = 50000, contextTokens = 0 } = {}) {
  const floor = Math.max(0, Number(growthFloor) || 0);
  const context = Math.max(0, Number(contextTokens) || 0);
  return Math.max(1, Math.round(floor * MIN_GAIN_OF_FLOOR), Math.round(context * MIN_GAIN_OF_CONTEXT));
}

export function decideNudge({
  cfg,
  sinceGrowth = 0,
  lastNudge = null,
  folds = 0,
  answeredSince = false,
  reclaimable = 0,
  contextTokens = 0,
}) {
  const growthFloor = Math.max(1, Number(cfg?.nudge?.growthFloor) || 50000);
  // Growth is measured against what has already been folded away: a session that keeps
  // folding keeps its growth at the size of the unfolded tail.
  const since = Math.max(0, Number(sinceGrowth) || 0);
  if (since < growthFloor) return { kind: NUDGE_NONE, reason: NUDGE_BELOW_FLOOR, since, growthFloor };

  const minGain = nudgeMinGain({ growthFloor, contextTokens });
  const window = Math.max(0, Number(reclaimable) || 0);
  if (window < minGain) {
    return {
      kind: NUDGE_NONE,
      reason: window === 0 ? NUDGE_NO_WINDOW : NUDGE_SMALL_WINDOW,
      since,
      growthFloor,
      reclaimable: window,
      minGain,
    };
  }

  // A retry resends the very same body: same growth, same fold count, so the fingerprint
  // matches. Dropping it then would be wrong — the first attempt may never have reached the
  // model. Only an answer *since* the last nudge proves it was delivered, so only then is the
  // second copy a repeat; everything else is a fresh chance to be seen.
  const fingerprint = `${NUDGE_HINT}:${growthFloor}:${folds}`;
  const repeat = Boolean(lastNudge && lastNudge.fingerprint === fingerprint && answeredSince);
  return { kind: NUDGE_HINT, since, growthFloor, fingerprint, repeat, reclaimable: window, minGain };
}

const tok = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

export function nudgeText({ since, growthFloor, range }) {
  return (
    `[acp] 上下文自上次折叠后增长了 ${tok(since)} tokens(${tok(growthFloor)} 是提醒线);` +
    `可折叠范围是 ${range};如果这些早期细节已经不需要逐字保留,调用 compress 折叠它们,` +
    `摘要要能让后来的人不需要原文也能继续。`
  );
}
