// When to ask for a fold, and how loud. The rule is a pure function of the
// numbers on disk and in this request, so a retry of the same body reaches the
// same answer and never nudges twice.

export const NUDGE_NONE = "none";
export const NUDGE_HINT = "hint";
export const NUDGE_EMERGENCY = "emergency";

/** Token counts the way billion-context thresholds them. */
export function decideNudge({ cfg, contextTokens, sinceGrowth = null, lastNudge = null, folds = 0, answeredSince = false }) {
  const n = cfg.nudge;
  const window = Math.max(1000, n.windowTokens);
  const pct = contextTokens / window;
  // Growth is measured against what has already been folded away: a session that keeps
  // folding keeps its growth at the size of the unfolded tail.
  const since = sinceGrowth == null ? contextTokens : sinceGrowth;
  const growthFloor = Math.max(n.growthFloor, Math.round(window * n.growthRatio));
  const overGrowth = since >= growthFloor;
  const overFloor = pct >= n.minContextPct;

  let kind = NUDGE_NONE;
  if (pct >= n.emergencyPct) kind = NUDGE_EMERGENCY;
  else if (overFloor && overGrowth) kind = NUDGE_HINT;

  if (kind === NUDGE_NONE) return { kind, pct, since, growthFloor };

  // A retry resends the very same body: same tokens, same fold count, so the fingerprint
  // matches. Dropping it then would be wrong — the first attempt may never have reached the
  // model. Only an answer *since* the last nudge proves it was delivered, so only then is the
  // second copy a repeat; everything else is a fresh chance to be seen.
  const fingerprint = `${kind}:${window}:${Math.round(contextTokens / 500)}:${folds}`;
  const repeat = Boolean(lastNudge && lastNudge.fingerprint === fingerprint && answeredSince);
  return { kind, pct, since, growthFloor, fingerprint, repeat };
}

const pctText = (pct) => `${Math.round(pct * 100)}%`;

export function nudgeText({ kind, pct, range }, cfg) {
  const where = range ? `可折叠范围是 ${range};` : "还没有可以折叠的范围;";
  if (kind === NUDGE_EMERGENCY) {
    return (
      `[acp] 上下文已用到 ${pctText(pct)}(${cfg.nudge.emergencyPct * 100}% 是硬线),` +
      `${where}请现在就调用 compress 折叠,并给出一句能替代整段细节的摘要。`
    );
  }
  return (
    `[acp] 上下文已用到 ${pctText(pct)};` +
    `${where}如果这些早期细节已经不需要逐字保留,调用 compress 折叠它们,` +
    `摘要要能让后来的人不需要原文也能继续。`
  );
}
