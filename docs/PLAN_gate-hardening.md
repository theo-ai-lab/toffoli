# Implementation Plan: close the four gate findings left open

## Overview

Falsifying the world-truth gate — reintroducing, one at a time, each defect it claims to
guard — produced ten findings. The headline (the gate could not fail for `8897b1f`) is
fixed in `1d4dcb6`. Four remain, each reproduced by a concrete mutation. They are
sequenced here rather than left in a commit message, because a finding recorded in prose
is one nobody is accountable for.

**Ordering principle:** the two that let the gate pass while broken come first. A gate
that can be silently weakened is worse than a missing check, because it reports a
verdict either way.

## Architecture decisions

- **Do not weaken any check to make a task easier.** Every task below adds a way for the
  gate to FAIL; none removes one.
- **Each task must be verified by breaking it.** The lesson of `1d4dcb6` is that a check
  is unproven until the defect it targets is reintroduced and the gate goes red.

## Task list

### Phase 1: the gate can currently pass while broken

- [ ] **Task 1 — Make the detector assert each dimension separately (D2).** `XS`
  `gate.ts:95` asserts `!lying.recoverableRestored`, which is
  `!(files && rows && ledger)` — satisfied by any single live dimension. Gutting
  `sameRecord` to a constant `true` leaves the **full gate still passing**, with one
  `number ===` on the ledger as the only surviving world comparison.
  - Acceptance: the detector asserts `files === false`, `rows === false` and
    `ledger === false` individually, or uses three single-dimension lying worlds.
  - Verify: `sameRecord` → `true` must FAIL the gate. So must `readFiles()` → `{}`.
  - Files: `lib/gate.ts`, possibly `lib/exec/fs-recover.ts`.
  - Depends on: none.

- [ ] **Task 2 — Add a negative control for `idempotentOnReplay` (D4).** `S`
  `fs-recover.ts:144` compares two snapshots and **discards the replay's
  `RuntimeReport`**, so "replayed as a no-op" and "every step errored and the saga
  blocked the rest" are indistinguishable. Deleting the already-applied short-circuit at
  `fs-journal.ts:207` makes the gate print
  `✓ … replays with zero extra mutation (durable idempotency)` for a run with
  `restored=0 compFailed=1 blocked=3`.
  - Acceptance: the check asserts the replay REPORT (no `compensation-failed`, no
    `blocked`), not only the snapshot.
  - Verify: removing the `fs-journal.ts:207` short-circuit must FAIL the gate.
  - Note: `restored` is not usable as a discriminator — `once()` maps `already-applied`
    to `true`, so an honest replay also reports `restored=4`. Decide deliberately.
  - Files: `lib/exec/fs-recover.ts`, `lib/gate.ts`.
  - Depends on: none.

### Checkpoint A
- [ ] Both mutations above turn the gate red. `npm run gate` green on clean HEAD.
- [ ] 391+ tests, `gate:mutate` still 7/7.

### Phase 2: the gate misreports its own environment

- [x] **Task 3 — Pin `env: {}` in the real scenario (D5). DONE 2026-08-02.** `XS`
  `fs-recover.ts:127` calls `safeExecute` with no `env`, so it falls through to ambient
  `process.env` — breaking the convention every other `safeExecute` in `gate.ts` follows
  (`:49, :54, :70, :109`). Consequence: `TOFFOLI_EXECUTE_DISABLED=1 npm run gate` FAILS
  with *"a world that changed nothing was accepted"* — the repo's own advertised safety
  switch accuses the code of fabrication.
  - Acceptance: `TOFFOLI_EXECUTE_DISABLED=1 npm run gate` passes, or fails with a message
    that names the kill-switch as the cause.
  - Verify: run the gate with and without that variable exported.
  - Files: `lib/exec/fs-recover.ts`, possibly `lib/gate-mutate.ts` (strip it from the
    child env as it already strips `TOFFOLI_MIN_RECALL`).
  - Depends on: none. **Do this before anyone else hits it.**

- [x] **Task 4 — Gate `fsReal.irreversibleUntouched` (D8). DONE 2026-08-02.** `XS`
  It is computed at `fs-recover.ts:136` and printed, but `gate.ts:183` gates only the
  **in-memory** world's restraint. A real adapter that clobbered the dropped table or the
  outbox passes — which is exactly what `8897b1f`'s reused ids did to `outbox/op6.txt`.
  - Acceptance: a 21st check gates `fsReal.irreversibleUntouched`.
  - Verify: mutate `FsWorld` to touch the outbox during compensation; gate must fail.
  - Files: `lib/gate.ts`.
  - Depends on: none.

### Checkpoint B
- [ ] Gate is 22 checks, all green on clean HEAD, each verified by a reintroduced defect.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Task 2 changes what "idempotent" means and breaks the honest path | Med | `restored=4` on honest replay is expected (`once()` maps already-applied → true). Decide the discriminator explicitly before coding. |
| Adding checks slows the gate further | Low | Already ~1s. Not a constraint. |
| Fixing D2 makes the detector brittle to legitimate `FsWorld` changes | Low | Assert dimensions, not implementation. A new dimension should force a deliberate update. |

## Explicitly out of scope

- **`gate-mutate.ts` has zero mutations touching `fs-recover`/`fs-world`/`fs-journal`
  (D3).** Real, and the reason Tasks 1–4 must each be verified by hand. Adding them is
  its own task and belongs after this phase, not inside it.
- **`SqlWorld` is not in the gate at all (D7).** It had the identical id-allocation
  defect (`422b37d`). Bringing it in is a larger piece of work than any task here and
  needs its own decision — it is the second instance of the same bug class, uncovered.

## Open questions

- Should `SqlWorld` join the gate, or is the FsWorld cycle a sufficient proxy for the
  class? The two adapters share the defect but not the code. **Needs a human call.**
