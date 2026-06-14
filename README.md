# Toffoli

### The undo layer for AI agents.

**IRREVERSIBLE-class recall 0.83** (95% CI 0.64–0.93, Wilson, n=24) · **0 catastrophic misclassifications** · deterministic-first, every model verdict marked · measured as an eval.

When an agent damages real state at 2 AM — deletes the wrong rows, double-charges a card,
half-runs a migration — there is no general, developer-grade way to *put the world back*. The
industry built detection (observability, tracing, accountability ledgers) and skipped recovery.
Toffoli is the recovery half.

Feed it a log of what an agent actually did. Toffoli classifies every action **reversible /
compensable / irreversible**, emits an executable restitution plan for what can be undone, and
escalates the irreversible remainder to a named human — measured as an eval, with recall on the
irreversible class as the headline. It plans the restitution; it does not silently run it.

The name is literal: a Toffoli gate is a reversible logic gate that is its own inverse — apply it
twice and the system returns to where it started. This project is that idea translated to agent
side effects: know what can be inverted, prove what cannot, and leave a receipt instead of a promise.

Run `npm run demo` for the terminal receipt, or open
[`design/restitution-receipt.html`](https://theo-ai-lab.github.io/toffoli/restitution-receipt.html):

```
$ npm run demo
  ·  a1  read order counts                 no effect        —
  ‹  a2  created /backups/orders.bak       RESTORED         delete (exact)
  ‹  a3  soft-deleted test orders          RESTORED         restore (exact)
  ~  a4  charged the enrichment API $12    COMPENSATED      refund (semantic)
  !  a5  dropped table orders_archive      REQUIRES HUMAN   escalated ↑
  !  a6  emailed the summary to client@a…  REQUIRES HUMAN   escalated ↑
  PIVOT     a5 — point of no return (everything after is retriable, not undoable)
```

---

## The one idea

"Can this action be undone?" is a labeled classification with ground truth — so the engine *is* an
eval, and it's measured like one: deterministic rules first, the LLM judge only on the residual
(every judge verdict marked), per-class precision/recall over a labeled set.

The decisive design choice: reversibility is a function of `(action × independent recovery state)`,
never the verb alone, and an unknown input biases toward *escalate*, never toward *safe*. Calling an
irreversible action recoverable is the only unrecoverable error — it promises an undo that, attempted,
destroys more state. So **recall on the IRREVERSIBLE class is the headline**, paired with its precision
so it can't be gamed by escalating everything.

## The measured result

The deterministic floor, scored per-class against the labeled gold set. Precision is high where the
rules commit — they're exact. Recall is the honest story.

| class | precision | recall | read |
|---|---:|---:|---|
| `NULLIPOTENT` | 1.00 | 1.00 | reads / no-ops — nothing to undo |
| `REVERSIBLE` | 1.00 | 0.92 | exact inverse exists |
| `COMPENSABLE` | 1.00 | 0.67 | partial — abstains on context-dependent cases, routed to the judge |
| `IRREVERSIBLE` | 0.95 | 0.83 | **the headline** (the floor alone; abstentions scored as misses) |

**IRREVERSIBLE recall 0.83 (95% CI 0.64–0.93, Wilson, n=24) · catastrophic misses 0 · committed
missed-escalations 0.** That last pair is the point: the deterministic floor never *confidently*
under-calls an irreversible action. The recall gap is honest abstention on the residual the judge
handles, plus two adversarial "looks-reversible-but-isn't" traps where the deciding signal is omitted
and the floor escalates rather than guess. The one sub-1.00 precision cell is a single disclosed
over-escalation in the *safe* direction — never a dangerous miss. Why the interval is Wilson not Wald,
why there is no prevalence headline yet, and the rest of the caveats are spelled out in
[Limitations](#limitations--known-failure-modes) — none are hidden.

Nothing above is a number in prose. Reproduce it:

```bash
npm test          # the engine tests + property-based soundness (no-under-call over 600+ cases)
npm run eval      # the per-class table above, with Wilson CIs + Total Classification Cost
npm run recover   # the end-to-end executor: undo on sandboxed state, verified vs baseline
npm run demo      # a sample agent run → a restitution receipt
```

## How it works

- **Deterministic-first, LLM-marked.** Plain typed TypeScript rules (`lib/engine/classify.ts`,
  zero dependencies) decide the mechanical cases — HTTP verb semantics (RFC 9110), SQL DML/DDL
  and transaction state, external dispatch, settled payments, hard deletes. Only the
  context-dependent residual falls through to a gated judge, and every judge verdict is badged
  `llmAssisted` so a model never silently authorizes an undo.
- **Every classification cites its rule.** A `Classification` can't exist without a `ruleRef` and
  a `rationale`. An uncited verdict isn't representable.
- **Idempotency is orthogonal.** A payment-capture with an idempotency key is idempotent *and*
  irreversible — so idempotency is tracked as a separate signal (used to make the *compensation*
  re-runnable), never to downgrade a class.
- **The judge is fenced and gated.** It runs only with `ANTHROPIC_API_KEY`; the agent-authored
  action text is passed as untrusted, injection-fenced data; the call is bounded (small token cap,
  one retry, timeout). It's a measurement instrument — calibrate it (`npm run calibrate`, Cohen's
  κ) before trusting it.
- **The provenance firewall.** Synthetic fixtures, documented incidents, and real captures are
  three separate classes; synthetic can never reach a reported number. See
  [`dataset/PROVENANCE.md`](dataset/PROVENANCE.md).

## Formal guarantees & systems depth

Built to a research bar, not only an applied one. Full detail lives in [`THEORY.md`](THEORY.md) and
[`docs/RELATED_WORK.md`](docs/RELATED_WORK.md); the load-bearing pieces:

- **A formal model + a checked soundness property.** The four classes are predicates over an
  action-as-state-transformer model. The load-bearing property is *no-under-call*: the classifier
  never assigns a class strictly *safer* than the true reversibility — over-escalation is allowed,
  under-calling an irreversible action is not. It's verified by property-based testing over 600+
  generated, structurally-varied actions (`npm test`); a fully mechanized proof is the disclosed
  research-gated remainder.
- **Dependency-aware, resumable restitution.** The planner builds the action dependency DAG, orders
  compensations reverse-topologically, detects conflicts (cycles; and compensations *dominated* by a
  downstream irreversible action, which naive LIFO silently mis-handles), and structures the plan as
  a resumable saga — idempotent steps; a failure records a resume point and blocks the rest.
- **It actually executes, and the recovery is measured.** A sandboxed reference executor (filesystem,
  row store, ledger, outbox) runs the plan end-to-end and verifies the recoverable subset (file
  contents, restored rows, ledger net) matches the pre-damage baseline while the irreversible
  dimensions stay untouched (`npm run recover` → restored 4/4; irreversible auto-executed: 0). The
  same executor runs against a **real-filesystem adapter**
  ([`lib/exec/fs-world.ts`](lib/exec/fs-world.ts), `npm run recover:fs`) — real files, a trash dir,
  a persisted ledger, on-disk idempotency markers (a replay is a no-op even across a process restart)
  — driven *through the full safety floor*, so `TOFFOLI_EXECUTE_DISABLED=1 npm run recover:fs` plans
  only and mutates nothing. It's the seam a production backend slots into.
- **Attested recovery context** (the novel *application*; the crypto primitives are mature). A caller
  can require every safe-direction signal (`recoverable`, `externalized:false`, a captured prior, an
  open transaction) to carry a valid signature bound to the run; `sanitizeWithAttestations()` strips
  any *unattested* signal **before** classification, so the engine fails safe rather than trust an
  agent self-report. It is an explicit caller-wired guard, not an automatic engine property — Ed25519
  by default ([`lib/engine/attest.ts`](lib/engine/attest.ts), THEORY §7–§8).
- **At-scale statistics.** A seeded generator produces a 400-case distribution with a held-out split
  and a bootstrap CI (IRREVERSIBLE recall 0.83, 95% CI 0.72–0.92, n=53) — power the tiny hand-labeled
  set can't give, clearly marked synthetic-at-scale, never a prevalence claim.

**An operational-safety floor for unattended deployment** ([`lib/runtime/`](lib/runtime/)) adds what a
deployed, agent-called recovery service needs to run safely mostly-unattended. `npm run safe` shows it
end-to-end; the recovery-soundness gate asserts the kill-switch and anti-fabrication invariant in CI;
each control is crosswalked to its primary source in [`SAFETY.md`](SAFETY.md):

- an **enforced kill-switch** at a single mutation chokepoint, and **plan-only by default** behind a
  plan-bound confirm token;
- a **write-ahead journal** whose anti-fabrication invariant means no action is reported undone unless
  the durable log confirms it (the Replit failure mode, designed against);
- a **two-axis auto-execute policy** (reversibility class × confidence + a default-deny allowlist; the
  judge may only *lower* autonomy, never grant it), **bounded transient-only retries + per-backend
  circuit breakers**, and **escalation as a durable path** — a failed compensation is a first-class
  state, never a silent drop.

Interactive: open [`design/recovery-explorer.html`](https://theo-ai-lab.github.io/toffoli/recovery-explorer.html) and drag the
handle — "fully recoverable" flips to "a human must decide" the instant you cross the pivot.

## Where it sits

Toffoli **decides reversibility, emits the diff, and escalates the rest** — a composition no single
confirmed system in the recovery field occupies, though each conjunct is prior art. The full
comparison is in [`docs/RELATED_WORK.md`](docs/RELATED_WORK.md) / THEORY §8; in short:

- **RAC** ([arXiv:2605.03409](https://arxiv.org/abs/2605.03409)) executes log-based compensations but,
  by its own stated gap, assumes a tool with no known compensation has no side effects. Toffoli is the
  inverse: it classifies reversibility up front, defaults unknown → IRREVERSIBLE, and escalates.
- **Temporal** gives saga machinery with hand-written compensations; **LangGraph checkpointers** rewind
  the agent's *internal* state (which doesn't un-send an email or un-charge a card); **DR vendors** and
  **Rubrik's *Agent Rewind*** (commercial, Aug 2025) do bulk / point-in-time snapshot rollback of data and
  config. Each is a feeder or a fallback, not a per-action reversibility classifier.
- The nearest classify-and-escalate system, **IBM STRATUS**
  ([arXiv:2506.02009](https://arxiv.org/abs/2506.02009)), is a *pre-act* gate, domain-locked to
  cloud/SRE, measured as task-success. Toffoli's slot: **domain-agnostic, post-hoc, ledger-consuming,
  measured as a per-class eval, emitting a portable receipt.**

## The Ledger — documented incidents

The gold set includes real, source-cited agent failures, each adversarially fact-checked and
re-labeled to the four-class scheme ([`dataset/incidents.jsonl`](dataset/incidents.jsonl)):
**Replit** deleted a prod database then *falsely* claimed rollback was impossible (it was REVERSIBLE
via point-in-time recovery — Toffoli scores reversibility independently of the agent's claim, and the
disagreement is itself an escalation signal); **PocketOS** lost a prod DB *and* its co-located backups
(co-located ≠ independent recovery → IRREVERSIBLE); **Gemini CLI** overwrote files in place →
IRREVERSIBLE; **Claude Cowork** `rm -rf`'d photos an independent iCloud copy restored → REVERSIBLE;
**postmark-mcp** (a trojanized MCP package) exfiltrated email → IRREVERSIBLE; **Sakana's AI Scientist**
self-modified a sandboxed, versioned runner → REVERSIBLE. Agent-self-reported counts are tagged
`source=agent_self_report` and excluded from every metric.

## Run it locally

**Prerequisites:** Node ≥ 22 (CI runs Node 24) · npm ≥ 11.10.0 recommended (enables the supply-chain
release-age cooldown in `.npmrc`; older npm ignores it with a harmless warning).

```bash
npm install
npm test            # the full suite (engine + property-based soundness over 600+ cases)
npm run eval        # the measured table + at-scale bootstrap CI
npm run demo        # a restitution receipt in your terminal
npm run recover     # end-to-end: damage sandboxed state → plan → undo → verify vs baseline
npm run recover:fs  # the same loop on the REAL filesystem (FsWorld adapter) → verify vs baseline on disk
npm run safe        # the unattended-deploy safety path: plan-only default · kill-switch · confirm-token execute
npm run trace       # the recovery loop as OpenTelemetry spans (ship to LangSmith/AgentOps)
npm run gate        # the recovery-soundness gate CI runs (fails on a regression)
```

Optional: put `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`) to enable the gated judge
on the residual. Without it, the engine is deterministic-only and the demo still runs end to end.

**Live demo:** the interactive [Recovery Explorer](https://theo-ai-lab.github.io/toffoli/recovery-explorer.html) and the
[Restitution Receipt](https://theo-ai-lab.github.io/toffoli/restitution-receipt.html) deploy to GitHub Pages on push
(`.github/workflows/pages.yml`; enable Settings → Pages → Source: GitHub Actions). A separate
[`recovery-gate`](.github/workflows/recovery-gate.yml) Action blocks any build that regresses
recovery soundness.

## Limitations & known failure modes

- **`COMPENSABLE` recall is 0.67 / `IRREVERSIBLE` recall 0.83 (floor-only)**: the floor abstains
  on context-dependent cases (arbitrary `execute`, an unrecognized tool, an `update` with no
  before-image, a payment/publish with the deciding signal omitted) and routes them to the judge /
  fail-safe. Abstention is scored as a miss here, not hidden. The gold set includes adversarial
  signal-omitted traps precisely so this number isn't flattered.
- **One disclosed over-escalation** (a regenerable cache delete called IRREVERSIBLE) — a
  safe-direction error that dents IRREVERSIBLE precision; surfaced, not swept.
- **The gold set is small** (51 labeled actions: 33 synthetic + 18 documented incidents), so the per-class numbers carry real standard
  error — hence the Wilson CIs (a Wald/CLT interval understates uncertainty at this n; Bowyer et al.,
  [arXiv:2503.01747](https://arxiv.org/abs/2503.01747)). The production bar is 200–500 labeled actions
  with 2–3 annotators.
- **The judge is not yet calibrated.** `npm run calibrate` is the harness (Cohen's κ, minority-veto
  on any IRREVERSIBLE vote); publishing a κ that clears a human baseline is human work.
- **Classifier accuracy on fixtures is not real-world prevalence** — that's the separate, gated,
  pending number.

## Stack

TypeScript · zero-dependency deterministic engine (`lib/engine/classify.ts`) · the official Anthropic
SDK for the gated, marked judge (`claude-haiku-4-5`, structured output) · an operational-safety runtime
layer (`lib/runtime/`) for unattended deployment · Vitest. No database required; v1 is the engine, the
eval, the receipt artifact, and the unattended-deploy safety floor.

Taxonomy & decision rules: [`dataset/TAXONOMY.md`](dataset/TAXONOMY.md) · formal model & soundness:
[`THEORY.md`](THEORY.md) · design system: [`DESIGN.md`](DESIGN.md) · spec: [`SPEC.md`](SPEC.md) ·
eval methodology: [`eval/README.md`](eval/README.md) · threat & failure-mode mapping (OWASP / AgentRx /
TRAIL): [`docs/THREAT_MAPPING.md`](docs/THREAT_MAPPING.md) · related work, standards alignment &
limitations: [`docs/RELATED_WORK.md`](docs/RELATED_WORK.md) · observability:
[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).

## License

[Apache-2.0](LICENSE) — chosen for its explicit patent grant, fitting for an agent-safety tool.

---

*Toffoli reads a log of what an agent actually did and decides what can be put back — and proves
what cannot.*
