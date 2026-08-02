# ADR-001: The release gate asks the world, not the executor

## Status

Accepted

## Date

2026-08-02

## Context

Every runtime-safety check in `lib/gate.ts` asked the executor about itself.
`result.restored` is the executor's own count of what it believes it compensated, and
`fabricationCheck` compares that count against the journal **the same executor wrote**.
One witness, asked twice.

That is weaker than it reads. An executor whose action ids, journal keys, or
idempotency keys are wrong will report a restoration, record it in its journal, and
never move the disk — and both checks pass. This is not hypothetical: it is commit
`d6d7472`, where `FsWorld` allocated action ids from an ephemeral in-memory counter, so
a reopened root produced a compensation that was reported, journal-confirmed, and never
applied.

The gate could not have caught it. It ran `recoveryScenario` (the in-memory world) and
called `fsRecoveryScenario` **zero times**, so the real filesystem adapter —
precisely where that class of bug lives — sat outside the thing that decides whether
this ships.

## Decision

The gate runs the **real on-disk scenario** and compares the world before and after,
plus a negative control proving the comparison can fail.

Four checks added (16 → 20):

1. `the REAL on-disk world returns to baseline (not the executor's account of itself)` —
   files, rows and ledger diffed against the pre-damage baseline.
2. `a fresh world over the same on-disk root replays with zero extra mutation` — durable
   idempotency.
3. `a REOPENED world recovers a SECOND round of damage` — the precondition d6d7472
   actually needs. Added 2026-08-02 after reintroducing the defect by hand: reverting
   `nextId()` to the ephemeral counter left the gate passing 19/19 while the unit suite
   failed 7 of 16. The original three checks damaged the world ONCE and replayed the SAME plan
   object, so the id allocator was never called twice and the motivating defect was
   structurally invisible. Verified both ways: with the defect reintroduced the gate now
   reports `reported=3 files=false rows=false` and FAILS.
4. `WORLD-TRUTH DETECTOR fires when a compensation is reported but never applied` — a
   world that returns success from every compensating method and touches nothing. Its
   executor account is spotless and its journal agrees; only the disk dissents.

The detector is not optional decoration. `lib/gate.ts`'s own comment states the rule it
enforces: *"a check that only observes a healthy run passes both when the invariant
holds and when the mechanism that enforces it has been gutted."* Without the detector,
the world comparison could silently decay into another reading of the executor's report.

### Public interface change

`fsRecoveryScenario` gains `opts.makeWorld?: (root: string) => FsWorld`. A **factory**,
not an instance, because the scenario builds a second world for the replay pass — a
detector that only lied on the first pass would be a weaker control.

## Alternatives considered

### Strengthen `fabricationCheck` instead

- Pros: one place to change; no new scenario in the gate.
- Cons: it cannot be strengthened into a world check. Its inputs are the executor's
  report and the executor's journal; no amount of comparison between two accounts by
  the same witness establishes that a third thing (the disk) moved.
- **Rejected**: wrong witness, not a weak comparison.

### Assert on the world inside `safeExecute`

- Pros: catches it at the source for every caller.
- Cons: the executor asserting on the world is the executor grading itself again, one
  layer down, and it would couple the saga loop to a specific world's snapshot shape.
- **Rejected**: same category error.

### Leave it to the test suite

- Pros: `fs-world.test.ts` and the durability tests already exercise `FsWorld`.
- Cons: the gate is what the release decision reads. `d6d7472` shipped on a branch whose
  suite was green, which is exactly the lesson: "gates green" must not be read as "the
  exec layer is clean."
- **Rejected**: the gate has to be able to fail for this class, or "gate passed" keeps
  meaning less than it sounds like.

## Consequences

- The gate now touches a real filesystem, so it is slower and needs a writable temp dir. Measured cost is small next to what it covers.
- **CORRECTION (2026-08-02).** This ADR previously claimed
  `gate:mutate` showed the new checks were load-bearing. That was wrong on two counts:
  only 2 of the 3 appear as catchers, and they appear for reasons unrelated to world
  truth (`kill-switch-branch-inverted` makes the whole run dry-run;
  `classifier-forced-to-irreversible` empties the plan). `gate-mutate.ts` contains **zero**
  mutations touching `fs-recover.ts`, `fs-world.ts` or `fs-journal.ts`. Adding them is
  open work.
- **CORRECTION.** The gate touches a real filesystem only. This ADR and `gate.ts`
  previously said "and sqlite database"; `SqlWorld` — which had the identical
  id-allocation defect, fixed in `c121a2e` — is **not** in the gate at all.
- Coverage moved 76.29 → 76.05 against a floor of 76, because the new gate code is real
  `lib/` surface that vitest never executes. The floor was **not** lowered and
  `gate.ts` was **not** excluded — the vitest config's own rule is that an untested
  module lowers the number instead of hiding from it. The margin was later restored to
  76.14 by testing the circuit breaker, which had no dedicated test at all.
- `fabricationCheck` keeps its name and meaning. It is a real check against a real
  failure mode (a lost durable write); it is simply not a check that the world changed,
  and the README no longer implies otherwise.
