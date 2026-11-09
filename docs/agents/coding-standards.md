# Coding standards

What `/code-review` enforces here beyond a passing suite. Only rules no automated check can carry: a check that could catch one of these belongs in `test/` instead, and the rule should be deleted from this file.

## Every gate ships both ways

A refusal is half a gate. Assert the direction that fires **and** the direction that must not: the same history with the offending unit removed still folds, the same range that is refused settles once it sits after the blocker. `test/media-protection.test.mjs` and `test/offer-apply-parity.test.mjs` are the shape.

## A new gate reaches the offer side through the shared judgment

`planFolds` advertises a range and validates a range. They must agree by construction, not by coincidence: a new refusal that can refuse an advertised range has to enter `citable()` / the barrier set / `foldable`, so `test/invariants.test.mjs` keeps passing without a new bespoke test. A second predicate that happens to produce the same answer today is the defect (#9 → #16 → #10 were the same class, three times).

## A refusal names the ref it refuses

Every rejection string carries the `mNNNNN` of the unit that caused it and a sentence a model can act on: which unit, why, and where the range may start instead. "超出可折叠窗口" alone is a dead end; `范围含媒体消息 m00002…请把范围收在它之后` is an instruction.

## A gate is proven on all four wires

`test/matrix.test.mjs` is the default home for a new gate: one abstract transcript, two rows (`fires` / `holds`), executed on chat, anthropic, responses and gemini. A gate written against one wire's shape is the bug this matrix exists to catch — chat once stamped a bare tool call because it sniffed the call's arguments as prose, and only the four-wire rows saw it. Gates that never read the body (a limit, a latch) go in `ELSEWHERE` with the file that does the work instead of four copies of one assertion.

## A gate updates the rules it enforces

`docs/magpie-acp-plugin-design.md` §7 lists the safety rules and the decision-site table beneath them. A gate that isn't in that list, or a new decision site that isn't in the table, is a doc that will mislead the next session.

## A history fixture is written once

`test/fixtures.mjs` owns the skeleton: `transcript()` (which refuses a history that does not open on a user turn), `unit()`, `planOf()`, the summary sentences, the ack text, `compressCall`/`compressAck`, `tempStore`/`wireOptions`. A test with its own copy of that map-and-number loop is how eight copies drifted and one of them measured the wrong range for two months. Test-specific histories stay in their file — built out of these pieces, not beside them.
