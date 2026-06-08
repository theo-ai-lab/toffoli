# Toffoli — Eval Methodology

`npm run eval` is the always-runnable, reproducible number: the deterministic floor scored
per-class against the labeled gold set ([`../dataset/`](../dataset/)). It measures the
**classifier's accuracy on fixtures** — not how often real agents take irreversible actions
(that prevalence number is gated to `self-run` provenance and is pending; see
[`../dataset/PROVENANCE.md`](../dataset/PROVENANCE.md)).

## The headline, and why it's that one

**IRREVERSIBLE recall** — of all truly irreversible actions, the fraction correctly flagged (and
therefore escalated, not auto-undone). A missed irreversible action is the only *unrecoverable*
eval error, so its false negative is the costly one. Agent tool calls routinely include irreversible
actions — a sent email, a settled payment, a dropped table — and a single mislabel of one can derail a
run (ToolEmu, [arXiv:2309.15817](https://arxiv.org/abs/2309.15817); τ-bench,
[github.com/sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)). How *prevalent*
they are is a measurement we gate to real self-run data — never asserted here (see the provenance firewall above).

## Never reported alone (anti-gaming)

Recall is trivially gamed by escalating everything (→ 100% recall, useless). So it always travels
with **IRREVERSIBLE precision** and the **abstention/escalation counts**, and with a
**Total Classification Cost**: a cost-sensitive aggregate where calling an irreversible action
recoverable costs 100× an over-escalation (cost ratios set by domain consequence, not class
prevalence — Lombardo et al., [arXiv:2510.22016](https://arxiv.org/abs/2510.22016)). The 100:1
ratio is a documented product decision, not a researched constant.

## Confidence intervals

IRREVERSIBLE recall is reported as a point estimate **with a Wilson 95% CI and n**. We do **not**
use Wald/CLT intervals: below a few hundred datapoints they dramatically understate uncertainty
(Bowyer, Aitchison & Ivanova, [arXiv:2503.01747](https://arxiv.org/abs/2503.01747)). The Wilson
interval is the default binomial-proportion CI.

## The dangerous-miss check

`dangerousMisses` counts truly-IRREVERSIBLE actions the floor called auto-undoable
(NULLIPOTENT/REVERSIBLE). It must be **zero** — a non-zero value means the engine would promise an
undo that destroys more state. The unit tests assert it.

## Judge calibration (human-gated)

An LLM judge is a measurement instrument; `npm run calibrate` (needs `ANTHROPIC_API_KEY`) runs it
over the residual and reports **Cohen's κ** — chance-corrected agreement, because "the judge
agrees 90%" is insufficient (Judge's Verdict, NVIDIA,
[arXiv:2510.09738](https://arxiv.org/abs/2510.09738)). Two guards travel with it:

- **The known judge failure mode** is agreeableness bias — high agreement on "reversible", low on
  "irreversible" (Beyond Consensus,
  [arXiv:2510.11822](https://arxiv.org/abs/2510.11822)) — exactly the dangerous direction here. So
  the judge ships behind a **minority-veto**: any IRREVERSIBLE vote forces escalation.
- κ should be benchmarked against a **human-to-human** baseline (a judge can't meaningfully beat
  the rate at which humans agree). Producing that — a 200–500-action gold set, 2–3 annotators, the
  gold set's own inter-annotator κ — is human work.

## The gold set

Hand-labeled actions across all four classes, including deliberately adversarial
"looks-reversible-but-isn't" rows (re-issued payment, consumed one-time credential, external
email) and the documented incidents. Each row carries a `provenance` gating how it may be used.
Imported labels are re-labeled to the four-class scheme (none label it natively) and agent
self-reported counts are quarantined from every metric.

## Citations

- **Saga / pivot / compensating-transaction semantics** — Garcia-Molina & Salem, *Sagas*, SIGMOD
  '87, [doi:10.1145/38713.38742](https://dl.acm.org/doi/10.1145/38713.38742); Richardson,
  [microservices.io/patterns/data/saga](https://microservices.io/patterns/data/saga.html).
- **Continuous reversibility (Φ)** — "Learning to Undo",
  [arXiv:2510.14503](https://arxiv.org/abs/2510.14503).
- **HTTP method semantics** — RFC 9110 §9.2; **idempotency keys** —
  [docs.stripe.com](https://docs.stripe.com/api/idempotent_requests).
- **Cost-sensitive eval** — [arXiv:2510.22016](https://arxiv.org/abs/2510.22016);
  **judge calibration** — [arXiv:2510.09738](https://arxiv.org/abs/2510.09738),
  [arXiv:2510.11822](https://arxiv.org/abs/2510.11822); **small-n CIs** —
  [arXiv:2503.01747](https://arxiv.org/abs/2503.01747).
- **Competitive landscape** — RAC [arXiv:2605.03409](https://arxiv.org/abs/2605.03409);
  STRATUS [arXiv:2506.02009](https://arxiv.org/abs/2506.02009).

> An external eval-harness cross-check (the TS classifier as the system under test, the harness only
> scoring its emitted predictions) is a planned addition. The pure-TS `npm run eval` above — with
> per-class P/R, Wilson CIs, the cost matrix, and the dangerous-miss gate — is the load-bearing
> reproducible number today.
