# The Provenance Firewall

Toffoli measures itself. That only means something if the data behind a reported number
can't be quietly contaminated. Every gold-set row carries a `provenance`, and it gates how
the row may be used.

| provenance | what it is | file | may it produce a PREVALENCE headline? |
|---|---|---|---|
| `synthetic-seed` | hand-authored fixtures for engine development | `ground-truth.seed.jsonl` (tracked) | ❌ never |
| `documented-incident` | real third-party failures, each with a primary/reputable source | `incidents.jsonl` (tracked) | ❌ no — real, but a *separate* supporting-evidence class |
| `self-run` | real agent runs you commissioned against your own systems | `captured.jsonl` (**gitignored**) | ✅ yes — the only "real prevalence" number |

Two different numbers, never conflated:

1. **Classifier accuracy** (per-class precision/recall) — reported on the full labeled set,
   always labeled *"accuracy on fixtures."* It measures the engine, not the world.
2. **Prevalence** ("X% of real agent actions are irreversible") — gated to `self-run` rows
   only, and **pending**. `lib/engine/types.ts` exports `isHeadlineEligible()`; any code that
   reports a prevalence number must filter through it.

## Agent self-reports are never ground truth

Some documented incidents include a count the *agent itself* confessed (Replit's "1,206
executions / 1,196+ companies") or a single user's screenshot (Cowork's "~27,000 files").
These are tagged in the row's `notes` as `source=agent_self_report` / `source=user_claim` and
are **excluded from every headline metric.** A fabricated or inflated number is the worst
possible contamination — it would make Toffoli the thing it audits.

> This rule has teeth for a concrete reason: a widely-repeated agent-failure statistic — the
> "Air Canada 1,247-passenger" figure — conflates two incidents; the real *Moffatt v. Air Canada*
> case is **one** passenger, ~CA$812. Every external claim in this repo was adversarially
> fact-checked against a primary source before inclusion; the quarantined/refuted claims were kept
> out of all tracked files.
