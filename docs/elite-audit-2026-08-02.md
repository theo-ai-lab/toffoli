# Ship-gate ledger — toffoli, 2026-08-02

Branch: `hardening/gate-falsification-and-mcp-fixes`. Two verdicts, reported
separately and never merged.

## Scores

| # | Principle | Score | Evidence |
|---|---|---|---|
| P12 | Testing | **4** | 391 tests across 38 files, green from a cold clone; typecheck and lint clean. `npm run gate` emits 21 checks; `npm run gate:mutate` kills 7/7 seeded mutants. |
| P13 | CI/CD | **3** | Lint, typecheck, tests, gate and mutation gate. **Evidence is the PR run.** |
| P14 | Observability | **3** | Journalled compensation with per-step outcomes; the world-truth checks distinguish reported from applied. |
| P15 | Security fundamentals | **3** | Confirm-token and kill-switch defaults reviewed; auto-execute policy is opt-in. Recorded as open from external review: the confirm token proves possession of a shared secret, not the identity of an approver, so "human-approved" is weaker than it reads. |
| P19 | Infrastructure | **3** | Node/TS, MCP server surface, in-memory and sqlite worlds. |
| P24 | Measurable success criteria | **3** | Promoted-precision figures are reported with a confidence interval. Scored 3 not 4: external review is right that the interval is narrower than the labelling method supports. |
| P32 | Graders | **4** | The falsification harness is the grader, and it is adversarial by construction — `gate:mutate` requires each seeded defect to be caught by a named seam, so a gate that passes everything fails the meta-gate. |
| P36 | Onboarding / accurate mental models | **3** | External adversarial review by an independent frontier model from a different vendor. Its central presentational finding — that the top-fold "self-healing agent" evidence is a scripted scenario rather than an observed recovery — is fair and recorded as open. |

## Known gaps, carried deliberately

These were identified before this gate ran and are documented in
`docs/PLAN_gate-hardening.md`, which ships publicly on purpose:

- `gate-mutate.ts` contains no mutations touching `fs-recover.ts`, `fs-world.ts`
  or `fs-journal.ts`, so the world-truth checks are not covered by the
  falsification harness that covers everything else.
- **`SqlWorld` is not in the gate at all**, and it carried the identical
  id-allocation defect that motivated the world-truth work. The `FsWorld` cycle
  is currently the proxy for that class; that is a choice, not a proof.

Shipping a document that names your own gate's blind spots is the intended
signal. It is only a senior signal if the gaps are real and still open, which
they are.

## Verdict 1 — Build Quality

**Strong, with a gate that is honest about what it does not cover.** The
world-truth work is the substance: a compensation that is *reported* and
*journalled* but never *applied* used to pass, and now the gate distinguishes
those states and re-checks after a second damage→recover cycle. The idempotence
check requires a clean replay before it will call a replay idempotent, which is
the difference between checking a property and assuming it.

The weakness is coverage asymmetry: the strongest verification tool in the repo
is not pointed at the newest and most delicate code.

## Verdict 2 — External Adoption / Production Validation

**Unproven. No external users.** Everything is exercised against worlds this
repo defines. No third party has wired the MCP surface to a real agent, and no
undo has been performed against a production system.
