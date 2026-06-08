# Toffoli — Theory: a model of action reversibility

*The formal core. Toffoli decides "can this be undone?" — a safety-critical classification — so we
give "reversible" a precise meaning, state the classifier's safety as a recognized soundness property,
and verify it. Every external citation here was adversarially fact-checked; foundations named without a
specific reference are flagged as such. Where prior work already does part of this, it is named
explicitly (§8) rather than absorbed.*

---

## 1. The model

We adopt the **Korth–Levy–Silberschatz (KLS) state-transformer model** as the calculus backbone
(*A Formal Approach to Recovery by Compensating Transactions*, VLDB 1990), with **Bennett's
injectivity criterion** for the reversibility split (*Logical Reversibility of Computation*, IBM J.
Res. Dev. 17(6):525–532, 1973, doi:10.1147/rd.176.0525).

- **State** `S` — the relevant (augmented) slice of the world, including an *externalization* projection
  recording what has crossed a trust boundary you don't control (monotone: things leave, never return).
- **Action** `a` denotes a **partial function** `⟦a⟧ : S ⇀ S`. A run/history is their functional
  composition `X = ⟦aₙ⟧ ∘ … ∘ ⟦a₁⟧`; history equality is `X = Y :⟺ ∀S. X(S)=Y(S)`; and `X,Y` **commute**
  iff `X∘Y = Y∘X` — non-commutativity is exactly *conflict* (§5).
- **Recovery context** — side artifacts the *system* (not the agent) provides: a captured prior, an
  independent recoverable copy, an open transaction, an idempotency key. These decide reversibility, and
  must be attested (§7).

---

## 2. The four classes, as predicates

Let `obs : S → Obs` be the observation map and `≈` observational equivalence (equal under `obs`).

