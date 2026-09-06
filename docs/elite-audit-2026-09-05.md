# Ship-gate ledger — toffoli, 2026-09-05 (incremental)

Branch: `fix/supply-chain-audit-2026-08-18`. Two verdicts, reported separately and never
merged. This is an **incremental re-audit** on top of `elite-audit-2026-08-18.md` (which
certified the previous lockfile-only bump) and, through it, `elite-audit-2026-08-02.md`
(which certified the tree that became `main`). The only delta since the 08-18 ledger is
two lockfile-only commits:

- `9d5951f` — `fast-uri` 3.1.5 → 3.1.6, clearing a **high** advisory.
- `a490005` — `qs` 6.15.3 → 6.16.0, clearing the remaining **moderate** advisory once the
  seven-day package-age policy allowed it.

Both were produced by the scheduled trusted maintenance step, not by hand. Every ⛔ row
below was re-verified **today** on a fresh clone of `a490005`; unchanged rows carry their
08-18 / 08-02 evidence explicitly and say so. Scores are unchanged from 08-18 — a
dependency bump is not grounds to inflate them.

## What was actually run today (fresh clone of HEAD, npm 11.19.1)

| Step | Result |
|---|---|
| `git clone` → `npm ci --ignore-scripts` | clean install, 255 resolved packages |
| `npm run typecheck` · `npm run lint` | pass |
| `npm run test:coverage` | **396/396 tests, 39 files**; statements 76.12% (2720/3573) |
| `npm run eval` | IRREVERSIBLE recall **0.83**, bootstrap 95% CI 0.72–0.92, n=53, 2000 resamples; catastrophic misses **0** |
| `npm run gate` | **21/21** checks, GATE PASSED (incl. Lean kernel-check, no `sorry`) |
| `npm run gate:mutate` | **7/7** seeded mutants caught, FALSIFICATION PASSED |
| `npm run build` · `npm test` | pass; 396/396 |
| `npm audit` and `--audit-level=high` | **0 vulnerabilities at every severity** |
| `npm audit signatures` | **181** verified registry signatures, **55** verified attestations |
| `scripts/tripwire.sh` (build-standards) | **CLEAN (171 tracked files)** |
| dual-npm `npm ci --dry-run` | pass on npm 11.19.1 **and** local 11.6.2 |

## Package-age policy: enforcement proven, not assumed

npm prints `npm warn Unknown project config "min-release-age"`, so the 08-18 ledger's claim
that the cooldown is enforced deserved a real test rather than a citation. A controlled
full re-resolution (lockfile deleted, resolved from scratch, scratch copy only) settles it:

