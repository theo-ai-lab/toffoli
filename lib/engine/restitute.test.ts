import { describe, it, expect } from "vitest";
import { classifyAction, restitute } from "./restitute";
import type { ReversibilityJudge } from "./judge";
import type { AgentAction } from "./types";

const A = (over: Partial<AgentAction>): AgentAction => ({ id: "t", tool: "x", ...over });

describe("restitute orchestrator — the load-bearing safety cascade", () => {
  it("a deterministically-resolved action never calls the judge", async () => {
    let called = false;
    const judge: ReversibilityJudge = async () => {
      called = true;
      return { class: "REVERSIBLE", confidence: 1, rationale: "x" };
    };
    const c = await classifyAction(A({ op: "create" }), judge);
    expect(c.class).toBe("REVERSIBLE");
    expect(c.llmAssisted).toBe(false);
    expect(called).toBe(false);
  });

  it("a residual action with a judge is marked llmAssisted", async () => {
    const judge: ReversibilityJudge = async () => ({ class: "COMPENSABLE", confidence: 0.7, rationale: "judged" });
    const c = await classifyAction(A({ op: "execute" }), judge);
    expect(c.class).toBe("COMPENSABLE");
    expect(c.llmAssisted).toBe(true);
    expect(c.ruleRef).toContain("llm-judge");
  });

  it("a residual action with NO judge FAILS SAFE to IRREVERSIBLE", async () => {
    const c = await classifyAction(A({ op: "execute" }));
    expect(c.class).toBe("IRREVERSIBLE");
    expect(c.confidence).toBe(0);
    expect(c.ruleRef).toContain("fail-safe");
  });

  it("a judge that throws FAILS SAFE to IRREVERSIBLE (never swallows the residual)", async () => {
    const judge: ReversibilityJudge = async () => {
      throw new Error("model refused");
    };
    const c = await classifyAction(A({ op: "execute" }), judge);
    expect(c.class).toBe("IRREVERSIBLE");
    expect(c.ruleRef).toContain("fail-safe");
  });

  it("plans a whole run", async () => {
    const plan = await restitute([
      A({ id: "a", op: "create" }),
      A({ id: "b", tool: "email.send", op: "send", target: { kind: "email", externalized: true } }),
    ]);
    expect(plan.summary.restored).toBe(1);
    expect(plan.summary.irreversible).toBe(1);
    expect(plan.summary.fullyRecoverable).toBe(false);
  });
});
