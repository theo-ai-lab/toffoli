import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryMemory, faultSignature, type RecoveryMemoryOutcome } from "./memory";
import { runAgentLoop, scriptedModel, assistantTurn, sayText, toolUse } from "./loop";
import { seedReconcileWorld, reconcileToolSet } from "./index";
import type { AgentAction, Classification, Reversibility } from "../engine/types";

const clock = () => "2026-06-14T00:00:00Z";

// ── fixtures ────────────────────────────────────────────────────────────────────

function fakeClass(actionId: string, cls: Reversibility = "REVERSIBLE"): Classification {
  return { actionId, class: cls, idempotent: false, confidence: 1, llmAssisted: false, ruleRef: "test:rule", rationale: `${cls} for ${actionId}` };
}

function goodOutcome(classifications: Classification[], restored = classifications.length, escalated = 0): RecoveryMemoryOutcome {
  return { classifications, restored, escalated, fabricationPass: true };
}

/** A soft-delete of a recoverable db row — the shape used as the recurring fault throughout. */
function softDelete(id: string, key = `orders:${id}`): AgentAction {
  return { id, tool: "db.execute", params: { sql: `DELETE FROM orders WHERE id = '${id}'` }, target: { kind: "db.row", id: key, recoverable: true }, effect: `soft-deleted ${key}`, at: "2026-06-05T09:00:00Z" };
}

// ── the signature: shape, not identity ───────────────────────────────────────────

describe("faultSignature — keyed on the failed action SHAPE, not volatile ids/timestamps", () => {
  it("two faults of the same shape (different ids, times, values) collide to the same signature", () => {
    const a = softDelete("1001");
    const b = { ...softDelete("9999", "orders:9999"), at: "2030-01-01T00:00:00Z" };
    expect(faultSignature([a], "delete_rows")).toBe(faultSignature([b], "delete_rows"));
  });

  it("a different trigger, a different shape, or a different arity each change the signature", () => {
    const a = softDelete("1001");
    const base = faultSignature([a], "delete_rows");
    expect(faultSignature([a], "other_tool")).not.toBe(base); // trigger differs
    expect(faultSignature([a, softDelete("1003")], "delete_rows")).not.toBe(base); // arity differs
    const externalSend: AgentAction = { id: "e1", tool: "email.send", op: "send", target: { kind: "email", externalized: true }, effect: "emailed" };
    expect(faultSignature([externalSend], "delete_rows")).not.toBe(base); // action shape differs
  });
});

// ── record + recall round-trip and the asymmetric-cost guard ──────────────────────

describe("RecoveryMemory — record + recall round-trip", () => {
  it("round-trips a known-good strategy and returns null for an unknown signature", () => {
    const mem = new RecoveryMemory(":memory:", { clock });
    try {
      const sig = "sigA";
      const verdicts = [fakeClass("a1"), fakeClass("a2", "COMPENSABLE")];
      mem.record(sig, goodOutcome(verdicts, 2, 1));

      const got = mem.recall(sig);
      expect(got).not.toBeNull();
      expect(got!.classifications).toEqual(verdicts);
      expect(got!.restored).toBe(2);
      expect(got!.escalated).toBe(1);
      expect(got!.timesSeen).toBe(1);

      expect(mem.recall("never-seen")).toBeNull();
    } finally {
      mem.close();
    }
  });

  it("recall returns null for a recovery that FAILED its anti-fabrication check (never offered as known-good)", () => {
    const mem = new RecoveryMemory(":memory:", { clock });
    try {
      const sig = "sigFail";
      mem.record(sig, { classifications: [fakeClass("a1")], restored: 0, escalated: 1, fabricationPass: false });
      expect(mem.recall(sig)).toBeNull();
    } finally {
      mem.close();
    }
  });

  it("a later FAILING recovery never downgrades an already known-good strategy; it only bumps the counter", () => {
    const mem = new RecoveryMemory(":memory:", { clock });
    try {
      const sig = "sigGuard";
      const good = [fakeClass("a1")];
      mem.record(sig, goodOutcome(good)); // becomes known-good
      mem.record(sig, { classifications: [fakeClass("bogus", "IRREVERSIBLE")], restored: 0, escalated: 1, fabricationPass: false });

      const got = mem.recall(sig);
      expect(got).not.toBeNull();
      expect(got!.classifications).toEqual(good); // strategy preserved, NOT overwritten by the failure
      expect(got!.timesSeen).toBe(2); // but the recurrence was still counted
    } finally {
      mem.close();
    }
  });
});

// ── isolation per signature ───────────────────────────────────────────────────────

describe("RecoveryMemory — isolation per signature", () => {
  it("each signature recalls only its own strategy; an unrelated signature is null", () => {
    const mem = new RecoveryMemory(":memory:", { clock });
    try {
      const aVerdicts = [fakeClass("a1", "REVERSIBLE")];
      const bVerdicts = [fakeClass("b1", "COMPENSABLE"), fakeClass("b2", "IRREVERSIBLE")];
      mem.record("A", goodOutcome(aVerdicts));
      mem.record("B", goodOutcome(bVerdicts, 1, 1));

      expect(mem.recall("A")!.classifications).toEqual(aVerdicts);
      expect(mem.recall("B")!.classifications).toEqual(bVerdicts);
      expect(mem.recall("A")!.classifications).not.toEqual(mem.recall("B")!.classifications);
      expect(mem.recall("C")).toBeNull();
    } finally {
      mem.close();
    }
  });
});