| Run | fast-uri resolved |
|---|---|
| cooldown active (`.npmrc min-release-age=7`) | **3.1.6** — the committed pin |
| cooldown disabled (`NPM_CONFIG_MIN_RELEASE_AGE=0`, exactly CI's setting) | **3.1.7** |

`fast-uri` 3.1.7 was published 2026-09-02 and is 3.77 days old, inside the window. The
cooldown is therefore genuinely enforced at lockfile-generation time despite the warning,
and the committed lockfile is exactly what a cooldown-aware resolution produces. `qs`
6.16.0 is 7.24 days old, just past the bar, which is why it could only land now.

An earlier weaker check — that `npm install --package-lock-only` is a no-op — was
**discarded** from this ledger: that command does not re-resolve in-range dependencies, so
it proved only internal consistency, not that the cooldown chose the version.

The external reviewer raised `NPM_CONFIG_MIN_RELEASE_AGE: "0"` in the three workflows as a
⛔ risk. On inspection it is deliberate and documented in `recovery-gate.yml:12-18`: the
cooldown guards *fresh installs*, while CI runs a reproducible `npm ci` of the
already-vetted lockfile, where the cooldown adds no security and would flake the build for
a week after any bump. That reasoning holds, and the experiment above shows the control is
enforced where it actually matters. No change made.

## Scores

| # | Principle | Score | Delta since 08-18 | Deterministic / mathematical verification (today, this tree) | Behavioural / experimental | External validation | Remaining limitation |
|---|---|---|---|---|---|---|---|
| P12 | Testing ⛔ | **4** | none | Fresh clone → `npm ci` → **396/396 tests, 39 files**; `gate` 21/21; `gate:mutate` **7/7 mutants caught** | Coverage 76.12% statements measured on the same run | External model inspected `lib/gate-mutate.ts:187-243` and confirmed it applies real single-point mutants to source in a scratch copy and fails on survivors — "not a mere mirror" | Mutation coverage still excludes `fs-recover` / `fs-world` / `fs-journal` (`docs/PLAN_gate-hardening.md:93-98`) and `SqlWorld` (`lib/gate.ts:88`) — carried gap, re-confirmed today by the external reviewer |
| P13 | CI/CD ⛔ | **3** | advisories that were red are now zero | Every CI job reproduced locally on the fresh clone: install, typecheck, lint, `test:coverage`, `eval`, `gate`, `gate:mutate`, `build`, `test`, `npm audit --audit-level=high`, `npm audit signatures`. Actions pinned to current majors (`checkout@v6`, `setup-node@v6`, `configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`) | dual-npm `npm ci --dry-run` on 11.19.1 and 11.6.2 | **Evidence is the PR run on the pushed head** — per the ordering rule it runs after this ledger exists; the five required checks are green on `089aa0c` only | The Lean proof step (`lake build`) runs in CI's `gate` job; reproduced here via `npm run gate`, which kernel-checks it locally |
| P14 | Observability ⛔ | **3** | none | n/a — no delta in code | Pages demo probed today as a cold visitor: HTTP 200, 4304 bytes of real content, **zero** login/sign-in/password markers, 0.09 s | 08-02 evidence carries (journalled compensation, per-step outcomes, world-truth checks separating reported from applied) | As 08-02. The daily liveness probe covers the demo surface, not the library's runtime behaviour in anyone else's system |
| P15 | Security fundamentals ⛔ | **3** | **improved**: high 1 → 0, moderate 1 → 0 | `npm audit` **0 at every severity**; `npm audit signatures` 181 signatures + 55 attestations; `tripwire.sh` **CLEAN (171 files)**; cooldown enforcement proven by the controlled experiment above | Full re-resolution reproduces the committed lockfile exactly under the cooldown | External model verified the outgoing diff is lockfile-only and touches exactly two packages' version/resolved/integrity fields, both `"dev": true`, nothing else moved — VERIFIED | Confirm-token design still proves possession of a shared secret, not approver identity (carried from 08-02) |
| P19 | Infrastructure ⛔ | **3** | none | Fresh clone → install → test → **green, logged** (table above); reproducible from the committed lockfile on two npm versions | Build and pack succeed on the same clone | Deterministic | As 08-02 |
| P24 | Measurable success criteria ⛔ | **3** | none | `npm run eval` reproduces the headline: IRREVERSIBLE recall **0.83**, bootstrap 95% CI 0.72–0.92, n=53, 2000 resamples, **0** catastrophic misses and 0 committed missed-escalations | Same run reports the hand-labelled set separately from the at-scale synthetic set | 08-02 external review carries | The eval's own output says it plainly: fixture accuracy under a controlled distribution, **not** real-world prevalence. Real numbers need real traces — still pending, no external users |
| P32 | Graders ⛔ | **4** | none | `gate:mutate` re-run today: **7/7**; `gate` 21/21 | The mutation gate is adversarial by construction — it fails if any seeded mutant survives | External model read the harness and confirmed it is genuine, and independently demonstrated the two coverage blind spots rather than taking them on trust | The blind spots above are real and unclosed |
| P36 | Onboarding / mental models ⛔ | **3** | none (no README, UI or demo change in this delta) | n/a — taste is not machine-checkable | Demo reachable and on-message with the README | **External model, told to refute** (required path for taste): first sentence states user value plainly; demo aligned with README. It flagged one overreaching sentence — README:8-10, "automatically puts back what can be put back and escalates only what truly can't" — as stronger than what is proven across every adapter | Two open findings, both carried and **not** fixed here: the 08-02 finding that the top-fold evidence is a scripted scenario rather than an observed recovery, and today's overreaching sentence. Neither is in scope for a lockfile PR; fixing prose here would be a documentation-only change to a supply-chain commit |

## Ship-gate checklist — status on this ship set

- Fresh clone → install → test → green, logged: **done** (table above).
- CI green on the exact ship set: **pending — the PR run on the pushed head is the evidence.** The five required checks (`gate (22)`, `gate (24)`, `macos-smoke`, `pack-smoke`, `supply-chain`) are green on `089aa0c`; the ordering rule means they re-run once this ledger is committed and pushed. The merge does not proceed unless they are green.
- Lockfile regenerated with a cooldown-aware npm + dual-npm `npm ci`: **done**, and the cooldown's effect is demonstrated rather than asserted.
- Actions pinned to current majors: **verified today**, unchanged since 08-02.
- Tripwire clean on the full ship set: **done**, and re-run after this file was added.
- History / identity / keys: no delta. Nothing pasted; both outgoing commits carry `Signed-off-by`.
- Design review / README claims / demo: no delta in this set; external model reviewed the top fold today and its finding is recorded above as open.
- Deploy parity: the `pages` job redeploys `design/` from `main` on merge; this delta touches **0** files under `design/`, so the published demo is unaffected.
- Rollback: revert the two lockfile commits; `089aa0c` is the restore point and is the current remote head.
- iCloud paths: not applicable — the ship set lives under `~/Code`, not `~/Desktop` or `~/Documents`.

## Verdict 1 — Build Quality

**Ship-clear for this delta, conditional on the CI re-run.** Every ⛔ principle scores ≥3
with linked evidence re-verified today on a fresh clone, and the one gate that cannot be
satisfied before the push — CI on the pushed head — is stated as pending rather than
claimed. Nothing outside the lockfile changed, and the honestly-carried gaps from 08-02 and
08-18 (mutation blind spots on the `fs-*` modules and `SqlWorld`; the confirm-token identity
limitation; the scripted top-fold scenario) are unchanged and still open.

The external reviewer's overall verdict was "refuted" for ship-clear, on two grounds: that
CI had not re-run on this head, and that the cooldown was not enforced. The first is
correct and is why this verdict is explicitly conditional. The second is answered by the
controlled experiment above, which the reviewer could not run — its sandbox had no registry
access.

## Verdict 2 — External Adoption / Production Validation

**Unproven. No external users** — unchanged, and checked again today against the live
repository: **0 stars, 0 forks, 0 watchers, 0 external issues**, one contributor
(`theo-ai-lab`), and the only open pull request is this one. No third party has wired the
MCP surface to a real agent, and no undo has been performed against anyone else's
production system. Build quality above does not substitute for this, and this does not
lower the verdict above.

## Foundations

No F1–F15 trigger is newly matched by a lockfile-only dependency bump; activation is
unchanged from 08-02 and nothing here is scored against a foundation.
