/**
 * Toffoli — execution mode + the ENFORCED kill-switch (the single dispatch chokepoint).
 *
 * An unattended executor is only safe if there is exactly ONE place that decides whether the world
 * may be mutated, and a kill-switch that is actually obeyed there. The Replit incident (July 2025)
 * is the cautionary case: an agent deleted a production database *during an explicit ALL-CAPS code
 * freeze* — an unenforced freeze is worthless. So the rule here is: every consequential mutation
 * passes through `effectiveMode()`, and the kill-switch forces `dry-run` regardless of what the
 * caller requested. It is checked at the chokepoint, not scattered across handlers.
 *
 * Modes (ascending authority):
 *   - dry-run  — plan and diff only; ZERO world mutation. The safe default a kill-switch forces.
 *   - sandbox  — execute against the in-memory sandbox world only. The default for a fresh deploy.
 *   - execute  — execute against a real-world adapter. Opt-in, and still gated per-action by policy.
 *
 * The mode is the operator's DECLARED target — recorded in the audit decision and paired by the caller
 * with the matching world (the in-memory `World` for `sandbox`, a real adapter like `FsWorld` for
 * `execute`). The chokepoint enforces the kill-switch and whether any mutation may happen at all; it
 * does not introspect the world's type.
 *
 * Zero dependencies.
 */

export type ExecutionMode = "dry-run" | "sandbox" | "execute";

export const MODE_ORDER: readonly ExecutionMode[] = ["dry-run", "sandbox", "execute"] as const;

/** The env flag that hard-disables all world mutation. ANY truthy value engages it. */
export const KILL_SWITCH_ENV = "TOFFOLI_EXECUTE_DISABLED";
/** The env flag that sets the default requested mode when a caller doesn't specify one. */
export const MODE_ENV = "TOFFOLI_MODE";

export interface ModeDecision {
  /** What the caller asked for (or the env default). */
  requested: ExecutionMode;
  /** What will actually happen after the kill-switch and clamps are applied. */
  effective: ExecutionMode;
  /** True iff the kill-switch forced a downgrade to dry-run. */
  killSwitchEngaged: boolean;
  /** Human-legible reason, for the audit record and the receipt. */
  reason: string;
}

function readEnv(env: NodeJS.ProcessEnv): { kill: boolean; def: ExecutionMode } {
  const killVal = env[KILL_SWITCH_ENV];
  const kill = Boolean(killVal) && killVal !== "0" && killVal!.toLowerCase() !== "false";
  const raw = env[MODE_ENV];
  const def: ExecutionMode = raw === "execute" || raw === "dry-run" || raw === "sandbox" ? raw : "sandbox";
  return { kill, def };
}

/**
 * THE CHOKEPOINT. Resolve the mode that will actually be used. The kill-switch is absolute: if it is
 * engaged, the effective mode is `dry-run` no matter what was requested. Default requested mode is
 * `sandbox` (never `execute`) — real-world mutation is always an explicit opt-in.
 *
 * `env` is injectable so the kill-switch can be verified deterministically in CI (see lib/gate.ts).
 */
export function effectiveMode(requested?: ExecutionMode, env: NodeJS.ProcessEnv = process.env): ModeDecision {
  const { kill, def } = readEnv(env);
  const req = requested ?? def;
  if (kill) {
    return {
      requested: req,
      effective: "dry-run",
      killSwitchEngaged: true,
      reason: `kill-switch ${KILL_SWITCH_ENV} engaged — forced to dry-run; zero world mutation`,
    };
  }
  return { requested: req, effective: req, killSwitchEngaged: false, reason: `mode=${req}` };
}

/** True iff the effective mode permits ANY world mutation at all. */
export function mayMutate(mode: ExecutionMode): boolean {
  return mode === "sandbox" || mode === "execute";
}
