# Ship-gate ledger — toffoli, 2026-08-18 (incremental)

Branch: `fix/supply-chain-audit-2026-08-18`. Two verdicts, reported separately and
never merged. This is an **incremental re-audit** on top of `elite-audit-2026-08-02.md`
(which certified the tree that became `main` at the hardening merge). The only delta
since that ledger is one lockfile-only commit: `nanoid` 3.3.16 → 3.3.18 and `hono`
4.12.33 → 4.13.1, clearing `npm audit --audit-level=high` (the `supply-chain` CI job,
red on `main` since 2026-08-16 on advisories that appeared against the vetted lockfile —
no code change caused it). Every ⛔ row below was re-verified **today** by a deterministic
checker on the new tree; unchanged rows carry their 2026-08-02 evidence explicitly.

## Scores

| # | Principle | Score | Delta since 08-02 | Deterministic verification (2026-08-18, this tree) | Independent / external review | Remaining limitation |
|---|---|---|---|---|---|---|
| P12 | Testing | **4** | none in code; suite grew 391→396 at the hardening merge | Fresh clone → `npm ci --ignore-scripts` (npm 11.19.0) → `tsc` → **396/396 tests, 39 files** green; `npm run gate` **21/21**; `npm run gate:mutate` **7/7 seeded mutants caught** | Deterministic (suite + mutation gate). External model (an independent frontier model from a different vendor, run 08-18 and told to refute) confirmed the installed dependency graph is unchanged by the lockfile diff | Mutation coverage still excludes `fs-recover/fs-world/fs-journal` (carried gap, documented) |
| P13 | CI/CD | **3** | `supply-chain` job red on `main` since 08-16; this change is the fix | Local reproduction of every job step: `npm ci --ignore-scripts` on npm 11.19.0 **and** 11.6.2 dry-run, typecheck, lint, `test:coverage` (floors hold), `eval`, `npm audit --audit-level=high` → **0 vulnerabilities** | **Evidence is the PR run on this branch** (pending at write time per the ordering rule; the merge does not proceed unless every job is green) | Lean proof-gate step runs only in CI (elan/lake); not re-run locally |
| P14 | Observability | **3** | none | n/a — no delta | 08-02 evidence carries | as 08-02 |
| P15 | Security fundamentals | **3** | **improved**: audit high+ 2→0; cooldown honored | `npm audit --audit-level=high` → 0; both picks published 2026-08-07 (≥ `min-release-age=7`; hono 4.13.2/4.13.3 correctly excluded — regenerated with npm 11.19.0, which enforces the cooldown; local 11.6.2 does not); `scripts/tripwire.sh` **CLEAN (170 tracked files)**, re-run on the tree including this ledger | Independent frontier model from a different vendor, told to refute, **CONFIRMED 5/5**: lockfile-only; only two version changes, both in-range (`postcss` ^3.3.16, `@modelcontextprotocol/sdk` ^4.11.4); graph unchanged for `npm ci`; cooldown honored; no `resolved`/`integrity` lost. Verdict "patch is correct" 0.93 | 08-02 open point stands: confirm token proves possession of a shared secret, not approver identity |
| P19 | Infrastructure | **3** | none | Fresh clone → install → test green on the branch (see P12) | Deterministic | as 08-02 |
| P24 | Measurable success criteria | **3** | none | `npm run eval` reproduces the headline (IRREVERSIBLE recall 0.83, bootstrap 95% CI 0.72–0.92, n=53) | 08-02 external review carries | interval narrower than the labelling method supports (carried) |
| P32 | Graders | **4** | none | `gate:mutate` re-run today: 7/7 | Deterministic (adversarial-by-construction meta-gate) | as 08-02 |
| P36 | Onboarding / accurate mental models | **3** | none (no README/UI/demo change) | n/a — no delta | 08-02 external adversarial review carries | top-fold "self-healing" evidence is a scripted scenario (carried, open) |

## Ship-gate checklist — status on this ship set

- Fresh clone → install → test → green: **done** (P12/P19 row).
- CI green on the exact ship set: **pending — the PR run is the evidence**; merge blocked until green.
- Lockfile regenerated with a cooldown-aware npm + dual-npm `npm ci`: **done** (11.19.0 real install, 11.6.2 dry-run).
- Actions pinned to current majors (`checkout@v6`, `setup-node@v6`): unchanged since 08-02.
- Tripwire clean on the full ship set: **done**, re-run after this file was added.
- History / identity / keys: no delta; nothing pasted; commit message scanned clean by the pre-push hook's own regexes.
- Design review / README claims / demo: no delta — 08-02 evidence carries; Pages demo probed UP by the daily liveness probe (2026-08-17 12:00 PDT, 7/7).
- Deploy parity: Pages redeploys from `main` on merge (the `pages` job); rollback = revert the single commit.

## Verdict 1 — Build Quality

**Ship-clear** for this delta: every ⛔ ≥3 with linked evidence, re-verified today, on the
condition stated in P13 (the PR's CI run must be green — the ordering rule means it runs
after this ledger exists). Nothing else changed; the 08-02 verdict's substance and its
honestly-carried gaps (mutation blind spots on the fs-* modules; `SqlWorld` outside the
gate) are unchanged and still open.

## Verdict 2 — External Adoption / Production Validation

**Unproven. No external users** — unchanged. 0 stars / 0 forks / 0 external issues or PRs
on the public repo as of 2026-08-18; no third party has wired the MCP surface to a real
agent; no undo performed against a production system.
