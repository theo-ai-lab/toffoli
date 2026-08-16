# Toffoli — Safety Model (controls, and where each one comes from)

Toffoli is designed to run as an agent-called service that can be asked to *act on real systems* to
undo what an AI agent did. That makes it a high-consequence component, so its safety is engineered, not
assumed.
This document crosswalks each control to the primary source it derives from, and is held to the
project's honesty bar: where a popular framing is wrong, the correct one is given, and adaptations are
labeled as ours. Every control here is **implemented and tested** (`lib/runtime/*`,
`lib/runtime/safe-runtime.test.ts`, the `npm run gate` checks) — this is not aspirational.

## The one-line model

> **Plan-only by default. The deterministic engine sets the ceiling on autonomy; a confirm token or a
> bounded policy can lower it to "execute," never raise it. Every mutation passes one enforced
> chokepoint, is written ahead to a durable journal, and is reported succeeded only if that journal
> confirms it. Everything the machine can't safely undo is escalated to a human — durably, never as a
> silent drop.**

## Controls → sources

| # | Control (where) | What it guarantees | Primary source |
|---|---|---|---|
| 1 | **Plan-only by default + plan-bound confirm token** (`runtime/safe-executor.ts`) | The default emits a signed plan and mutates **nothing**; execution requires a token hash-bound to *this exact plan* (a human approved it) or an explicit bounded `autoConfirm`. | Replit post-incident "planning-only mode" remediation (Replit/Fortune, 2025-07); agent-rollback guidance 2026. |
| 2 | **Enforced kill-switch + `mode: dry-run\|sandbox\|execute`** (`runtime/mode.ts`) | One chokepoint decides whether the world may be mutated; `TOFFOLI_EXECUTE_DISABLED` forces `dry-run` regardless of the request. **Verified in CI** (`npm run gate`). | Replit incident (July 2025): an agent deleted a production DB *during an explicit freeze* — an unenforced freeze is worthless (Fortune 2025-07-23; incidentdatabase.ai/cite/1152). |
| 3 | **Anti-fabrication invariant** (`runtime/journal.ts` `confirms()`, surfaced in every `RuntimeReport`, gated in CI) | No action is **reported** succeeded unless the durable journal recorded it done. Defeats the "agent fabricates success output" failure mode directly. | Replit incident: the agent **fabricated success output** that delayed detection. |
| 4 | **Write-ahead step journal / transactional outbox** (`runtime/journal.ts`) | Intent is recorded **before** the side effect, done/failed **after**; on crash, `pending()` replays idempotently (redo, never undo). Kills the dual-write that would silently break the audit log. | AWS Prescriptive Guidance, *Transactional outbox*; WAL / Compensation-Log-Record discipline. |
| 5 | **Idempotent inverses + per-step idempotency key** (`exec/world.ts` `once()`, key derived from the plan step) | A retrying caller never double-compensates; a double-executed "compensating" action is itself a new irreversible harm. First outcome (success **and** failure) is the source of truth. | Stripe idempotency model (docs.stripe.com/api/idempotent_requests); Temporal idempotency-and-durable-execution. |
| 6 | **COMPENSATION-FAILED runtime state + durable escalation** (`runtime/escalation.ts`, `safe-executor.ts`) | "Attempted an undo and couldn't" is a first-class runtime state routed to a durable sink + webhook — never a silent drop (the saga "zombie record" trap). | Saga-pattern failure analyses (coldfusion-example 2026-01; oneuptime 2026-03-31). |
| 7 | **Bounded, transient-only retry** (`runtime/resilience.ts`) | Retries **only** transient faults (locks, 408/429/503, transient network) — never permission/validation — with capped exponential backoff + full jitter, single layer, optional token budget. | AWS Builders' Library, *Timeouts, retries, and backoff with jitter* (3 retries × 5 layers = 243× load). |
| 8 | **Per-backend circuit breakers** (`runtime/resilience.ts`) | A wedged dependency (payment/DB/FS) is taken out of rotation (OPEN→half-open→closed) so one failing backend degrades, never wedges the whole recovery. | Standard circuit-breaker pattern; fail-closed orientation (cordum.io AI-agent circuit breaker, 2026-06). |
| 9 | **Two-axis auto-execute policy: class × confidence + default-deny allowlist** (`runtime/policy.ts`) | Auto-execution gated on reversibility class **and** confidence **and** a default-deny method allowlist; a high-confidence-but-wrong answer can't slip through on class alone. | Adapted from Prophet Security's two-axis remediation grid. **Correction:** Prophet's published axes are **Blast-Radius × Detection-Confidence**; mapping blast-radius onto reversibility class is **our** adaptation, not Prophet's labeling. |
| 10 | **Judge can only lower autonomy** (`runtime/policy.ts`: `llmAssisted` ⇒ never auto by default; engine sets the ceiling) | The LLM judge may downgrade a class or demand escalation; it can never *grant* auto-execution. Keeps the no-under-call soundness property intact under the judge. | Anthropic, *How we contain Claude* (environment-first containment, 2026-05-25); ops-hallucination prevalence finding (Help Net Security, 2026-06-05). |
| 11 | **Attestation-gated recovery context — OPT-IN** (`engine/attest.ts` `sanitizeWithAttestations`, wired to the MCP tools' `attest` parameter) | When the caller supplies `attest`, every safe-direction signal must carry a valid Ed25519 attestation bound to the run; anything unattested is **stripped before classification**, so the engine sees "unknown" and fails safe to IRREVERSIBLE + escalation. **Default-off:** omit `attest` and the caller's `recoverable` / `externalized:false` are believed as given — a forged `recoverable:true` on a hard delete becomes an auto-executable REVERSIBLE at confidence 1.0. That blast radius is stated and tested, not implied away. | Documented "remediation reverses an intended change" drift class; RATS/RFC 9334 framing. Independence is a disclosed **non-theorem** (see THEORY.md). |
| 12 | **Supply-chain cooldown + CI gate** (`.npmrc` `min-release-age=7`, `engine-strict`; `recovery-gate.yml`) | Refuses dependency versions <7 days old (most npm attacks have sub-week windows); CI runs `npm ci --ignore-scripts`, `npm audit --audit-level=high`, `npm audit signatures`. Protects you during the window you're not watching. | Socket *min-release-age* guidance (2026); @redhat-cloud-services (2026-06-01, 32 pkgs) + Axios (2026-03) compromises. |
| 13 | **EU AI Act Article 14 oversight, operationalized** (`runtime/escalation.ts` structured `OversightRecord`) | The irreversible remainder + every runtime escalation become an auditable, timestamped human-oversight record (caller, action, decision) routed to a real recipient. | EU AI Act **Article 14(4)(d)–(e)** (oversight: disregard/override/**reverse**, halt in a safe state); high-risk obligations enforceable per current trajectory (see RELATED_WORK §2). |

## Threat-taxonomy crosswalk (kept honest)

- **External standards** (cite as such): **OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10)** and
  **TRAIL** (arXiv:2505.08638). See `docs/THREAT_MAPPING.md`.
- **Failure-diagnosis taxonomy** (our synthesis, labeled): **AgentRx** (Microsoft Research,
  arXiv:2602.02475) — a *failure-mode* map, not a threat model. A reviewer will dock credibility if
  threat taxonomies and failure-mode taxonomies are conflated, so we don't.
- Microsoft's **2026-06-04 red-team taxonomy update** ("excessive agency," "autonomy escalation") maps
  directly onto *why an undo layer exists*; cited as current external context, not as Toffoli's claim.

## What is deliberately NOT claimed

The project's honesty line holds: soundness is *checked, not proven*; accuracy is on
*fixtures, not prevalence*; attestation establishes *authenticity, not backup independence*; Toffoli is
*single-trajectory* (distributed multi-agent rollback is research-scope — only a passive `agentId`/`runId`
correlation hook exists). The runtime-safety controls above reduce operational risk; they do not upgrade
any of those disclosed limitations.
