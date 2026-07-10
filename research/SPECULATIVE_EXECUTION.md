# Reversibility-gated speculative execution

The full write-up for `npm run speculate` — the README carries the three-line summary; this is the
deep dive, part of the [research & systems index](README.md).

---

**Reversibility-gated speculative execution** ([`lib/runtime/speculative-gate.ts`](../lib/runtime/speculative-gate.ts),
`npm run speculate`) turns the floor into a *speedup*. For an action the deterministic classifier rates
REVERSIBLE or COMPENSABLE, Toffoli fires it **optimistically** in parallel with the slow
permission-oracle/policy check, **commits** on agreement, and on rejection **rolls it back through the
same restitution path** — verified back to the pre-fire baseline. The IRREVERSIBLE class and any
abstention are **provably never speculated** (fail-closed, unchanged), and the kill-switch still fires
nothing. This is the *Speculative Actions* lossless framework
([arXiv:2510.04371](https://arxiv.org/abs/2510.04371)) and Sherlock's speculate-then-verify
([arXiv:2511.00330](https://arxiv.org/abs/2511.00330)) with the safety envelope made *provable* rather
than heuristic: the only effects ever fired on a guess are exactly those a restitution can undo.

It is a deterministic-vs-deterministic cascade, so the measurement costs **zero model spend**. Measured
over a fixed 12-action scenario (a synthetic fixture spanning every class — not a prevalence claim):
**the deterministic fast path resolves 75% of actions losslessly (speculate-and-commit or read-only).
Of the remaining 25%, the authoritative policy/oracle tier is genuinely load-bearing for just 8.3% — the
single over-cap charge whose optimistic guess it overrode and rolled back (exactly the
classifier-vs-authority disagreement rate); the other 16.7% are the two IRREVERSIBLE sends the cheap
reversibility floor itself fails closed on and escalates — never speculated regardless of the
authoritative verdict. 0 lossless violations and 0 irreversible actions ever fired on a guess** — cascade
boundary `reversibility-classifier → permission-oracle/policy`, regime *model-free/provable* (no model is
consulted), residual locus *per-action*. Whether speculation *pays off* is calibrated, never a magic constant: a break-even
acceptance rate is derived from the operator's cost model, and a class is speculated only when its
one-sided Wilson lower bound (Bonferroni-corrected across classes, conservative at small n) clears it.
