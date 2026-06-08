# Toffoli — Threat & Failure-Mode Mapping

Two crosswalks, so a security or platform reviewer can place Toffoli in frameworks they already use.

> **These are crosswalks Toffoli maps *to* — not standards it conforms to or is measured against.**
> Toffoli's design and its "no-under-call" soundness are defined on their own terms (`THEORY.md`); the
> tables below only translate its capabilities into others' vocabulary. Category titles are quoted from
> the primary sources; verify against those sources before reusing, as taxonomies are revised.

## 1 · OWASP Top 10 for Agentic Applications (2026)

OWASP published the *Top 10 for Agentic Applications (2026 edition)* (categories `ASI01`–`ASI10`).
Toffoli is a *recovery* layer, so it most directly addresses the categories about destructive/abused
tool actions and their blast radius:

| OWASP category | Title (per OWASP) | How Toffoli addresses it |
|---|---|---|
| **ASI02** | Tool Misuse | Classifies every tool action by reversibility; plans/executes restitution for the recoverable ones and escalates the irreversible remainder — the cleanup half of a misused tool call. |
| **ASI05** | Unexpected Code Execution | Arbitrary `execute` actions are the residual the rules abstain on → routed to the gated judge or fail-safe-escalated; never silently treated as recoverable. |
| **ASI08** | Cascading Failures | The dependency-DAG planner orders undo reverse-topologically and flags compensations *dominated* by a downstream irreversible action — directly limiting cascade during recovery. |
| **ASI03** | Identity & Privilege Abuse | The recovery-context signals (`recoverable`, `externalized`, …) are SAFE-direction; the attestation layer (`attest.ts`) requires a trusted-instrument signature, so an over-privileged or impersonating agent can't forge "it's recoverable." |

(Toffoli also touches a couple of further categories partially; consult the live OWASP list for the
full `ASI01–ASI10` titles before asserting those.)

Source: the OWASP *Top 10 for Agentic Applications (2026)* page — cite the OWASP project page directly,
not third-party blog restatements (some circulate embellished titles).

## 2 · Agent failure-mode taxonomies (AgentRx / TRAIL)

Toffoli's classes also crosswalk to recent agent *failure* taxonomies, which catalog *why* trajectories
fail. The primary, dataset-backed sources:

- **AgentRx** — Microsoft Research, arXiv:2602.02475 (a root-cause taxonomy with annotated failed
  trajectories).
- **TRAIL** — Patronus AI, arXiv:2505.08638 (an established trajectory-failure eval with a dataset).

| AgentRx root-cause (examples) | Toffoli's relationship |
|---|---|
| Plan-adherence failures | Out of Toffoli's scope to *prevent*; in scope to *recover from* — it cleans up the side effects a derailed plan produced. |
| Tool-output misinterpretation | Often produces a wrong but recoverable action; Toffoli's classifier + restitution handle the cleanup, and the attestation prevents trusting the agent's own "it's fine." |
| Guardrail failures | Toffoli is a *post-hoc* guardrail-complement: it catches and reverses what a pre-act guardrail missed, escalating the irreversible remainder. |

> **Guardrail (important):** Toffoli's taxonomy and soundness are **not** anchored to any external
> nine-category scheme, and it is not benchmarked against one. The crosswalk is positioning literacy,
> not conformance — anchoring a safety property to a third-party taxonomy would make it brittle.
