# Coding standards

What `/code-review` enforces here beyond a passing suite. Only rules no automated check can carry: a check that could catch one of these belongs in `test/` instead, and the rule should be deleted from this file.

## Every gate ships both ways

A refusal is half a gate. Assert the direction that fires **and** the direction that must not: the same history with the offending unit removed still folds, the same range that is refused settles once it sits after the blocker. `test/media-protection.test.mjs` and `test/offer-apply-parity.test.mjs` are the shape.

## A new gate reaches the offer side through the shared judgment

`planFolds` advertises a range and validates a range. They must agree by construction, not by coincidence: a new refusal that can refuse an advertised range has to enter `citable()` / the barrier set / `foldable`, so `test/invariants.test.mjs` keeps passing without a new bespoke test. A second predicate that happens to produce the same answer today is the defect (#9 → #16 → #10 were the same class, three times).

## A refusal names the ref it refuses

Every rejection string carries the `mNNNNN` of the unit that caused it and a sentence a model can act on: which unit, why, and where the range may start instead. "超出可折叠窗口" alone is a dead end; `范围含媒体消息 m00002…请把范围收在它之后` is an instruction.

## A gate updates the rules it enforces

`docs/magpie-acp-plugin-design.md` §7 lists the safety rules and the decision-site table beneath them. A gate that isn't in that list, or a new decision site that isn't in the table, is a doc that will mislead the next session.
