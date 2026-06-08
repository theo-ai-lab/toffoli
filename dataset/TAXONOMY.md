# The Toffoli Reversibility Taxonomy

## How "what an agent did" becomes a reversibility class

This is the decision rulebook for Toffoli's classifier and for hand-labeling the
gold set. The contract types live in [`../lib/engine/types.ts`](../lib/engine/types.ts);
this file defines what each label *means* and how to decide it consistently.

> **Honesty up front.** Reversibility is best modeled as a *continuous* score Φ — the
> probability of returning to a prior state within some horizon ("Learning to Undo",
> Sorstkins et al., [arXiv:2510.14503](https://arxiv.org/abs/2510.14503)). Toffoli
> discretizes Φ into four operating buckets. **This four-bucket scheme is Toffoli's own
> synthesis. No single peer-reviewed paper names all four together.** It is assembled from
> three verified bodies of prior art:
>
> - **Saga taxonomy** — compensable / *pivot* / retriable (Richardson, *Microservices
>   Patterns*, [microservices.io/patterns/data/saga](https://microservices.io/patterns/data/saga.html)).
> - **Compensating transactions** — "a compensating transaction does not necessarily return
>   the database to the state that existed when [it] began" (Garcia-Molina & Salem, *Sagas*,
>   ACM SIGMOD '87, [doi:10.1145/38713.38742](https://dl.acm.org/doi/10.1145/38713.38742)).
> - **The HTTP / idempotency canon** (RFC 9110; the Stripe idempotency-key model).

---

## The four classes

| Class | Meaning | Restitution | Guarantee |
|---|---|---|---|
| **NULLIPOTENT** | The action changed nothing — a read, a no-op, an uncommitted call. | None needed. | Φ≈1 at zero cost. |
| **REVERSIBLE** | A direct inverse restores the **EXACT** prior state. | True inverse or transaction rollback; net effect = 0. | Exact restoration. |
| **COMPENSABLE** | No inverse; an equal-and-opposite action restores **EQUIVALENT** state. | A contra-action — refund, correcting entry, retraction. **The original really happened and stands.** | Semantic, not exact. |
| **IRREVERSIBLE** | No machine undo exists; information left the boundary or state was destroyed with no recovery channel. | **Escalate to a named human.** | None. This is the headline-risk class. |

The single most precise line is **REVERSIBLE vs COMPENSABLE**: a refund is *not* an
un-charge. Every compensating action Toffoli plans carries a `restoration: "exact" |
"semantic" | "none"` field so an auditor can see which guarantee it provides.

### Idempotency is NOT a class

Idempotency (safe to re-execute) is **orthogonal** to reversibility. A payment-capture
`POST` carrying a Stripe idempotency key is idempotent **and** irreversible. So Toffoli
tracks idempotency as a separate signal (`Classification.idempotent`) — used to make the
*compensating* action safe to re-run — and **never** lets it downgrade a class.

---

## The two invariants (the house style)

1. **Citation is mandatory.** Every `Classification` carries a `ruleRef` (the rule/signal
   that produced it) and a one-line `rationale`. An uncited verdict is not representable.

2. **Deterministic-first, LLM-marked.** Rules run first. Only the residual a rule can't
   resolve (arbitrary `execute`, an unrecognized tool, an `update` with no before-image)
   falls through to the gated LLM judge, and every such verdict sets `llmAssisted: true`.

---

## The fail-safe invariant (why "IRREVERSIBLE recall" is the headline)

> **Reversibility is a function of `(action × external recovery state)`, never of the verb
> alone. An UNKNOWN input biases TOWARD severe — escalate — never toward safe.**

This is the deliberate inverse of the documented RAC failure mode ("if a compensation for a
tool can't be found, RAC assumes the tool has no side effects" —
[arXiv:2605.03409](https://arxiv.org/abs/2605.03409)). Calling an irreversible action
recoverable is the only *unrecoverable* error: it promises an undo that, attempted, can
destroy more state. So the costly class is IRREVERSIBLE, and **recall on it is the headline
metric.** When the rules abstain and no judge is configured, the orchestrator escalates to
IRREVERSIBLE rather than guess.

### Recovery context must be *independent*

"A backup exists" must **never** auto-downgrade an action to REVERSIBLE. A backup co-located
with the data and deleted alongside it is not recovery (the PocketOS incident). The
`recoverable` signal means an **independent** recoverable copy — off-host backup,
point-in-time recovery, version history, a 30-day trash — with a real retention window and a
known invoker.

---

## The pivot

Borrowing the saga taxonomy's *pivot* (the point of no return): the **earliest** irreversible
action in a run defines the irreversibility boundary. Everything after it is "retriable, not
undoable." Toffoli surfaces this as `summary.pivotActionId` so a reviewer sees exactly where
automatic restitution stops.

---

## The deterministic rule floor (citable)

A static table keyed on richer inputs than the verb. **Bias every ambiguous/missing input
toward IRREVERSIBLE.**

### HTTP (RFC 9110 §9.2; RFC 5789)

| Method | Default class | Note |
|---|---|---|
| GET / HEAD / OPTIONS / TRACE | **NULLIPOTENT** | Safe methods — changed nothing. |
| POST | infer from side effect | An idempotency key makes it *de-duplicated*, **not** reversible. |
| PUT / PATCH | **REVERSIBLE** if a before-image is captured, else abstain → IRREVERSIBLE | Idempotent ≠ reversible. |
| DELETE | **REVERSIBLE** if an independent recoverable copy / open txn, else **IRREVERSIBLE** | |

### SQL (transaction- and engine-aware)

| Op | Reversible iff… | Default |
|---|---|---|
| INSERT | open txn (ROLLBACK) or matching DELETE | REVERSIBLE |
| UPDATE | before-image captured or versioned store or open txn | REVERSIBLE → else abstain |
| DELETE | soft-delete / open txn / independent backup | REVERSIBLE → else **IRREVERSIBLE** |
| TRUNCATE / DROP | independent backup recorded | else **IRREVERSIBLE** (Postgres rolls these back only *inside* an uncommitted txn) |

(Postgres TRUNCATE/DDL are transaction-safe pre-commit:
[postgresql.org/docs](https://www.postgresql.org/docs/current/sql-truncate.html). Stripe
idempotency keys de-duplicate POSTs but a settled capture is refund-only, not reversible:
[docs.stripe.com](https://docs.stripe.com/api/idempotent_requests).)

### Side-effect ops

| Op | Class | Why |
|---|---|---|
| send (external) | **IRREVERSIBLE** | A delivered message can't be un-sent. |
| pay (settled/withdrawn) | **IRREVERSIBLE** | Funds left your control; refund only while still in it (→ COMPENSABLE). |
| publish (fanned-out) | **IRREVERSIBLE** | A retraction can't recall what was delivered (→ COMPENSABLE if you control the surface). |
| append | **COMPENSABLE** | No un-append; post a correcting entry. |
| deploy | **COMPENSABLE** | Roll back to the prior release. |
| execute / custom | **abstain → judge** | The effect is opaque to the rules. |

> **The agent's own reversibility claim is UNTRUSTED.** Replit's agent falsely said recovery
> was impossible (it wasn't); Gemini CLI correctly said it was. Toffoli scores its verdict
> independently — a disagreement between the agent's claim and Toffoli's verdict is itself a
> high-value escalation signal. MCP tool annotations (`destructiveHint`, `idempotentHint`) are
> advisory features, never ground truth: a server can claim `readOnlyHint: true` and delete
> your files anyway.

---

## Why this taxonomy is also the metric

Each labeled action is one (action, class) instance, so the gold set yields **per-class
precision/recall** — never one flattering accuracy number — with **IRREVERSIBLE recall** (and
its Wilson CI) as the headline, paired with IRREVERSIBLE precision so it can't be gamed by
escalating everything. See [`../eval/README.md`](../eval/README.md).
