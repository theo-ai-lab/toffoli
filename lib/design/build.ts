/**
 * Toffoli — build the live demo pages FROM THE ENGINE. `npm run design:build`.
 *
 * The GitHub Pages demo (design/*.html) renders real engine output, not hand-written arrays:
 *
 *   · design/restitution-receipt.html — the rows, pivot, summary, verdict, and escalations are
 *     the same `restitute(run)` plan `npm run demo` prints; the methods table is the same
 *     per-class report `npm run eval` prints (gold set, deterministic floor).
 *   · design/recovery-explorer.html — the `ACTIONS` array is computed by classifying the
 *     explorer scenario (lib/design/explorer-run.ts) through the real engine.
 *   · design/index.html — the "measured" line is computed from the live eval report and the
 *     end-to-end recovery harness (`npm run recover`'s scenario).
 *
 * Each page carries marked regions (`toffoli:<name>:start/end`); everything between the markers
 * is generated, everything outside is hand-authored design. The committed pages are locked to the
 * engine by the no-drift test in lib/design/build.test.ts: if the engine's output changes, CI
 * fails until `npm run design:build` is re-run and the diff is committed — a page can never claim
 * a number the engine no longer produces.
 *
 *   npm run design:build          # regenerate design/*.html in place
 *   npm run design:check          # exit 1 if any committed page drifts from engine output
 *
 * Deterministic-only by construction: no judge is configured, so no API key is ever needed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGoldSet } from "../../dataset/schema";
import { run as demoRun } from "../demo";
import type { ActionLog, AgentAction, Classification, CompensatingAction, EvalReport, RestitutionPlan, Reversibility } from "../engine/index";
import { evaluate, restitute } from "../engine/index";
import { recoveryScenario } from "../exec/recover";
import { explorerRun } from "./explorer-run";

/** The published pages this builder owns, by basename under design/. */
export const PAGES = ["index.html", "recovery-explorer.html", "restitution-receipt.html"] as const;

/** Absolute path of the design/ directory (resolved from this module, so it works from any cwd). */
export function designDir(): string {
  return fileURLToPath(new URL("../../design/", import.meta.url));
}

// ── the injection primitive ─────────────────────────────────────────────────────

// Markers match as PREFIXES so a marker line may carry a human note after the name
// (e.g. `<!-- toffoli:index-meta:start — generated; do not edit -->`).
const MARKERS = {
  html: (name: string, edge: "start" | "end") => `<!-- toffoli:${name}:${edge}`,
  js: (name: string, edge: "start" | "end") => `/* toffoli:${name}:${edge}`,
} as const;

/**
 * Replace the lines between a region's start/end markers with `payload`. The marker lines
 * themselves are preserved. Throws unless each marker appears exactly once, in order — a
 * missing or duplicated marker is a page-authoring bug, never something to paper over.
 */
export function injectRegion(source: string, name: string, style: keyof typeof MARKERS, payload: string): string {
  const startMarker = MARKERS[style](name, "start");
  const endMarker = MARKERS[style](name, "end");
  for (const marker of [startMarker, endMarker]) {
    const count = source.split(marker).length - 1;
    if (count !== 1) throw new Error(`marker "${marker}" must appear exactly once (found ${count})`);
  }
  const startAt = source.indexOf(startMarker);
  const endAt = source.indexOf(endMarker);
  if (endAt < startAt) throw new Error(`marker "${endMarker}" appears before "${startMarker}"`);

  const afterStartLine = source.indexOf("\n", startAt) + 1;
  if (afterStartLine === 0) throw new Error(`no newline after "${startMarker}"`);
  const endLineStart = source.lastIndexOf("\n", endAt) + 1;
  if (endLineStart < afterStartLine) throw new Error(`markers for "${name}" must sit on separate lines`);
  const body = payload.length ? `${payload}\n` : "";
  return source.slice(0, afterStartLine) + body + source.slice(endLineStart);
}

// ── shared formatting helpers ───────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** JSON string literal that is safe to embed inside a <script> block. */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

