import { describe, it, expect } from "vitest";
import { restitute } from "./engine/index";
import { run, renderReceipt } from "./demo";

describe("golden restitution receipt (end-to-end, deterministic-only)", () => {
  it("renders the canonical run with the expected outcome", async () => {
    const plan = await restitute(run); // no judge → deterministic-only, fully reproducible
    const receipt = renderReceipt(plan, run);
    expect(receipt).toContain("TOFFOLI — RESTITUTION RECEIPT");
    expect(receipt).toContain("PIVOT     a5 — point of no return");
    expect(receipt).toContain("1 no-effect  ·  2 restored  ·  1 compensated  ·  2 escalated");
    expect(plan.summary.fullyRecoverable).toBe(false);
    expect(receipt).toMatchSnapshot();
  });
});
