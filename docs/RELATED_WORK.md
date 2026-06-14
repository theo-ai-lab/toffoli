# Toffoli — Related Work, Standards Alignment, and Limitations

Where Toffoli sits in the agent-recovery landscape, what standards it aligns to, and — held to the
project's own honesty bar — exactly what it does **not** yet do. Every external claim here was
web-verified; where a popular framing is wrong, the correct one is given.

## 1 · The recovery landscape (and Toffoli's precise slot)

| System | What it does | Axis vs Toffoli |
|---|---|---|
| **Recovery-Bench** (Letta, 2025) | Measures whether an agent can still **complete its task** starting from a *corrupted* environment — *forward* recovery. | The **inverse axis.** Toffoli does *backward* recovery — reverse the damage. Recovery-Bench is **not** an undo/rollback scorer, so a "Recovery-Bench score" would not validate Toffoli's recovery rate; it is cited here as the complementary direction. |
| **RAC** — Robust Agent Compensation (arXiv:2605.03409) | Log-based, code-change-free compensation that *executes* undo by topologically replaying a transaction graph. | Closest sibling, but **fails open**: "if a compensation for a tool can't be found, RAC assumes the tool has no side effects." Toffoli *classifies* reversibility up front and **fails safe**, escalating the irreversible remainder. |
| **STRATUS** (arXiv:2506.02009) | Proves *Transactional No-Regression* — an **executor** monotonicity over a health scalar — as a *pre-act* gate, domain-locked to cloud/SRE. | Different in kind: an executor guarantee under an *assumed* faithful undo, vs Toffoli's *classifier* soundness (label correctness, post-hoc). |
| **Atomix** (arXiv:2602.14849) | A reversibility-aware transactional tool runtime that partitions effects and compensates on abort, **inline**. | Single-node (the paper notes "Distributed deployment remains future work"). Toffoli is post-hoc and adds attested context + escalation; both stop short of distributed multi-agent. |
| **SagaLLM** (arXiv:2503.11951, **March 2025**) | Brings the saga compensation pattern to multi-agent LLM planning. | Establishes saga-for-agents as prior art (note the 2025 date — the idea is **not** novel here); SagaLLM defines no reversibility *taxonomy* and no soundness property. |
| **ACRFence** (arXiv:2603.20625) | Agent recovery-integrity on checkpoint/restore (records irreversible effects, replay-or-fork). | Complementary; explicitly **no signing/attestation** — Toffoli's delta is binding attestation to the *recovery context*. |

**Toffoli's one-sentence slot:** post-hoc, domain-agnostic reversibility **classification**, measured as
a per-class eval under a **one-sided soundness** objective (never label an action more reversible than it
is), feeding a dependency-aware restitution **synthesizer + executor** with conflict detection, whose
irreversible remainder is escalated with an **attested recovery context**. Each conjunct exists in prior
work (see above); the *composition* is the contribution.

> **Production landscape (tooling, not benchmarks).** Operational mechanisms for reversing agent
> actions do exist — e.g. Rubrik's *Agent Rewind* and Dapr workflow **compensation** — but they are
> runtime rollback features, not *measurement*. As of June 2026 there is **no standard, named benchmark
> that scores undo/restitution success**: Letta's *Recovery-Bench* (the only similarly-named artifact)
> measures the inverse — whether an agent can still complete its *forward* task starting from a corrupted
> state. By that gap, Toffoli's honest per-class eval is an early instrument for the otherwise-unmeasured
> *reversibility-classification* axis. (So: do not "run recover-bench and publish a recovery score" — no
> such undo benchmark exists, and conflating it with Recovery-Bench would be a category error.)

## 2 · Standards alignment (accurate, not aspirational)

- **SCITT** (IETF Supply Chain Integrity, Transparency and Trust). The architecture is a **pre-RFC
  Internet-Draft** (`draft-ietf-scitt-architecture` v22, Oct 2025; the REST API `draft-ietf-scitt-scrapi`
  v09, Dec 2025) — moving, not yet stable. Toffoli's Ed25519 recovery attestations are already signed
  statements over a canonical claim — i.e. **COSE_Sign1-aligned** — with a clean path: once SCRAPI
  stabilizes, a recovery attestation could be registered to a SCITT Transparency Service for a
  **publicly verifiable COSE receipt** instead of a holder-verifiable signature. The agent-action→SCITT
  pattern is **nascent and essentially unadopted** — the closest profile, *Notarized Agents / Sello*
  (2026, COSE_Sign1 + Sigstore Rekor), self-states adoption is ~zero. Toffoli ships **no** SCITT
  integration (it would mean building on shifting pre-RFC sand for little practical benefit today),
  and note "AgentLair SCITT" is a misnomer — AgentLair is an agent *identity* product, not a
  transparency-log service. There is **no** "SCITT phase 2" or "Article 50 SCITT profile." Forward-looking
  alignment note only.
- **EU AI Act.** The relevant hook is **Article 14(4)(d)–(e)** (human oversight — the right to *disregard,
  override, or **reverse*** a high-risk system's output, and to halt it in a safe state), and optionally
  **Article 12** (logging) for the attestation ledger. Toffoli is **machinery that helps operationalise
  the Article 14 reverse/halt capability** — it does **not** "mandate recoverability" (no such statutory
  term exists, and **Article 50 governs transparency/disclosure, not logging or recovery**). High-risk
  obligations are, on current trajectory (the Digital Omnibus), expected to apply **~December 2027**, not
  August 2026.

## 3 · Limitations & future work (the disclosed corners)

- **Single-agent only.** Toffoli orders undo within one agent's run. True **multi-agent, shared-state**
  recovery — interleaved writers, "whose undo wins," cross-agent rollback of already-rolled-back state —
  is an **open frontier** (Atomix is single-node; SagaLLM is per-plan). Toffoli's compensable-action
  model is already the **saga-compensation primitive**; extending it needs distributed compensation
  ordering and cross-agent attestation. Note we would **reject two-phase commit** in favor of
  **saga-style choreography**: 2PC's blocking and coordinator-failure behavior is exactly what agent
  systems avoid (naming "2PC" as the goal would be buzzword-matching, not judgment). This is
  **research-grade scope, not a v1 increment** — it is closer to the *thesis* of a separate project
  than a Toffoli feature, and is deliberately not attempted.
- **The executor is sandbox-by-default, with a real-filesystem reference adapter.** It verifies undo on
  an in-memory world (file store, rows, ledger, outbox) *and* on the actual disk (`lib/exec/fs-world.ts`,
  `npm run recover:fs`); other production backends (a real database, a payment API) are out of scope for
  v1, where they would add permission errors, transient locks, and partial network failure.
- **Soundness is checked, not proven.** "No-under-call" is verified by property-based testing
  (non-vacuously — over-calling and abstention are witnessed); a fully mechanized proof (Lean/Coq) and a
  small-scope model check (TLA⁺/Alloy) are named remainders in `THEORY.md §4`.
- **Accuracy is on fixtures, not prevalence.** Numbers are on synthetic + 18 documented incidents; a
  real-world rate needs real commissioned runs and is gated behind the provenance firewall (pending).
