# FsJournal + chaos interleavings — vertical slice plan

Date: 2026-08-01
Branch: `elite/gate-falsification-and-mcp-fixes`
Scope: ONE vertical slice. Not the whole durability story.

## 0. Defect verification (done BEFORE any design)

The two defects below came from a planning pass. Both were re-verified by
execution against this tree at `4599c15` before a line of code was written.

### Defect 1 — silent lost compensation (CONFIRMED)

`FsWorld.once()` (lib/exec/fs-world.ts) writes the idempotency marker BEFORE the
side effect. Its own comment concedes the window. Verified with a *real* crash:
`ledger.json` was replaced by a FIFO so `readLedger()` parks in `open(2)` — a
kernel-enforced block, not a timing race — the marker was observed on disk, the
child was `SIGKILL`ed in that window, and the replay was run from a fresh
process.

```
refund() returned    = true
ledger after replay  = 50
```

The replay reports **success** for a refund that never happened. The executor
records the step as `restored`. That is a fabricated success — precisely the
failure mode the rest of this repo is built to prevent.

### Defect 2 — TOCTOU in `once()` (CONFIRMED, and far more reachable than "rare")

`existsSync(marker)` then `writeFileSync(marker, "")` is a check-then-use. Twelve
processes sharing one root and one idempotency key, released together off a
spin barrier:

```
RESULT: 12 / 15 trials violated exactly-once (N=12 racers each)
```

Ledgers landed on 900, 850, even 800 where 950 was correct — i.e. up to **four
duplicate refunds** against a design whose stated rule is "never refund twice".

### Defect 3 — found by the harness, not predicted (see §4)

Two further faults surfaced during the defect-2 probe. Both are recorded in §4
and only one is in scope for this slice.

## 1. Goal

A compensation must never be *silently* lost and never *silently* double-applied.
Land `FsJournal`: a durable write-ahead record whose claim is atomic against
concurrent callers, and which turns an unresolved crash window into a loud,
typed outcome instead of a fabricated `true`.

Non-goal for this slice: leases/fencing tokens, multi-key transactions, a
crash-safe ledger with per-writer isolation, or porting the in-memory `World`.

## 2. Architecture

### The seam contract (typed, one error shape, validated at the boundary)

`lib/exec/fs-journal.ts` owns the whole claim→effect→resolve cycle so every
crash point lives in one place.

```
runOnce(intent: OnceIntent, effect: () => boolean): OnceOutcome
```

- `OnceIntent` = `{ key, method, replaySafe }`, validated at the boundary.
- `replaySafe` is the caller's declaration that re-running the effect after an
  unresolved crash is harmless (true for `deleteFile`/`restoreRow`, false for
  `refund`). This is what lets recovery REDO an idempotent inverse while
  refusing to silently redo money.
- `OnceOutcome` is a discriminated union: `applied` | `noop` | `already-applied`.
- Everything that cannot be expressed as an outcome raises `JournalError`, one
  error shape with a `code` union (`invalid-intent` | `indeterminate` |
  `corrupt-record` | `io`).

Backward compatibility: `RecoveryWorld`'s `boolean` inverses are unchanged. An
`indeterminate` record throws, and `dispatchInverse` already maps a throw to
`status: "failed"` with the raw error — so an unresolved compensation becomes a
failed step and a saga resume point instead of a fake restoration. No caller
changes, no signature changes.

### Atomicity

The claim is `writeFileSync(path, rec, { flag: "wx" })` — one exclusive-create
syscall. There is no window between check and use because there is no check.
`EEXIST` is the loser's signal, and the loser reads the winner's record.

Ownership is tracked per instance: a claim may only be released by the caller
that acquired it (defect 3a).

### The chaos seam

`ChaosSchedule` is an optional constructor option; production passes nothing and
pays nothing. It exposes four labelled points — `before-claim`, `after-claim`,
`before-resolve`, `after-resolve` — which is the complete kill-point space of
the cycle. Two deterministic schedules:

- `crashAt(point)` — throws `SimulatedCrash` at that point.
- `interleaveAt(point, action)` — runs `action` in that window, modelling a
  second process landing there. This is what makes the TOCTOU reproducible
  without a race.

Both are seedless because both are exhaustive, which is stronger: the tests
enumerate the entire kill-point space rather than sampling it.

## 3. TDD tasks (bite-sized, each RED first)

1. `JournalError` + intent validation at the boundary. RED on an empty key.
2. `runOnce` happy path: `applied`, then `already-applied` on replay.
3. `noop` releases the claim so a later legitimate attempt can run.
4. Crash-point property: for EVERY point in the kill-point space × replaySafe
   ∈ {true,false}, re-opening the journal never reports success for an effect
   that did not happen. (Property over a generated space, not examples.)
5. TOCTOU: `interleaveAt("before-claim", …)` where a second journal instance on
   the same root claims and applies the key. Exactly-once must hold.
6. Ownership: a losing caller's `abandon` must not delete the winner's record.
7. Wire `FsWorld.once` to `FsJournal`; existing fs-world tests stay green.
8. Fix the shared `ledger.json.tmp` path (defect 3b).

## 4. Defects found by the harness

- **3a. Cross-caller claim release.** `once()` does `rmSync(marker, {force:true})`
  on a failed/no-op attempt without checking ownership. In trial 11 of the race
  probe the marker count ended at **0** after a successful refund: a losing
  racer's failure erased the winner's idempotency record, so a later replay
  would refund again. IN SCOPE — fixed by per-instance claim ownership.
- **3b. Shared temp path in the "atomic" ledger write.** `writeLedger` uses one
  fixed `ledger.json.tmp` for every writer, so concurrent writers clobber each
  other's temp file and `renameSync` dies with `ENOENT`. The "atomic replace —
  no torn ledger" comment is only true for a single writer. IN SCOPE — unique
  temp name per write.
- **3c. Lost-update on the ledger itself.** `writeLedger(readLedger() - amt)` is
  a read-modify-write with no locking. Once two callers legitimately act on
  DIFFERENT keys concurrently they can still lose an update. OUT OF SCOPE for
  this slice — the journal fixes exactly-once per key, not ledger serialisability.
  Recorded here so no doc claims more than the code does.

## 5. Verification set

`npm test`, `npm run typecheck`, `npm run gate` (must stay 16/16),
`npm run gate:mutate` (must stay 0 survivors), plus mutation-verify on the new
tests: revert the atomic claim to check-then-write and confirm the deterministic
TOCTOU test goes RED.