function fmt(x: number | null): string {
  return x === null ? "—" : x.toFixed(2);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Wrap $-amounts in the tabular-numerals span the receipt uses. Input is escaped first. */
function markNumbers(escaped: string): string {
  return escaped.replace(/\$\d+(?:\.\d+)?/g, (m) => `<span class="num">${m}</span>`);
}

const STATE_WORD: Record<Reversibility, string> = {
  NULLIPOTENT: "no effect",
  REVERSIBLE: "restored",
  COMPENSABLE: "compensated",
  IRREVERSIBLE: "requires human",
};

const STATE_CSS: Record<Reversibility, string> = {
  NULLIPOTENT: "s-null",
  REVERSIBLE: "s-rev",
  COMPENSABLE: "s-comp",
  IRREVERSIBLE: "s-irr",
};

/**
 * The short signal qualifier shown after the tool/op — derived from the rule the engine CITED
 * (the citation invariant), never re-guessed from the raw action. Order matters: the more
 * specific fragment is checked before its prefix.
 */
const RULE_QUALIFIERS: Array<[string, string]> = [
  ["sql:ddl-destructive-with-backup", "backup recorded"],
  ["sql:ddl-destructive", "no recoverable copy"],
  ["delete:no-recoverable-copy", "no recoverable copy"],
  ["delete:recoverable-copy", "recoverable"],
  ["update:prior-state-captured", "prior captured"],
  ["update:versioned-store", "versioned"],
  ["send:external-dispatch", "externalized"],
  ["send:internal-undelivered", "undelivered"],
  ["pay:refundable-window", "in refund window"],
  ["pay:funds-withdrawn", "settled"],
  ["publish:retract-availability", "internal reach"],
  ["publish:fanned-out", "fanned out"],
  ["abstain:fail-safe-escalate", "unresolved — failed safe"],
];

function qualifierFor(c: Classification): string | null {
  for (const [frag, label] of RULE_QUALIFIERS) {
    if (c.ruleRef.includes(frag)) return label;
  }
  return null;
}

/** "db.query · SELECT count(*) FROM orders · recoverable" — the receipt's detail line. */
function detailLine(action: AgentAction, c: Classification): string {
  const parts: string[] = [action.tool];
  const sql = typeof action.params?.["sql"] === "string" ? (action.params["sql"] as string) : undefined;
  if (sql) parts.push(truncate(sql.trim(), 36));
  else if (action.op) parts.push(action.op);
  const q = qualifierFor(c);
  if (q) parts.push(q);
  return parts.join(" · ");
}

/** The compact restitution label — identical semantics to the terminal receipt's last column. */
function restitutionLabel(c: Classification, comp: CompensatingAction | undefined): string {
  if (c.class === "NULLIPOTENT") return "nothing to undo";
  if (c.class === "IRREVERSIBLE") return "escalate ↑";
  return `${comp?.method ?? "?"} (${comp?.restoration ?? "?"})`;
}

function compByActionId(plan: RestitutionPlan): Map<string, CompensatingAction> {
  return new Map(plan.compensations.map((comp) => [comp.forActionId, comp]));
}

// ── recovery-explorer.html — the ACTIONS array ──────────────────────────────────

export interface ExplorerAction {
  n: number;
  cls: Reversibility;
  lbl: string;
  restitution: string;
}

/** The explorer's per-action data, computed from the engine's plan for the scenario. */
export function explorerActions(plan: RestitutionPlan, actions: ActionLog): ExplorerAction[] {
  const comps = compByActionId(plan);
  const byId = new Map(plan.classifications.map((c) => [c.actionId, c]));
  return actions.map((a, i) => {
    const c = byId.get(a.id);
    if (!c) throw new Error(`no classification for explorer action ${a.id}`);
    return {
      n: i + 1,
      cls: c.class,
      lbl: a.effect ?? a.tool,
      restitution: restitutionLabel(c, comps.get(a.id)),
    };
  });
}

function renderExplorerData(items: ExplorerAction[]): string {
  const rows = items.map(
    (i) => `  { n: ${i.n}, cls: ${jsString(i.cls)}, lbl: ${jsString(i.lbl)}, restitution: ${jsString(i.restitution)} },`,
  );
  return ["const ACTIONS = [", ...rows, "];"].join("\n");
}

// ── restitution-receipt.html — rows, summary, escalations, methods ─────────────

/** The ledger rows with the pivot divider placed before the point of no return. */
export function renderReceiptRows(plan: RestitutionPlan, actions: ActionLog): string {
  const comps = compByActionId(plan);
  const byId = new Map(actions.map((a) => [a.id, a]));
  const GLYPH: Record<Reversibility, string> = { NULLIPOTENT: "·", REVERSIBLE: "‹", COMPENSABLE: "~", IRREVERSIBLE: "!" };
  const out: string[] = [];

  for (const c of plan.classifications) {
    const action = byId.get(c.actionId);
    if (!action) throw new Error(`no action for classification ${c.actionId}`);
    if (c.actionId === plan.summary.pivotActionId) {
      out.push(`    <div class="pivot"><span class="label">${escapeHtml(c.actionId)} — point of no return</span><span class="line"></span></div>`);
      out.push("");
    }
    const what = markNumbers(escapeHtml(action.effect ?? action.tool));
    const detail = escapeHtml(detailLine(action, c));
    const contra = contraCell(c, comps.get(c.actionId));
    out.push(`    <div class="row ${STATE_CSS[c.class]}">`);
    out.push(`      <div class="glyph">${GLYPH[c.class]}</div>`);
    out.push(`      <div class="act"><span class="id">${escapeHtml(c.actionId)}</span><div class="what">${what}</div><div class="detail">${detail}</div></div>`);
    out.push(`      <div><div class="state">${STATE_WORD[c.class]}</div><div class="contra">${contra}</div></div>`);
    out.push("    </div>");
    out.push("");
  }
  out.pop(); // no trailing blank line
  return out.join("\n");
}

function contraCell(c: Classification, comp: CompensatingAction | undefined): string {
  if (c.class === "NULLIPOTENT") return "nothing to undo";
  if (c.class === "IRREVERSIBLE") return "escalated ↑";
  if (!comp) return "?";
  const amount = comp.params?.["amountUsd"];
  const head =
    comp.method === "refund" && typeof amount === "number"
      ? `refund <span class="num">(${amount.toFixed(2)})</span> — net <span class="num">0.00</span>`
      : escapeHtml(comp.method);
  return `${head} <span class="restoration">· ${comp.restoration}</span>`;
}

function renderReceiptSummary(plan: RestitutionPlan): string {
  const s = plan.summary;
  const cell = (n: number, label: string) => `<span><span class="num">${n}</span> ${label}</span>`;
  const verdict = s.fullyRecoverable
    ? `    <div class="verdict">✓ The world can be put back automatically.</div>`
    : `    <div class="verdict bad">! A human must decide on the irreversible remainder.</div>`;
  return [
    `    <div class="summary">`,
    `      ${cell(s.total, "actions")}${cell(s.noEffect, "no-effect")}`,
    `      ${cell(s.restored, "restored")}${cell(s.compensated, "compensated")}`,
    `      ${cell(s.irreversible, "escalated")}`,
    `    </div>`,
    verdict,
  ].join("\n");
}

/** The irreversible remainder, in the plan's LIFO order (newest effect first — the saga rule). */
function renderReceiptEscalations(plan: RestitutionPlan): string {
  if (!plan.escalations.length) return "";
  const out: string[] = [
    `    <section class="escalations">`,
    `      <h2><span>Requires Human</span><span class="stamp">REQUIRES HUMAN</span></h2>`,
  ];
  for (const e of plan.escalations) {
    out.push(
      `      <div class="esc"><span class="sev">${e.severity}</span> · ${escapeHtml(e.forActionId)} — ${escapeHtml(e.decision)}<div class="why">${escapeHtml(e.reason)}</div></div>`,
    );
  }
  out.push(`    </section>`);
  return out.join("\n");
}

function renderMethods(report: EvalReport): string {
  const irr = report.perClass.find((m) => m.cls === "IRREVERSIBLE");
  const ci = report.irreversibleRecallCI;
  const rows = report.perClass.map(
    (m) => `          <tr><td>${m.cls}</td><td>${fmt(m.precision)}</td><td>${fmt(m.recall)}</td><td>${m.support}</td></tr>`,
  );
  const ciStr = ci ? `(95% CI <span class="num">${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}</span>, Wilson, n=${irr?.support ?? 0})` : `(n=${irr?.support ?? 0})`;
  return [
    `      <table>`,
    `        <thead><tr><th>class</th><th>precision</th><th>recall</th><th>support</th></tr></thead>`,
    `        <tbody>`,
    ...rows,
    `        </tbody>`,
    `      </table>`,
    `      IRREVERSIBLE recall <span class="num">${fmt(irr?.recall ?? null)}</span> ${ciStr} · catastrophic misses <span class="num">${report.dangerousMisses}</span> · committed missed-escalations <span class="num">${report.missedEscalations}</span> · reproduce: <span class="num">npm run eval</span>`,
  ].join("\n");
}

// ── index.html — the measured line ──────────────────────────────────────────────

function renderIndexMeta(report: EvalReport): string {
  const irr = report.perClass.find((m) => m.cls === "IRREVERSIBLE");
  const ci = report.irreversibleRecallCI;
  const rec = recoveryScenario(); // in-memory sandboxed World; deterministic, no I/O
  const ciStr = ci ? ` (95% CI ${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)})` : "";
  return `    <div class="meta">measured: IRREVERSIBLE recall <span class="num">${fmt(irr?.recall ?? null)}</span>${ciStr} · ${report.dangerousMisses} dangerous misses · end-to-end recovery restored ${rec.totals.restored}/${rec.totals.recoverable} · source &amp; THEORY.md in the repository</div>`;
}

// ── the page pipeline ───────────────────────────────────────────────────────────

/**
 * Regenerate every marked region. Takes and returns page contents keyed by basename — pure with
 * respect to the filesystem, so the no-drift test can assert `generatePages(committed) ===
 * committed` without touching disk.
 */
export async function generatePages(pages: Record<string, string>): Promise<Record<string, string>> {
  const [demoPlan, explorerPlan] = await Promise.all([restitute(demoRun), restitute(explorerRun)]);
  const report = evaluate(loadGoldSet({ includeIncidents: true }));

  const out: Record<string, string> = { ...pages };

  const explorer = pages["recovery-explorer.html"];
  if (explorer === undefined) throw new Error("missing page: recovery-explorer.html");
  out["recovery-explorer.html"] = injectRegion(explorer, "explorer-actions", "js", renderExplorerData(explorerActions(explorerPlan, explorerRun)));

  const receipt = pages["restitution-receipt.html"];
  if (receipt === undefined) throw new Error("missing page: restitution-receipt.html");
  let r = receipt;
  r = injectRegion(r, "receipt-rows", "html", renderReceiptRows(demoPlan, demoRun));
  r = injectRegion(r, "receipt-summary", "html", renderReceiptSummary(demoPlan));
  r = injectRegion(r, "receipt-escalations", "html", renderReceiptEscalations(demoPlan));
  r = injectRegion(r, "receipt-methods", "html", renderMethods(report));
  out["restitution-receipt.html"] = r;

  const index = pages["index.html"];
  if (index === undefined) throw new Error("missing page: index.html");
  out["index.html"] = injectRegion(index, "index-meta", "html", renderIndexMeta(report));

  return out;
}

/** CLI: regenerate in place, or `--check` to fail (exit 1) when a committed page drifts. */
export async function main(args: string[]): Promise<number> {
  const check = args.includes("--check");
  const dir = designDir();
  const current = Object.fromEntries(PAGES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const next = await generatePages(current);

  const drifted = PAGES.filter((f) => next[f] !== current[f]);
  for (const f of PAGES) {
    if (check) {
      console.log(`design:check ${f} ${drifted.includes(f) ? "DRIFT" : "ok"}`);
    } else if (drifted.includes(f)) {
      writeFileSync(join(dir, f), next[f] as string);
      console.log(`design:build ${f} updated`);
    } else {
      console.log(`design:build ${f} unchanged`);
    }
  }
  if (check && drifted.length) {
    console.error(`design:check FAILED — ${drifted.join(", ")} diverged from engine output; run \`npm run design:build\` and commit`);
    return 1;
  }
  return 0;
}

// Run only as a script (`npm run design:build`), not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
