/**
 * Toffoli — dataset loader + validation.
 *
 * Loads the labeled gold set from JSONL and validates each row against the engine
 * contract, so a typo in the data fails loudly rather than skewing a metric. The
 * contract types live in lib/engine/types.ts; this file only adds runtime validation
 * and the provenance-firewall-aware loaders.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isHeadlineEligible } from "../lib/engine/types";
import type { GroundTruthSample } from "../lib/engine/types";

const here = dirname(fileURLToPath(import.meta.url));

const Reversibility = z.enum(["NULLIPOTENT", "REVERSIBLE", "COMPENSABLE", "IRREVERSIBLE"]);

const ActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  op: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  target: z
    .object({
      kind: z.string(),
      id: z.string().optional(),
      priorState: z.unknown().optional(),
      recoverable: z.boolean().optional(),
      externalized: z.boolean().optional(),
    })
    .optional(),
  idempotencyKey: z.string().nullable().optional(),
  effect: z.string().optional(),
  at: z.string().optional(),
  committed: z.boolean().optional(),
});

const SampleSchema = z.object({
  id: z.string(),
  action: ActionSchema,
  target: z.object({ class: Reversibility }),
  meta: z.object({
    provenance: z.enum(["synthetic-seed", "documented-incident", "self-run"]),
    notes: z.string().optional(),
    source: z.string().optional(),
  }),
});

/** Parse one JSONL file into validated samples, with file:line context on failure. */
export function loadJsonl(file: string): GroundTruthSample[] {
  const text = readFileSync(join(here, file), "utf8");
  const out: GroundTruthSample[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      out.push(SampleSchema.parse(JSON.parse(line)) as unknown as GroundTruthSample);
    } catch (err) {
      throw new Error(`${file}:${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Load the labeled gold set. Synthetic fixtures always; documented incidents when
 * requested and present. NOTE the provenance firewall: this set measures the
 * CLASSIFIER's accuracy, never real-world PREVALENCE — that number is gated to
 * `self-run` rows only and is pending. See lib/engine/types.ts.
 */
export function loadGoldSet(opts: { includeIncidents?: boolean } = {}): GroundTruthSample[] {
  const rows = loadJsonl("ground-truth.seed.jsonl");
  if (opts.includeIncidents) {
    try {
      rows.push(...loadJsonl("incidents.jsonl"));
    } catch {
      /* incidents file optional */
    }
  }
  return rows;
}

/**
 * The ONLY supported way to obtain rows for a PREVALENCE headline — it filters through the
 * firewall by construction, so synthetic and documented-incident rows can never reach a reported
 * rate. Returns [] until real `self-run` captures exist (`dataset/captured.jsonl`, gitignored).
 */
export function loadHeadlineEligible(): GroundTruthSample[] {
  return loadGoldSet({ includeIncidents: true }).filter(isHeadlineEligible);
}