// ── optional file path = durable, cross-process (hence cross-run) memory ───────────

describe("RecoveryMemory — file-backed persistence survives a reopen (cross-process)", () => {
  it("a strategy recorded by one instance is recalled by a fresh instance on the same path", () => {
    const dir = mkdtempSync(join(tmpdir(), "toffoli-mem-"));
    const path = join(dir, "memory.db");
    try {
      const writer = new RecoveryMemory(path, { clock });
      const verdicts = [fakeClass("a1")];
      writer.record("persisted", goodOutcome(verdicts));
      writer.close();

      const reader = new RecoveryMemory(path, { clock });
      try {
        expect(reader.recall("persisted")!.classifications).toEqual(verdicts);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the loop: a repeat fault is recovered from memory WITHOUT re-planning ──────────

/** A model that commits the IDENTICAL fault twice (deletes the same live row), then finishes. */
function faultTwiceModel(): ReturnType<typeof scriptedModel> {
  return scriptedModel([
    assistantTurn(sayText("first attempt"), toolUse("t1", "delete_rows", { table: "orders", ids: ["1001"] })), // FAULT: live row
    assistantTurn(sayText("repeat of the same mistake"), toolUse("t2", "delete_rows", { table: "orders", ids: ["1001"] })), // SAME fault (1001 was restored)
    assistantTurn(sayText("done"), toolUse("t3", "finish", { summary: "done" })),
  ]);
}

describe("self-healing loop — repeat-fault handling via cross-run memory", () => {
  it("the SECOND identical fault is recovered from memory, skipping the re-planning step", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"]; // prove it is fully deterministic / offline
    const mem = new RecoveryMemory(":memory:", { clock }); // injected so we can inspect it after the run
    try {
      const world = seedReconcileWorld();
      const run = await runAgentLoop({
        model: faultTwiceModel(),
        world,
        tools: reconcileToolSet(),
        goal: "delete only the test orders",
        env: {} as NodeJS.ProcessEnv,
        mode: "sandbox",
        clock,
        memory: mem,
      });

      // Two recoveries: the first cold (re-planned), the second served from memory.
      expect(run.recoveries).toHaveLength(2);
      expect(run.recoveries[0]!.fromMemory).toBe(false);
      expect(run.recoveries[0]!.classificationsReused).toBe(0);
      expect(run.recoveries[1]!.fromMemory).toBe(true);
      expect(run.recoveries[1]!.classificationsReused).toBe(1); // the one-action fault slice, reused
      expect(run.recoveries[0]!.signature).toBe(run.recoveries[1]!.signature); // same fault → same key

      // The run-level metric reflects the improvement.
      expect(run.memory.repeatFaultsHandled).toBe(1);
      expect(run.memory.classificationsAvoided).toBe(1);
      expect(run.memory.firstFaultLatencyMs).not.toBeNull();
      expect(run.memory.repeatFaultLatencyMs).not.toBeNull();

      // The recalled strategy was genuinely stored, and the fault was seen twice.
      const recalled = mem.recall(run.recoveries[0]!.signature);
      expect(recalled).not.toBeNull();
      expect(recalled!.timesSeen).toBe(2);

      // Correctness is unchanged: the live row is restored both times and the ledger nets to baseline.
      const present = new Set(Object.keys(world.snapshot().rows).map((k) => k.replace(/^orders:/, "")));
      expect(present.has("1001")).toBe(true);
      expect(world.snapshot().ledgerUsd).toBe(0);
      expect(run.finished).toBe(true);
    } finally {
      mem.close();
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("CROSS-RUN: a shared memory recovers a repeat fault on a fresh world, and stays isolated per fault shape", async () => {
    const mem = new RecoveryMemory(":memory:", { clock });
    const tools = reconcileToolSet();
    const oneFaultThenFinish = (ids: string[]) =>
      scriptedModel([
        assistantTurn(toolUse("f1", "delete_rows", { table: "orders", ids })),
        assistantTurn(toolUse("f2", "finish", { summary: "done" })),
      ]);
    const run = (ids: string[]) =>
      runAgentLoop({ model: oneFaultThenFinish(ids), world: seedReconcileWorld(), tools, goal: "g", env: {} as NodeJS.ProcessEnv, mode: "sandbox", clock, memory: mem });

    try {
      const a = await run(["1001"]); // cold: first time this shape is seen
      const b = await run(["1001", "1003"]); // different shape (2-action slice) → must NOT hit A's entry
      const c = await run(["1001"]); // identical to A → recovered from memory

      expect(a.memory.repeatFaultsHandled).toBe(0);
      expect(b.memory.repeatFaultsHandled).toBe(0); // no false hit from a different fault shape
      expect(c.memory.repeatFaultsHandled).toBe(1);

      expect(a.recoveries[0]!.signature).toBe(c.recoveries[0]!.signature);
      expect(a.recoveries[0]!.signature).not.toBe(b.recoveries[0]!.signature);
    } finally {
      mem.close();
    }
  });
});
