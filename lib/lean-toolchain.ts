/**
 * Toffoli — Lean/elan toolchain detection for the recovery-soundness gate.
 *
 * `npm run gate` and `npm run proof:check` kernel-check the Lean 4 soundness proof via `lake`.
 * When the toolchain is absent the gate should say HOW to install it — a stranger who runs
 * `npm run gate` with no elan on PATH otherwise gets an opaque "Command failed: lake build"
 * with no actionable hint. Pure and side-effect-free (except the PATH probe), so it is unit-tested
 * directly; the gate script imports it in its proof-check catch.
 */

import { execSync } from "node:child_process";

/**
 * The one-liner that installs elan (the Lean 4 toolchain manager). Lean itself is fetched on the
 * first `lake build`, pinned by formal/lean-toolchain. Mirrors the install step in
 * .github/workflows/recovery-gate.yml so the local hint and CI stay in lockstep.
 */
export const ELAN_INSTALL = "curl -fsSL https://elan.lean-lang.org/elan-init.sh | sh -s -- -y --default-toolchain stable";

/** True when a `lake` binary resolves on PATH for the given environment. */
export function lakeOnPath(env: NodeJS.ProcessEnv): boolean {
  try {
    execSync(process.platform === "win32" ? "where lake" : "command -v lake", { env, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Actionable message shown when the proof gate can't run because the Lean toolchain is missing. */
export function leanMissingHint(): string {
  return `Lean 4 toolchain not found — the proof gate needs \`lake\` (only \`npm run gate\` / \`npm run proof:check\` require it). Install elan, then re-run:\n      ${ELAN_INSTALL}`;
}
