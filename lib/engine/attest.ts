/**
 * Toffoli — attested recovery context (the safety mechanism).
 *
 * The engine commits to a recoverable verdict only on SAFE-direction signals. If those came from the
 * agent's own narration, a misbehaving agent could fabricate them and dodge escalation. So a trusted
 * instrument that observed the real system signs each recovery-context Claim; before classification,
 * any safe-direction signal lacking a valid signature is STRIPPED → the classifier sees "unknown" →
 * fails safe. (IETF RATS roles, RFC 9334: instrument = Attester, Toffoli = Relying Party.)
 *
 * COVERAGE — every safe-direction signal the classifier reads is gated, not just two:
 *   recoverable=true · externalized=false · priorState present · committed=false · transaction="open".
 *
 * SCHEMES:
 *   - `attestSigned`/`verifySigned` — Ed25519 (the sound default). Required across trust domains:
 *     non-repudiation + third-party verifiability a shared secret can't give.
 *   - `attest`/`verify` — HMAC-SHA256, the single-trust-domain reference only (any key-holder can forge).
 *
 * FRESHNESS: each attestation binds a `runId` (and a signed `issuedAt`); a verifier supplies the
 * expected runId, so an attestation from one run can't be replayed to downgrade another run's action.
 *
 * NON-THEOREM: crypto establishes authenticity + freshness, NOT channel independence (shared fate) —
 * a signed backup on the same disk the action destroys is worthless. Independence is an Endorsement +
 * out-of-band audit, not something a signature proves ("attestation is a signal, not a trust model",
 * RFC 9334 §8.5). Uses only Node's built-in crypto.
 */

import { createHmac, timingSafeEqual, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { AgentAction } from "./types";

/** Each field, when `true`, attests one safe-direction assertion about the action. */
export interface RecoveryClaim {
  recoverable?: boolean; // an independent recoverable copy exists
  notExternalized?: boolean; // the effect did NOT cross a trust boundary
  hasPriorState?: boolean; // the prior value is captured
  uncommitted?: boolean; // the action did not durably commit
  inOpenTransaction?: boolean; // the action is inside a roll-back-able transaction
}

export interface RecoveryAttestation {
  actionId: string;
  runId: string;
  issuedAt: string; // ISO 8601, signed (for audit + optional freshness-window checks)
  issuer: string;
  claim: RecoveryClaim;
  sig: string; // hex (HMAC) or base64 (Ed25519)
  scheme?: "hmac" | "ed25519";
}

/** Injective canonical encoding (JSON array of a fixed tuple — strings are quoted/escaped, so no
 *  delimiter ambiguity). All identity + freshness + claim fields are bound into the signature. */
function canonical(att: Pick<RecoveryAttestation, "actionId" | "runId" | "issuedAt" | "issuer" | "claim">): string {
  const c = att.claim;
  return JSON.stringify([
    "toffoli.recovery.v2",
    att.actionId,
    att.runId,
    att.issuedAt,
    att.issuer,
    c.recoverable === true,
    c.notExternalized === true,
    c.hasPriorState === true,
    c.uncommitted === true,
    c.inOpenTransaction === true,
  ]);
}

export interface AttestArgs {
  actionId: string;
  claim: RecoveryClaim;
  runId: string;
  issuedAt: string;
  issuer?: string;
}

// ── HMAC (single-trust-domain reference) ──
export function attest(args: AttestArgs, key: string): RecoveryAttestation {
  const att = { ...args, issuer: args.issuer ?? "trusted-instrument" };
  const sig = createHmac("sha256", key).update(canonical(att)).digest("hex");
  return { ...att, sig, scheme: "hmac" };
}

export function verify(att: RecoveryAttestation, key: string): boolean {
  const expected = createHmac("sha256", key).update(canonical(att)).digest("hex");
  const a = Buffer.from(att.sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ── Ed25519 (the sound default; verifiers hold only the public key) ──
export function generateInstrumentKeypair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

export function attestSigned(args: AttestArgs, privateKey: KeyObject): RecoveryAttestation {
  const att = { ...args, issuer: args.issuer ?? "trusted-instrument" };
  const sig = cryptoSign(null, Buffer.from(canonical(att)), privateKey).toString("base64");
  return { ...att, sig, scheme: "ed25519" };
}

export function verifySigned(att: RecoveryAttestation, publicKey: KeyObject): boolean {
  try {
    return cryptoVerify(null, Buffer.from(canonical(att)), publicKey, Buffer.from(att.sig, "base64"));
  } catch {
    return false;
  }
}

/** The safe-direction assertions an action's metadata currently makes (what must be attested). */
export function extractSafeClaim(a: AgentAction): RecoveryClaim {
  const t = a.target;
  const claim: RecoveryClaim = {};
  if (t?.recoverable === true) claim.recoverable = true;
  if (t?.externalized === false) claim.notExternalized = true;
  if (t && t.priorState !== undefined) claim.hasPriorState = true;
  if (a.committed === false) claim.uncommitted = true;
  if (a.params?.["transaction"] === "open") claim.inOpenTransaction = true;
  return claim;
}

/**
 * Strip every safe-direction signal not backed by a valid attestation for the expected run, so the
 * classifier fails safe. Severe-direction signals are preserved (you never attest danger).
 */
export function sanitizeWithAttestations(
  actions: AgentAction[],
  attestations: RecoveryAttestation[],
  verifier: string | ((att: RecoveryAttestation) => boolean),
  opts: { runId: string },
): AgentAction[] {
  const check = typeof verifier === "string" ? (a: RecoveryAttestation) => verify(a, verifier) : verifier;
  const valid = attestations.filter((a) => a.runId === opts.runId && check(a));

  return actions.map((action) => {
    const atts = valid.filter((a) => a.actionId === action.id);
    const attested = (k: keyof RecoveryClaim) => atts.some((a) => a.claim[k] === true);

    let out = action;
    const t = action.target ? { ...action.target } : undefined;
    let tChanged = false;
    if (t?.recoverable === true && !attested("recoverable")) { delete t.recoverable; tChanged = true; }
    if (t?.externalized === false && !attested("notExternalized")) { delete t.externalized; tChanged = true; }
    if (t && t.priorState !== undefined && !attested("hasPriorState")) { delete t.priorState; tChanged = true; }
    if (tChanged) out = { ...out, target: t };

    if (action.committed === false && !attested("uncommitted")) out = { ...out, committed: true }; // strip "no effect"
    if (action.params?.["transaction"] === "open" && !attested("inOpenTransaction")) {
      const params = { ...action.params };
      delete params["transaction"];
      out = { ...out, params };
    }
    return out;
  });
}