| Class | Predicate | Algebraic home |
|---|---|---|
| **NULLIPOTENT** | `⟦a⟧ = id` on the affected slice — a read / no-update projection. | the identity element |
| **REVERSIBLE** | `∃ a⁻¹. ⟦a⁻¹⟧ ∘ ⟦a⟧ = id` — an **exact** inverse restores the prior state. Equivalent to **injectivity** of `⟦a⟧` (Bennett). | bijection group / symmetric inverse monoid `I(X)` (Wagner–Preston; Lawson 1998) |
| **COMPENSABLE** | `¬REVERSIBLE`, but `∃ c. ⟦c⟧(⟦a⟧S) ≈ S` — a compensation restores an **equivalence class**, "as if `a` never ran" (KLS Def. 1), not the exact prior. | inverse-up-to-observation; saga compensation |
| **IRREVERSIBLE** | non-injective, with **no** state-inverting compensation — information was destroyed or externalized (Gray's "real" actions: dispense money, send a message). Escalate. | outside the injective boundary |

These form a strict **chain** (severity / decreasing recoverability):

```
NULLIPOTENT  ⪯  REVERSIBLE  ⪯  COMPENSABLE  ⪯  IRREVERSIBLE     (⋁ = max; ⊤ = IRREVERSIBLE)
```

Three grounding facts:

- **The REVERSIBLE/COMPENSABLE line** is Garcia-Molina & Salem's: a compensation *"undoes, from a
  semantic point of view, … but does not necessarily return the database to the state that existed when
  [it] began"* (*Sagas*, ACM SIGMOD 1987, doi:10.1145/38713.38742). Its observable contract is the
  **GetPut lens law** `put(s, get(s)) = s` (Foster et al., ACM TOPLAS 29(3), 2007).
- **The irreversibility boundary is provable.** Reversible flowchart languages are *r-Turing complete:
  they compute exactly the injective computable functions*, and any join/merge (a non-injective effect)
  needs an orthogonalizing assertion to recover which branch ran (Yokoyama, Axelsen & Glück, ICALP 2008 /
  TCS 611, 2016). Erase/merge is thus the canonical irreversible primitive (thermodynamically, Landauer
  1961 — "order `kT`"). 
- **"Nullipotent"** is community terminology (≈ HTTP **safe**), *not* an RFC term; RFC 9110 defines only
  *safe* and *idempotent*. Idempotency (`⟦a⟧∘⟦a⟧ = ⟦a⟧`) is **orthogonal** to reversibility — a keyed
  payment-capture is idempotent **and** IRREVERSIBLE — and is tracked as a separate signal, never a class.

---

## 3. The classifier and the soundness property

The classifier `C` reads an action's observable metadata (op, target signals, recovery context) and
returns a class or `⊥` (abstain); the product applies a fail-safe `C⁺(a) = C(a)` if it commits else
`IRREVERSIBLE`. Let `c*(a)` be the true class. These metadata are agent-influenceable, so the statement
below is **relative to honest metadata** — which §7 makes enforceable by stripping every *unattested*
safe-direction signal before `C` runs (an unsanitized classifier reading agent-controlled signals is
exactly the threat §7 closes).

> **Soundness (no under-call).** `∀a. C⁺(a) ⪰ c*(a)`. The classifier never assigns a class strictly
> *safer* than the truth. Over-calling (`C⁺ ≻ c*`, wasteful escalation) is permitted; under-calling
> (`C⁺ ≺ c*`, promising an undo it can't deliver) is the forbidden event.

This **mirrors the abstract-interpretation *discipline*** — `concrete ⊑ γ(abstract)`: a sound static
analysis *over-approximates* the hazard and has **no false negatives in the safety-critical direction**
(Cousot & Cousot, *Abstract Interpretation*, POPL 1977, doi:10.1145/512950.512973). Toffoli's lattice is
the recoverability chain of §2; "irreversible" is `⊤`; escalation is the conservative `⊤` answer. Where
the rules can't soundly place an action, they return `⊥` and the product joins to `⊤` — the textbook
over-approximation. What Toffoli *adopts* is that discipline (the over-approximation direction, with
every unsound corner disclosed); it does **not** claim a mechanized `concrete ⊑ γ(abstract)` proof —
there is no formal concretization γ in the code, and §4 states plainly that this is a property-tested
invariant, not a theorem. We follow the *soundiness* practice of disclosing every deliberately-unsound
corner (Livshits et al., CACM 58(2), 2015) — see §9.

**Corollary (catastrophic safety).** If `c*(a) = IRREVERSIBLE` then `C(a) ∈ {IRREVERSIBLE, ⊥}`: the floor
never *commits* to a recoverable verdict for a truly irreversible action.

A syntactic type-soundness packaging is available if desired — an ordered-monoid effect carrier `⟨Eff,
⪯, ·, 1⟩` with Progress + Subject Reduction in the over-approximation style (Dagnino, Giannini & Zucca,
*Monadic Type-and-Effect Soundness*, ECOOP 2025, Thms 42 & 45) — but Toffoli's claim is the
analysis-soundness statement above, checked as below.

---

## 4. Verification (honestly scoped)

A *verification pyramid*, with each tier's strength stated plainly:

1. **Property-based testing — what we run today.** A generator emits actions with honest metadata for a
   known class across the structural space (random ids, noise params, SQL casing, data-modifying CTEs),
   and the property `C⁺(a) ⪰ c*(a)` is checked over 600+ cases per run
   (`lib/engine/soundness.property.test.ts`, fast-check; the QuickCheck lineage, Claessen & Hughes, ICFP
   2000; metamorphic testing of classifiers, Xie et al., JSS 2011). This is a **high-coverage empirical
   check of the soundness inequality — not a proof** — but it genuinely exercises the asymmetric `⪰`
   (over-calling and abstention are witnessed by a non-vacuity assertion, not just the diagonal `===`),
   and it catches the bug class a fixed example set misses (it covers the exact CTE shape a prior review
   caught as a dangerous miss). The *verification* proper is tiers 2–3.
2. **Bounded model checking — the credible next tier.** Encode no-under-call as a **TLA⁺ state invariant**
   and the planner obligations (compensations respect dependency order; escalated set ⊇ irreversible
   remainder) as inductive invariants, exhaustively checked to scope `N` by TLC (Yu, Manolios & Lamport,
   CHARME 1999; Lamport, *Specifying Systems*, 2002). Structural DAG questions ("does any ≤N-action graph
   admit a plan running a compensation before its prerequisite?") suit **Alloy** `check` within scope
   (Jackson, *Software Abstractions*).
3. **Mechanized proof — the research-gated remainder.** A Coq/Lean proof over the operational model is
   future work, disclosed as such, not implied.

---

## 5. Multi-step recovery

A run induces a **read-after-write dependency** relation: `Aⱼ` depends on `Aᵢ` iff some entity is read
after `Aᵢ` updated it; all KLS soundness results are parameterized by `dep(·)` — the formal reason the
planner must be dependency-aware, not per-action. The undo set of `Aᵢ` is the transitive closure of its
dependents (cascading selective undo; Cass & Fernandes, TAMODIA 2006).

- **Conflict** `Conflict(Aᵢ, Aⱼ)` :⟺ `inv(Aᵢ)` does **not commute** with `Aⱼ` — "one cannot be undone
  without the other" (commutativity-based control, Weihl, IEEE TC 1988; the `Conflict()` predicate,
  Prakash & Knister, ACM TOCHI 1994). Formally it is the failure of **IP2** `T(opx, op∘inv(op)) = opx`
  (an isolated undo perturbs nothing; Sun, ACM TOCHI 2002) — and *IP2-failure detection is exactly
  no-under-call at the planner level*.
- **Ordering** is **reverse-topological** — compensate dependents before dependencies — justified by the
  causal-consistency theorem: a step is undoable iff it yields a causally-equivalent past, so undo all
  consequences first (Danos & Krivine, *Reversible Communicating Systems*, CONCUR 2004). A decidable
  sufficient condition for a sound plan is commutativity (KLS Theorem 1).
- **Partial failure** follows the saga guarantee: the system runs `T₁…Tₙ` **or** `T₁…Tⱼ, Cⱼ…C₁` —
  compensations in reverse order; backward recovery (compensate) vs forward recovery (complete via
  save-points). **Toffoli's escalation is precisely the residual where neither backward nor forward
  recovery applies.** Toffoli additionally surfaces the **dominated-by-irreversible** conflict — a
  recoverable `Aᵢ` whose effect a downstream IRREVERSIBLE `Aⱼ` consumed is escalated, not auto-undone.

---

## 6. Compensation as a derived inverse

Each op's compensation is the algebraic inverse its class dictates, synthesized from the action's effect
and recovery context, and must satisfy the KLS compensator constraints: **C1** `⟦a⟧∘⟦c⟧ = I` on entities
with no dependent read (so on an independent action `c = undo(a)` exactly), **C2** atomicity, **C3**
consistency preservation. `create⁻¹ = delete`; `update⁻¹ = restore-prior` (when the prior is in the
recovery context); a charge's compensation is a `refund` — a contra-action restoring *equivalent* state.
Each is tagged `exact` vs `semantic`.

---

## 7. Attested recovery context

§3's soundness assumes **honest metadata**. The recovery-context signals (`recoverable`, `externalized`)
are SAFE-direction — they let the classifier commit to a recoverable verdict — so if they came from the
agent's narration, a misbehaving agent could fabricate `recoverable: true` and dodge escalation. We make
the boundary cryptographic, in the **IETF RATS** vocabulary (RFC 9334): a trusted instrument is the
*Attester* that signs each recovery-context *Claim*; Toffoli is the *Relying Party*; before
classification, any safe-direction signal lacking a valid signature is stripped → the classifier sees
"unknown" → fails safe (`lib/engine/attest.ts`).

```
ACCEPT(RC) :⟺  Verify_pk(σ) ∧ fresh(n) ∧ now ∈ t ∧ independence(B,R)
¬ACCEPT  ⇒  escalate the action (one tier stricter)        — fail-closed
```

Two precise, load-bearing facts:

- **The signature must be asymmetric for any cross-trust-domain use.** An HMAC (shared secret) gives **no
  non-repudiation and no third-party verifiability** — any key-holder, including the agent if it ever sees
  the key, can forge the tag, so a verifier cannot prove to an auditor that the *backup service*, not the
  agent, made the claim. The HMAC path in the reference impl is for the degenerate single-trust-domain case
  only; the Ed25519 path is the sound default. Freshness binds a verifier-issued nonce per action (RFC
  9334 §10).
- **Crypto cannot establish INDEPENDENCE (a non-theorem).** A perfectly-signed backup on the same
  disk/credential/region the action destroys is worthless — *shared fate*. Independence is an
  *Endorsement* claim plus out-of-band audit, a fault-domain predicate the Verifier checks; it is **not**
  something a signature can establish. *Attestation is a signal, not a trust model* (RFC 9334 §8.5). This
  is encoded as an explicit assumption, not a guarantee.

(Supporting primitives, reused not invented: A2M non-equivocation, SOSP 2007; transparency logs, RFC
6962; EAT/EAR; W3C Verifiable Credentials v2.0.)

---

## 8. Novelty — precise, and what is *not* novel

> **Toffoli is, to our knowledge, the first system to *measure* reversibility as a post-hoc,
> log-grounded classification problem — reported as an honest per-class evaluation under a one-sided
> soundness objective (an action is never labeled more reversible than it truly is: the safe
> over-approximation in the chain NULLIPOTENT ⪯ REVERSIBLE ⪯ COMPENSABLE ⪯ IRREVERSIBLE) — driving a
> causal-dependency-aware restitution synthesizer with conflict detection whose irreversible remainder is
> escalated with an attested recovery context.**

**Explicitly NOT novel** (named to pre-empt the obvious objections):

- **The four-class taxonomy.** Established; *Revisable by Design* (Zhai, Li & Wang, arXiv:2604.23283, 2026)
  uses a closely parallel four-class scheme (**Idempotent**/Reversible/Compensable/Irreversible) — but typed
  at **design time**, not measured **post-hoc**. Note their least-severe class is *idempotent*, whereas
  Toffoli deliberately keeps idempotency **orthogonal** (§2) and uses *nullipotent* for the zero-effect
  bucket — so three of four class names align, not all four. Our delta is the measurement and the
  one-sided-soundness *as the metric*.
- **Dependency-aware reverse-order compensation.** Established; **RAC** (Perera et al., arXiv:2605.03409)
  rebuilds the execution graph and topologically compensates — but *registers* compensation pairs rather
  than *classifying*, and fails open ("if a compensation can't be found, RAC assumes the tool has no side
  effects"). Our planner's ordering is the standard saga/causal-consistency discipline.
- **A formally-proven safety property with undo.** Established but **different in kind**; **STRATUS**
  (Chen et al., arXiv:2506.02009) proves *Transactional No-Regression* — an *executor* monotonicity over a
  health scalar under an *assumed* faithful undo. Toffoli's soundness is *classifier* label-correctness.
- **Reversibility-aware transactional runtimes / recovery-integrity / signed audit logs.** Established —
  Atomix (arXiv:2602.14849), ACRFence (arXiv:2603.20625), agent audit-trail drafts. Our delta is binding
  attestation to the **recovery context**, not "attested logging."
- **The attestation/transparency primitives themselves** (RFC 9334/6962, A2M, W3C VC) are mature and
  reused — no new crypto primitive is claimed.

---

## 9. Threats to validity (the disclosed unsound corners)

- Soundness is *relative to* honest metadata; attestation narrows this for the safe direction but cannot
  establish channel independence (§7) nor cover a compromised instrument.
- Property-based testing is high-coverage, not exhaustive; the model check and mechanized proof are
  named remainders (§4).
- The classes discretize a continuous reversibility score; near a threshold (a refund window about to
  close) the right bucket is genuinely time-dependent, which is why ambiguous cases abstain to the judge
  rather than commit — a deliberate, disclosed soundness/precision trade.
- The accuracy numbers are on synthetic + documented-incident fixtures; real-world *prevalence* needs real
  traces and is gated behind the provenance firewall (pending).
