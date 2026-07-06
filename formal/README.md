# `formal/` — a mechanized soundness proof of the reversibility classifier

This directory contains a **Lean 4 proof** (Lean core only, no Mathlib) of Toffoli's
central safety property — the **no-under-call soundness** of the deterministic classifier,
stated in [`THEORY.md` §3](../THEORY.md) and previously disclosed as the unfinished
tier‑3 "mechanized proof" remainder in §4.

> **Soundness (no under-call).** `∀ a. C⁺(a) ⪰ c*(a)` — the classifier never assigns a
> class strictly *safer* than the truth. Over-calling (wasteful escalation) is permitted;
> under-calling (promising an undo it cannot deliver) is the forbidden event.
>
> **Corollary (catastrophic safety).** `c*(a) = IRREVERSIBLE ⟹ C⁺(a) = IRREVERSIBLE` — the
> floor never commits to a recoverable verdict for a truly irreversible action.

Both are proved, with no `sorry`. `#print axioms` reports only the standard kernel axioms
(`propext`, `Quot.sound`) — and this is **build-enforced**, not just observed:
[`Axioms.lean`](./Axioms.lean) pins the exact `#print axioms` output for every theorem and
witness with `#guard_msgs`, and is a default `lake build` target, so a `sorry` (`sorryAx`)
or a new axiom anywhere in the proofs fails the build — and with it `npm run gate` and CI.

## Layout

| File | What it is |
|---|---|
| [`ToffoliFormal.lean`](./ToffoliFormal.lean) | The model + the theorems. `Rev` (the 4‑class lattice with rank/`⪯`), `Signals`, `classifyPlus` (the total classifier with `abstain ↦ ⊤`), `TrueEffect`/`trueClass`/`observe` (the honest ground truth), `soundness`, `catastrophic_safety`, and the non‑vacuity witnesses. |
| [`Main.lean`](./Main.lean) | A `lake exe export_table` that prints the verified `classifyPlus` decision table over the full finite `Signals` space (3168 points) as JSON. |
| [`diff_check.ts`](./diff_check.ts) | The model‑vs‑bytes faithfulness check: enumerates the same space, builds the real `AgentAction`, runs the **real** `classifyDeterministic` (with `null ↦ IRREVERSIBLE`), and asserts it equals the Lean class at every point. |
| [`Axioms.lean`](./Axioms.lean) | Build-enforced axiom pins: `#guard_msgs` asserts the exact `#print axioms` output for the theorems and witnesses (kernel axioms only, no `sorryAx`). Compiled by `lake build`. |
| `lean-toolchain` / `lakefile.toml` | Pin `leanprover/lean4:v4.31.0`; declare the lib + exe. |

## Run it

```sh
# kernel-check the proof AND the axiom pins (also what `npm run proof:check` and
# the gate run) — `Axioms.lean` fails this build if any theorem picks up `sorryAx`
# or a non-kernel axiom
cd formal && lake build

# pin the Lean model to the real TS classifier over the whole Signals space
npm run proof:diff          # == tsx formal/diff_check.ts
```

`npm run gate` runs both the kernel-check and the faithfulness diff as additive gate
checks (on top of the existing recovery-soundness checks); a regression in either blocks
the build.

## What is proven — and what is NOT (the honest scope)

**Proven.** For the **operational model** of the classifier — at the **resolved-op level**,
**relative to honest metadata** per §7 — the soundness inequality and the
catastrophic-safety corollary hold for **every** input. The proof is not vacuous: `observe`
genuinely allows safe-direction signals to be *absent* even when the truth is safe (the
attestation/stripping discipline of §7), so the `⪰` is strict on some inputs (the floor
conservatively over-calls) and an exact match on others. Three strict over-call witnesses
and two exact-match witnesses are included and machine-checked; if the model had collapsed
to `trueClass = classifyPlus ∘ observe`, those strict witnesses would be unprovable.

The ground truth is defined *independently* of the classifier (`trueClass` reads the real
reversibility-determining facts: a `delete` with a genuinely independent recoverable copy
is REVERSIBLE and without one is IRREVERSIBLE; a `send` that truly externalized is
IRREVERSIBLE; a settled `pay` is IRREVERSIBLE; an `update` with no recovery context, and
`execute`/`custom`, are genuinely *opaque* to the floor — their true class is a free
parameter, and the classifier's `⊤` is sound precisely because `⊤` is the top of the
chain). So the theorem is a real correctness statement, not a tautology.

**NOT proven (disclosed, not implied):**

- **Op-resolution.** The model takes the *resolved* op as an input (`Signals.op`). It does
  **not** model the tool-name regexes / HTTP-method / SQL-verb parsing of `resolveOp` in
  `classify.ts`. If op-resolution mis-resolves an op, that is outside this proof.
- **The TS bytes — except via `diff_check.ts`.** The theorem is about the Lean model. Its
  faithfulness to the actual TypeScript of `classifyDeterministic` is established
  *empirically but exhaustively* by `diff_check.ts` over the full finite `Signals` space
  (3168 points), not by a Lean↔TS compiler-level proof. A divergence between the model and
  the code would surface there (and fail the gate), not in the kernel check.
- **The honest-metadata assumption itself.** Soundness is *relative to* §7: a present
  safe-direction signal is trusted to reflect truth. Attestation (`lib/engine/attest.ts`)
  narrows this for the safe direction but, as §7 states, cannot establish channel
  independence nor cover a compromised instrument. Those are assumptions, not theorems.
- **The planner / multi-step recovery (§5), idempotency, and the continuous score Φ.** Out
  of scope here; this proof is about the per-action classifier label only.

## How this maps to `THEORY.md`

This **discharges `THEORY.md` §4 tier‑3 ("mechanized proof — the research-gated
remainder") FOR THE MODEL.** It does *not* upgrade §3 from "analysis-soundness discipline"
to a claim of a mechanized `concrete ⊑ γ(abstract)` over the running bytes — there is still
no formal concretization `γ` in the code, and the bytes are tied in only through the
exhaustive differential check above. The honest framing of §3/§4/§9 is unchanged; what is
new is that the model-level statement is now machine-checked rather than property-tested.
