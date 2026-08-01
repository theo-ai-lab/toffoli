# Toffoli — Spec

## The problem

The agent-tooling industry built **detection** — observability, tracing, accountability
ledgers — and largely skipped **recovery**. When an agent damages real state at 2 AM
(deletes the wrong rows, double-charges, half-runs a migration), there is no general,
developer-grade way to *put the world back*. The reliability stack invests heavily in
reasoning and ignores survival.

## The thesis

**Reversibility classification is an eval problem.** "Can this action be undone?" is a labeled
classification with ground truth, so it is built and measured like one: deterministic rules
first, the LLM judge only on the residual, per-class precision/recall over a labeled set, with
**recall on the IRREVERSIBLE class** as the headline — because calling an unrecoverable action
recoverable is the only unrecoverable error.

## What Toffoli does

Given a log of what an agent actually did, Toffoli:

1. **Classifies** each action `NULLIPOTENT | REVERSIBLE | COMPENSABLE | IRREVERSIBLE`
   (deterministic floor → gated, marked judge → fail-safe escalation). See
   [`dataset/TAXONOMY.md`](dataset/TAXONOMY.md).
2. **Plans the restitution**: a LIFO set of compensating actions (each with an `exact` vs
   `semantic` restoration guarantee and an idempotency guard), the **pivot** (earliest
   irreversible action), and the **escalations** — the irreversible remainder handed to a
   named human as a first-class output, never an omission.
3. **Executes and verifies locally** through the sandbox executor / FsWorld adapter when explicitly
   run, then emits a restitution receipt — what broke → what was undone → what state was restored →
   what requires a human.

## Architecture

```
AgentAction[]  ──►  classifyDeterministic  ──►  (residual)  ──►  claudeJudge (gated, marked)
   │                      │                                            │
   │                      └──────────── Classification[] ◄─────────────┘   (abstain + no judge → fail-safe IRREVERSIBLE)
   ▼
 plan()  ──►  RestitutionPlan { compensations (LIFO), escalations, summary{ pivot, fullyRecoverable } }
```

- **`lib/engine/`** — the deterministic core has zero runtime dependencies: `types` (contract),
  `classify` (rules), `plan` / `graph` / `resumable` (dependency-aware restitution), `metrics`
  (per-class P/R, Wilson CI, cost), `attest` (signed recovery context), and `restitute`
  (orchestrator). The gated `judge.ts` (next line) is the one exception — it uses the Anthropic SDK + zod.
- **`lib/engine/judge.ts`** — the only network call; official Anthropic SDK, gated behind
  `ANTHROPIC_API_KEY`, structured output, prompt-injection-fenced. Marked `llmAssisted`.
- **`lib/adapters/ledger.ts`** — an accountability-ledger seam. Maps a ledger entry to an
  `AgentAction` by *structure*, with no dependency on any ledger implementation (the adapter invariant).
- **`lib/exec/`** — the reference executor. It applies the planned compensations to a sandboxed
  world, verifies the recoverable subset against the baseline, and also runs on a real-filesystem
  adapter (`npm run recover:fs`) backed by a durable write-ahead claim journal (`fs-journal.ts`):
  an atomic exclusive-create claim, and an unresolved crash raised as `indeterminate` rather than
  reported as done.
- **`lib/runtime/`** — the unattended-deploy safety floor: plan-only default, enforced kill-switch,
  plan-bound confirm token, WAL journal, anti-fabrication check, transient retry, circuit breakers,
  and durable escalation.
- **`lib/trace/` + `.github/`** — OTLP-shaped observability spans and a recovery-soundness CI gate.
- **`dataset/`** — the labeled gold set + the provenance firewall.

## The clean adapter interface

`AgentAction` is generic and tool-agnostic, so Toffoli classifies any agent's action log. An
upstream accountability-ledger entry maps cleanly onto it, with **no dependency** on the ledger —
`lib/adapters/ledger.ts` is the single file that tracks an external ledger's schema.

## Eval

`npm run eval` is the always-runnable reproducible number (per-class P/R + Wilson CI +
Total Classification Cost + a zero-tolerance dangerous-miss check). Methodology and the
calibration plan (Cohen's κ for the judge) are in [`eval/README.md`](eval/README.md).

## Explicitly deferred (and why)

- **No live production mutation by default.** The executor and FsWorld adapter prove the recovery
  loop locally; deployed mutation remains behind `mode: execute`, a confirm token, and the
  kill-switch.
- **No prevalence headline yet.** Accuracy is reported on labeled fixtures and synthetic-at-scale
  distributions. A real "X% of agent runs contain irreversible damage" number waits for commissioned
  `self-run` captures.
- **Live end-to-end wiring to an upstream accountability ledger** is out of scope for v1: it waits
  until such a ledger's schema is stable — building on a moving contract is throwaway work.

## Human-gated (only a human can do these)

- Run the judge + a 200–500-action, 2–3-annotator residual gold set to publish a calibrated
  Cohen's κ (`npm run calibrate` is the harness).
- Commission `self-run` captures to produce the real *prevalence* headline.
- Final name/trademark/domain clearance on "Toffoli" before any commercial use.
