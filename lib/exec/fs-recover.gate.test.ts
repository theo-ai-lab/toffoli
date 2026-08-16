/**
 * The release gate must consult the WORLD, not the executor's account of itself.
 *
 * `fabricationCheck` compares what the executor REPORTED against what the executor WROTE TO ITS OWN
 * JOURNAL. Both are the same witness. An executor that believes it compensated — because its action
 * ids, its journal keys, or its idempotency keys are wrong — reports "restored", writes a matching
 * journal entry, and passes. The disk never moved. That is not hypothetical here: it is the defect
 * fixed in d6d7472, where FsWorld allocated action ids from an ephemeral counter, so a reopened root
 * produced a compensation that was reported, journal-confirmed, and never applied.
 *
 * `npm run gate` did not and could not catch it: the gate runs `recoveryScenario` (the in-memory
 * world) and never once calls `fsRecoveryScenario`, so the real adapters where that class of bug
 * lives were outside the thing that decides whether this ships.
 *
 * A world that returns `true` from every compensating method without touching disk is that failure,
 * staged. The executor and its journal agree perfectly; only a before/after comparison of the actual
 * filesystem and database can tell. This is the negative control the gate's own comment demands:
 * "a check that only observes a healthy run passes both when the invariant holds and when the
 * mechanism that enforces it has been gutted".
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRecoveryScenario, LyingFsWorld } from "./fs-recover";

describe("the on-disk comparison is what catches a lying executor", () => {
  it("an honest run restores the real world and replays idempotently", () => {
    const report = fsRecoveryScenario();
    expect(report.recoverableRestored).toBe(true);
    expect(report.idempotentOnReplay).toBe(true);
  });

  it("DETECTOR — a world that reports success without touching disk is caught", () => {
    const root = mkdtempSync(join(tmpdir(), "toffoli-lying-"));
    try {
      // A factory, not an instance: the scenario builds a SECOND world to replay the plan over the
      // same root, and a detector that only lied on the first pass would be a weaker control.
      const report = fsRecoveryScenario({ root, makeWorld: (r) => new LyingFsWorld(r) });

      // The executor's own account is spotless: it reports restorations and its journal confirms
      // every one of them. This is exactly what the current gate checks, and it passes.
      expect(report.result.restored).toBeGreaterThan(0);
      expect(report.result.fabricationCheck.pass).toBe(true);

      // The disk disagrees. Only asking the world reveals it.
      expect(report.recoverableRestored).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
