# Deterministic-first receding-horizon planning

The full write-up for `npm run plan` — the README carries the three-line summary; this is the deep
dive, part of the [research & systems index](README.md).

---

**Deterministic-first receding-horizon planning** ([`lib/runtime/horizon-planner.ts`](../lib/runtime/horizon-planner.ts),
`npm run plan`) takes the same floor and turns it into a *planner's safety filter* — the most forward-looking
use of the engine. Learned-verifier-guided search (LLM tree search, process/outcome reward value functions)
puts the expensive component on the **scoring** side: a model is evaluated at every node to estimate how good
a partial plan is. This controller **inverts that cost curve**. It (a) *proposes* candidate action sequences
toward a goal, (b) at **stage 1** prunes them with the deterministic reversibility classifier as an **exact,
zero-model-spend feasibility filter** — any plan that would take an IRREVERSIBLE action, or one the floor
*abstains* on, is dropped *before* anything is scored — (c) at **stage 2** scores the survivors with a
**deterministic objective** (goal-progress minus an irreversibility/blast-radius cost), (d) executes exactly
**one** step through the existing speculative gate (which itself routes a rejected fire back through
`safeExecute`), then **re-observes and re-plans** (receding horizon). The catastrophic branch is eliminated
*for free*, the inverse of paying a learned verifier to probabilistically notice it.

It is **a demonstration harness, not a deployed planner**: the action library is small and the objective is
hand-specified. What it shows, by really running, is narrow and verifiable — on a fixed billing-close
scenario the stage-1 filter prunes every plan containing the one-step `DROP TABLE` shortcut *for free*, the
deterministic objective then prefers the **reversible** local-snapshot route over the equal-progress
**compensable** vendor charge, the controller reaches the goal in reversible steps with **0 irreversible
actions ever executed**, it **adapts** when an unmodeled disturbance (a late-arriving row) makes the observed
state diverge from the prediction, and the **entire executed trajectory is undone through `safeExecute` back
to the pre-episode baseline** — the payoff of the stage-1 prune: everything it did was recoverable. Where a
learned value function *would* plug in is the stage-2 objective seam; the default objective is deterministic
on purpose (zero spend, fully reproducible).
