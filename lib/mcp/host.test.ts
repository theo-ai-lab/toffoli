import { describe, expect, it } from "vitest";
import { runReconcileHost } from "./host";

/**
 * End-to-end coverage of the agent host: it SPAWNS the real MCP server (lib/mcp/server.ts) as a
 * child process and drives it over genuine stdio, with the server's recovery world backed by a real
 * on-disk FsWorld shared with the host. These are true cross-process round trips, not in-process
 * shims — so they prove the OS-level transport, the FsWorld entrypoint wiring, and that recovery
 * actually mutates the shared backend. ANTHROPIC_API_KEY is blanked in the child so the run is fully
 * offline/deterministic regardless of the ambient environment.
 */
const HERMETIC_ENV: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "" };

describe("MCP agent host — real subprocess round trip over a shared FsWorld", () => {
  it("recovers an over-broad bulk delete on the real backend and completes the task", async () => {
    const r = await runReconcileHost({ quiet: true, serverEnv: HERMETIC_ENV });

    // A live server with exactly the three Toffoli tools.
    expect(r.serverName).toBe("toffoli-mcp");
    expect(r.toolNames).toEqual(["toffoli.checkpoint", "toffoli.classify", "toffoli.recover"]);

    // checkpoint saw the seeded live system.
    expect(r.baselineRows).toBe(5);

    // classify: 5 recoverable deletes + 1 compensable charge + 1 irreversible email — over the wire.
    const classes = r.classifications.map((c) => c.class);
    expect(classes.filter((c) => c === "REVERSIBLE")).toHaveLength(5);
    expect(classes.filter((c) => c === "COMPENSABLE")).toHaveLength(1);
    expect(classes.filter((c) => c === "IRREVERSIBLE")).toHaveLength(1);
    expect(r.classifications.filter((c) => c.requiresHuman)).toHaveLength(1);
    expect(r.classifications.every((c) => c.judged === false)).toBe(true); // deterministic-only

    // recover plan-only: a full plan + a confirm token, mutating nothing.
    expect(r.planOnly.phase).toBe("plan-only");
    expect(r.planOnly.plannedSteps).toBe(6); // 5 restores + 1 refund
    expect(r.planOnly.escalations).toBe(1); // the email
    expect(r.planOnly.confirmToken).toMatch(/^[0-9a-f]{32}$/);

    // recover execute: the recoverable subset is genuinely restored ON DISK and matches the checkpoint.
    expect(r.executed.phase).toBe("executed");
    expect(r.executed.effectiveMode).toBe("execute");
    expect(r.executed.killSwitchEngaged).toBe(false);
    expect(r.executed.restored).toBe(6);
    expect(r.executed.escalated).toBe(1);
    expect(r.executed.fabricationPass).toBe(true);
    expect(r.executed.recoverableMatchesCheckpoint).toBe(true);

    // goal end-state, verified on the real shared disk after the corrected retry.
    expect(r.final.liveRowsPresent).toBe(true);
    expect(r.final.testRowsGone).toBe(true);
    expect(r.final.ledgerNetZero).toBe(true);
    expect(r.final.emailStillSent).toBe(true);

    expect(r.taskSuccess).toBe(true);
  }, 60_000);

  it("honors the kill-switch: the server forces dry-run and the host claims NO recovery (no fakery)", async () => {
    const r = await runReconcileHost({ quiet: true, serverEnv: { ...HERMETIC_ENV, TOFFOLI_EXECUTE_DISABLED: "1" } });

    // The plan is still produced and the irreversible email still escalates...
    expect(r.planOnly.plannedSteps).toBe(6);
    expect(r.planOnly.escalations).toBe(1);

    // ...but execution is forced to dry-run: nothing restored, no fabricated success.
    expect(r.executed.killSwitchEngaged).toBe(true);
    expect(r.executed.phase).toBe("plan-only");
    expect(r.executed.effectiveMode).toBe("dry-run");
    expect(r.executed.restored).toBe(0);
    expect(r.executed.fabricationPass).toBe(true); // honest: zero claimed restorations is consistent
    expect(r.executed.recoverableMatchesCheckpoint).toBe(false);

    // The host honestly reports the goal was NOT achieved (live rows stay deleted).
    expect(r.final.liveRowsPresent).toBe(false);
    expect(r.final.emailStillSent).toBe(true); // the irreversible send is never auto-undone
    expect(r.taskSuccess).toBe(false);
  }, 60_000);
});
