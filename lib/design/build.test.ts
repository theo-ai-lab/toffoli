import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { restitute } from "../engine/index";
import {
  PAGES,
  designDir,
  explorerActions,
  generatePages,
  injectRegion,
  renderReceiptRows,
} from "./build";
import { explorerRun } from "./explorer-run";

// ── the injection primitive ─────────────────────────────────────────────────────

describe("injectRegion", () => {
  const doc = ["<p>keep</p>", "<!-- toffoli:x:start -->", "old", "<!-- toffoli:x:end -->", "<p>keep too</p>", ""].join("\n");

  it("replaces only the region between the markers", () => {
    const out = injectRegion(doc, "x", "html", "new line 1\nnew line 2");
    expect(out).toContain("<p>keep</p>");
    expect(out).toContain("<p>keep too</p>");
    expect(out).toContain("new line 1\nnew line 2");
    expect(out).not.toContain("old");
  });

  it("is idempotent — injecting the same payload twice is a fixed point", () => {
    const once = injectRegion(doc, "x", "html", "payload");
    expect(injectRegion(once, "x", "html", "payload")).toBe(once);
  });

  it("throws when the start marker is missing", () => {
    expect(() => injectRegion("<p>no markers</p>", "x", "html", "p")).toThrow(/toffoli:x:start/);
  });

  it("throws when a marker appears more than once", () => {
    expect(() => injectRegion(`${doc}\n${doc}`, "x", "html", "p")).toThrow(/exactly once/);
  });

  it("throws when the end marker precedes the start marker", () => {
    const bad = ["<!-- toffoli:x:end -->", "mid", "<!-- toffoli:x:start -->", ""].join("\n");
    expect(() => injectRegion(bad, "x", "html", "p")).toThrow(/before/);
  });
});

// ── the explorer scenario must be fully deterministic (no judge, no fail-safe) ──

describe("explorer scenario", () => {
  it("classifies every action with a committed deterministic rule (no abstention, no judge)", async () => {
    const plan = await restitute(explorerRun); // no judge configured
    for (const c of plan.classifications) {
      expect(c.llmAssisted).toBe(false);
      expect(c.confidence).toBe(1); // the fail-safe reports confidence 0 — any 0 here means a rule abstained
      expect(c.ruleRef).not.toContain("abstain:fail-safe-escalate");
    }
  });

  it("produces the storyboard the explorer windows: classes, pivot, and restitutions from the engine", async () => {
    const plan = await restitute(explorerRun);
    const items = explorerActions(plan, explorerRun);
    expect(items.map((i) => i.cls)).toEqual([
      "NULLIPOTENT",
      "REVERSIBLE",
      "REVERSIBLE",
      "COMPENSABLE",
      "COMPENSABLE",
      "IRREVERSIBLE",
      "IRREVERSIBLE",
      "REVERSIBLE",
    ]);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Restitution labels come from the planner's compensations, not hand-written strings.
    expect(items[1]?.restitution).toBe("delete (exact)");
    expect(items[3]?.restitution).toBe("refund (semantic)");
    expect(items[5]?.restitution).toBe("escalate ↑");
    expect(items[0]?.restitution).toBe("nothing to undo");
    // The pivot the page derives (earliest IRREVERSIBLE) is a6.
    expect(plan.summary.pivotActionId).toBe(explorerRun[5]?.id);
  });
});

// ── receipt row rendering invariants ────────────────────────────────────────────

describe("renderReceiptRows", () => {
  it("places the pivot divider immediately before the pivot action's row", async () => {
    const { run } = await import("../demo");
    const plan = await restitute(run);
    const html = renderReceiptRows(plan, run);
    const pivotAt = html.indexOf('class="pivot"');
    const pivotRowAt = html.indexOf(`>${plan.summary.pivotActionId}<`);
    expect(pivotAt).toBeGreaterThan(-1);
    expect(pivotRowAt).toBeGreaterThan(pivotAt);
    // one row per classification
    expect(html.match(/class="row s-/g)?.length).toBe(plan.classifications.length);
  });

  it("escapes HTML metacharacters from the action log", async () => {
    const plan = await restitute([
      { id: "z1", tool: "db.query", params: { sql: "SELECT * FROM t WHERE a < 1 & b > 2" }, effect: 'read <script>"x"&y</script>' },
    ]);
    const html = renderReceiptRows(plan, [
      { id: "z1", tool: "db.query", params: { sql: "SELECT * FROM t WHERE a < 1 & b > 2" }, effect: 'read <script>"x"&y</script>' },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});

// ── THE NO-DRIFT LOCK ───────────────────────────────────────────────────────────
// The committed pages must be byte-identical to what the engine generates right now.
// If this fails: run `npm run design:build` and commit the result — never hand-edit
// the generated regions.

describe("no drift: committed design pages equal live engine output", () => {
  it("regenerating every page from the engine is a fixed point of the committed files", async () => {
    const dir = designDir();
    const current = Object.fromEntries(PAGES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const next = await generatePages(current);
    for (const f of PAGES) {
      expect(next[f], `${f} drifted from engine output — run \`npm run design:build\` and commit`).toBe(current[f]);
    }
  });
});
