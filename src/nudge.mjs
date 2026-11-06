// When to ask for a fold. The rule is a pure function of the numbers on disk and in
// this request, so a retry of the same body reaches the same answer and never nudges twice.
//
// One trigger only: growth since the last fold. billion-context pins that cadence at a flat
// 50K for every window size (nudge.growthFloor == nudge.growthCap), and a hook is never told
// the model's window anyway — a percentage here would be a guess dressed up as a gate.

export const NUDGE_NONE = "none";
export const NUDGE_HINT = "hint";

export function decideNudge({ cfg, sinceGrowth = 0, lastNudge = null, folds = 0, answeredSince = false }) {
  const growthFloor = Math.max(1, Number(cfg?.nudge?.growthFloor) || 50000);
  // Growth is measured against what has already been folded away: a session that keeps
  // folding keeps its growth at the size of the unfolded tail.
  const since = Math.max(0, Number(sinceGrowth) || 0);
  if (since < growthFloor) return { kind: NUDGE_NONE, since, growthFloor };

  // A retry resends the very same body: same growth, same fold count, so the fingerprint
  // matches. Dropping it then would be wrong — the first attempt may never have reached the
  // model. Only an answer *since* the last nudge proves it was delivered, so only then is the
  // second copy a repeat; everything else is a fresh chance to be seen.
  const fingerprint = `${NUDGE_HINT}:${growthFloor}:${Math.round(since / 500)}:${folds}`;
  const repeat = Boolean(lastNudge && lastNudge.fingerprint === fingerprint && answeredSince);
  return { kind: NUDGE_HINT, since, growthFloor, fingerprint, repeat };
}

const tok = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

export function nudgeText({ since, growthFloor, range }) {
  const where = range ? `可折叠范围是 ${range};` : "还没有可以折叠的范围;";
  return (
    `[acp] 上下文自上次折叠后增长了 ${tok(since)} tokens(${tok(growthFloor)} 是提醒线);` +
    `${where}如果这些早期细节已经不需要逐字保留,调用 compress 折叠它们,` +
    `摘要要能让后来的人不需要原文也能继续。`
  );
}
