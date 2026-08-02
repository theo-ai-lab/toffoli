# Security review — the world-truth gate changeset

**Range:** `b03db3c^..d96e314` (3 commits) · **Date:** 2026-08-02

Small changeset (6 files), so every changed file and its direct dependencies were read rather
than sampled.

## Triage

| File | Δ | Risk | Why |
|---|---|---|---|
| `lib/gate.ts` | +44 | **HIGH** | It is the release criterion. A change here changes what "shippable" means. |
| `lib/exec/fs-recover.ts` | +21 | **HIGH** | Drives the world comparison the gate now depends on; gains a seam that can substitute the world. |
| `lib/exec/fs-recover.gate.test.ts` | +66 | LOW | Tests. |
| `lib/runtime/resilience.test.ts` | +171 | LOW | Tests. |
| `README.md`, `docs/decisions/ADR-001` | +101 | LOW | Documentation. |

No dependency added.

## Was any security check removed?

No. The only non-comment deletions are `fsRecoveryScenario`'s signature and the two
`new FsWorld(root)` constructions, each replaced by `makeWorld(root)` with `FsWorld` as the
default. `git blame` shows none of the removed lines originate from a security or fix commit.

The changeset is strictly additive to the gate: 16 checks → 19, none removed or weakened.

## Test coverage

The three new gate checks are covered by `fs-recover.gate.test.ts` (honest run + lying-world
detector) and, more importantly, by `npm run gate:mutate`, which reports them among the catchers
for `classifier-forced-to-irreversible` — so they are load-bearing rather than decorative.

`resilience.test.ts` adds 17 tests to a module that had **no dedicated test file at all**, pinning
every circuit-breaker transition with an injected clock.

## Blast radius

5 call sites, all in-repo: `gate.ts:85`, `gate.ts:106`, `fs-world.test.ts:58`,
`fs-recover.ts:165` (CLI), `fs-recover.gate.test.ts`. `makeWorld` is optional, so the pre-existing
caller at `fs-world.test.ts:58` compiles and passes unchanged. Low radius, source-compatible.

## Threat model

Threat model here is not a network attacker — it is **a future edit that makes the gate stop being
able to fail**, which is the failure this changeset exists to prevent.

**MEDIUM — the `makeWorld` seam is the one way to turn the world check into a tautology.**
`fs-recover.ts:64` now accepts a world factory. That is what makes the negative control possible,
and it is also the only affordance that could disable the check: a future edit passing a permissive
world to the *honest* call at `gate.ts:85` would make
`the REAL on-disk world returns to baseline` pass without the world ever being consulted.

Mitigating factors, stated rather than assumed:
- `gate.ts:85` calls `fsRecoveryScenario()` with **no arguments**, so the default `FsWorld` applies.
- The WORLD-TRUTH DETECTOR at `gate.ts:106` would still fail if the comparison degenerated, because
  it asserts `!recoverableRestored` on a world that changes nothing — a tautological comparison
  returns `recoverableRestored: true` there and fails the check.
- So the detector guards the seam it introduced. That is the correct shape, and it is why the
  detector is not optional.

**Residual:** nothing in CI asserts that `gate.ts:85` is called without a `makeWorld` override. A
reviewer would catch it; a static check would be cheaper. Recorded, not fixed.

**LOW — `fsRecoveryScenario` writes to a real temp dir and `gate.ts:106` removes it in a `finally`.**
A crash between `mkdtempSync` and the `finally` leaks a temp directory. Cosmetic; no security impact.

## Coverage limits (stated honestly)

- This review covers the **gate** path. `fabricationCheck` itself is unchanged and its limitation
  (executor vs its own journal) is documented in ADR-001, not fixed — by design, since it is a real
  check against a real failure mode, just not a world check.
- Coverage floors are green but thin: statements 76.14 vs a floor of 76. A single untested module
  flips CI red. Not a security finding; an availability one for the gate itself.
- This review covers the changeset above only. Further findings against the same checks are tracked
  in `docs/PLAN_gate-hardening.md`.

## Verdict

**No HIGH-severity finding.** One MEDIUM design observation (the `makeWorld` seam), already guarded
by the detector introduced alongside it. Confidence **high** — the checks were executed, and
`gate:mutate` independently confirms they are load-bearing.
