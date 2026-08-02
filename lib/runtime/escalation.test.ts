import { describe, expect, it, vi } from "vitest";
import {
  ConsoleSink,
  InMemorySink,
  MultiSink,
  type EscalationSink,
  type OversightRecord,
} from "./escalation.js";

const record = (over: Partial<OversightRecord> = {}): OversightRecord =>
  ({
    kind: "compensation-failed",
    severity: "high",
    forActionId: "act-1",
    decision: "needs a human",
    at: "2026-08-02T00:00:00.000Z",
    ...over,
  }) as OversightRecord;

describe("MultiSink — a failing sink never blocks the others", () => {
  it("delivers to every sink even when one throws", async () => {
    // The whole reason MultiSink exists is that an escalation must not be lost
    // because one transport is down. Without this, a throwing console sink
    // would swallow the durable-queue delivery sitting behind it in the array.
    const before = new InMemorySink();
    const after = new InMemorySink();
    const exploding: EscalationSink = {
      emit() {
        throw new Error("transport down");
      },
    };

    const multi = new MultiSink([before, exploding, after]);
    await multi.emit(record());

    expect(before.depth()).toBe(1);
    expect(after.depth()).toBe(1);
  });

  it("does not reject when every sink fails", async () => {
    // A caller emitting an escalation is already on a failure path. If emit()
    // rejected, the original failure would be replaced by this one.
    const multi = new MultiSink([
      {
        emit() {
          throw new Error("a");
        },
      },
      {
        emit() {
          return Promise.reject(new Error("b"));
        },
      },
    ]);

    await expect(multi.emit(record())).resolves.toBeUndefined();
  });

  it("awaits async sinks rather than firing and forgetting", async () => {
    let settled = false;
    const slow: EscalationSink = {
      emit: () =>
        new Promise<void>((res) => {
          setTimeout(() => {
            settled = true;
            res();
          }, 5);
        }),
    };

    await new MultiSink([slow]).emit(record());
    // If emit returned before the sink finished, an escalation could be lost to
    // a process that exits immediately after reporting it.
    expect(settled).toBe(true);
  });
});

describe("InMemorySink", () => {
  it("reports depth and filters by severity", () => {
    const sink = new InMemorySink();
    sink.emit(record({ severity: "low" }));
    sink.emit(record({ severity: "critical" }));
    sink.emit(record({ severity: "critical" }));

    expect(sink.depth()).toBe(3);
    expect(sink.bySeverity("critical")).toHaveLength(2);
    expect(sink.bySeverity("high")).toHaveLength(0);
  });
});

describe("ConsoleSink", () => {
  it("writes the severity, kind and action id so an escalation is never invisible", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      new ConsoleSink().emit(record({ severity: "critical", forActionId: "act-42" }));
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]?.[0]);
      expect(line).toContain("CRITICAL");
      expect(line).toContain("compensation-failed");
      expect(line).toContain("act-42");
    } finally {
      spy.mockRestore();
    }
  });
});
