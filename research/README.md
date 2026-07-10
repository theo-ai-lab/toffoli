# Research & systems index

A reading index for the rigor under Toffoli's self-healing agent. Nothing here is new material —
it points at the existing documents and modules, in place. The agent story and the headline result
live in the top-level [`README.md`](../README.md); this is the map for the formal and systems depth.

## The formal core

- [`THEORY.md`](../THEORY.md) — the formal model: actions as state-transformers, the four
  reversibility classes as predicates, the *no-under-call* soundness property, attestation
  (§7–§8), and the related-work positioning (§8). The mechanized Lean soundness proof builds on
  §4.3 in particular.
- [`SPEC.md`](../SPEC.md) — the engine + runtime spec and the disclosed research-gated remainder.
- [`dataset/TAXONOMY.md`](../dataset/TAXONOMY.md) — the four-class taxonomy and the decision rules,
  with their prior-art provenance (saga taxonomy, compensating transactions, the HTTP/idempotency
  canon).

## The measured eval

- [`eval/README.md`](../eval/README.md) — eval methodology: per-class precision/recall, Wilson
  intervals, Total Classification Cost, and the at-scale bootstrap split.
- [`dataset/PROVENANCE.md`](../dataset/PROVENANCE.md) — the provenance firewall: synthetic fixtures
  vs documented incidents vs real captures, and why synthetic never reaches a reported number.
- [`dataset/incidents.jsonl`](../dataset/incidents.jsonl) — the source-cited documented-incident
  rows, each adversarially fact-checked and re-labeled to the four-class scheme.

## The systems work

- [`SPECULATIVE_EXECUTION.md`](SPECULATIVE_EXECUTION.md) — reversibility-gated speculative execution
  (`npm run speculate`): the floor as a speedup, the measured deterministic-vs-deterministic cascade,
  and the calibrated break-even rule for when speculation pays off.
- [`HORIZON_PLANNING.md`](HORIZON_PLANNING.md) — deterministic-first receding-horizon planning
  (`npm run plan`): the classifier as an exact, zero-model-spend feasibility filter inside a
  propose → prune → score → step → replan controller, honestly scoped as a demonstration harness.
- [`lib/engine/`](../lib/engine/) — the zero-dependency deterministic classifier, the dependency-aware
  resumable planner, and the attestation surface (Ed25519 by default).
- [`lib/runtime/`](../lib/runtime/) — the operational-safety floor: the enforced kill-switch
  chokepoint, plan-only-by-default + plan-bound confirm tokens, the write-ahead journal and its
  anti-fabrication invariant, the two-axis auto-execute policy, bounded retries + circuit breakers,
  and escalation as a durable path. See [`SAFETY.md`](../SAFETY.md) for the control crosswalk.
- [`lib/exec/`](../lib/exec/) — the reference executors: the in-memory sandbox `World`, the
  real-filesystem `FsWorld` adapter, and the SQL-backed `SqlWorld`.
- [`lib/agent/`](../lib/agent/) — the self-healing agent loop and the cross-run recovery memory.
- [`lib/mcp/`](../lib/mcp/) — the MCP server (checkpoint / classify / recover), its stdio client,
  and the agent host that drives them end to end (`npm run host`).

## Standards & threat mapping

- [`docs/RELATED_WORK.md`](../docs/RELATED_WORK.md) — related work, standards alignment, and the
  named research-scope limitations.
- [`docs/THREAT_MAPPING.md`](../docs/THREAT_MAPPING.md) — failure-mode mapping (OWASP / AgentRx / TRAIL).
- [`docs/OBSERVABILITY.md`](../docs/OBSERVABILITY.md) — the recovery loop as OpenTelemetry spans.
