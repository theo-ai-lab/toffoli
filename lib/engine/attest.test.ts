import { describe, it, expect } from "vitest";
import { attest, verify, attestSigned, verifySigned, generateInstrumentKeypair, extractSafeClaim, sanitizeWithAttestations } from "./attest";
import { classifyDeterministic } from "./classify";
import type { AgentAction } from "./types";

const KEY = "trusted-instrument-secret";
const RUN = "run-abc";
const T0 = "2026-06-05T00:00:00Z";
const del = (): AgentAction => ({ id: "d1", tool: "s3.delete", op: "delete", target: { kind: "blob", id: "k", recoverable: true } });
const sani = (acts: AgentAction[], atts: Parameters<typeof sanitizeWithAttestations>[1]) => sanitizeWithAttestations(acts, atts, KEY, { runId: RUN });

describe("attested recovery context — the safety gate", () => {
  it("strips an UNATTESTED 'recoverable' signal → fails safe to IRREVERSIBLE", () => {
    expect(classifyDeterministic(sani([del()], [])[0]!)?.class).toBe("IRREVERSIBLE");
  });

  it("keeps a VALIDLY ATTESTED 'recoverable' signal → REVERSIBLE", () => {
    const att = attest({ actionId: "d1", claim: { recoverable: true }, runId: RUN, issuedAt: T0 }, KEY);
    expect(classifyDeterministic(sani([del()], [att])[0]!)?.class).toBe("REVERSIBLE");
  });

  it("rejects a FORGED attestation (wrong key) → fails safe", () => {
    const forged = attest({ actionId: "d1", claim: { recoverable: true }, runId: RUN, issuedAt: T0 }, "attacker-key");
    expect(classifyDeterministic(sani([del()], [forged])[0]!)?.class).toBe("IRREVERSIBLE");
  });

  it("covers EVERY safe-direction signal, not just recoverable — committed:false and transaction:open bypasses are closed", () => {
    // committed:false would falsely claim "no effect" (NULLIPOTENT); unattested → stripped → real class
    const uncommitted: AgentAction = { id: "u", tool: "db.execute", params: { sql: "DROP TABLE x" }, committed: false };
    expect(classifyDeterministic(uncommitted)?.class).toBe("NULLIPOTENT"); // before sanitize: bypassed
    expect(classifyDeterministic(sani([uncommitted], [])[0]!)?.class).toBe("IRREVERSIBLE"); // after: stripped → escalate

    // transaction:open would falsely claim rollback-ability; unattested → stripped
    const fakeTxn: AgentAction = { id: "tx", tool: "db.execute", params: { sql: "DROP TABLE x", transaction: "open" } };
    expect(classifyDeterministic(fakeTxn)?.class).toBe("REVERSIBLE"); // before: bypassed
    expect(classifyDeterministic(sani([fakeTxn], [])[0]!)?.class).toBe("IRREVERSIBLE"); // after: stripped
  });

  it("REPLAY: an attestation from another run can't downgrade this run's action", () => {
    const att = attest({ actionId: "d1", claim: { recoverable: true }, runId: "OTHER-RUN", issuedAt: T0 }, KEY);
    // valid signature, but wrong runId → not accepted for RUN → stripped → fail safe
    expect(classifyDeterministic(sani([del()], [att])[0]!)?.class).toBe("IRREVERSIBLE");
  });

  it("verify() binds claim, runId, issuer, and key into the signature", () => {
    const att = attest({ actionId: "d1", claim: { recoverable: true }, runId: RUN, issuedAt: T0, issuer: "backup-svc" }, KEY);
    expect(verify(att, KEY)).toBe(true);
    expect(verify({ ...att, claim: { recoverable: false } }, KEY)).toBe(false);
    expect(verify({ ...att, runId: "x" }, KEY)).toBe(false);
    expect(verify({ ...att, issuer: "agent" }, KEY)).toBe(false); // issuer is integrity-protected
    expect(verify(att, "wrong-key")).toBe(false);
  });

  it("extractSafeClaim names exactly the safe assertions an action makes", () => {
    expect(extractSafeClaim(del())).toEqual({ recoverable: true });
    expect(extractSafeClaim({ id: "x", tool: "email.send", op: "send", target: { kind: "email", externalized: true } })).toEqual({});
  });

  it("Ed25519 (the sound default): a validly-signed signal is kept; a forged one fails safe", () => {
    const { publicKey, privateKey } = generateInstrumentKeypair();
    const att = attestSigned({ actionId: "d1", claim: { recoverable: true }, runId: RUN, issuedAt: T0 }, privateKey);
    expect(verifySigned(att, publicKey)).toBe(true);
    const ok = sanitizeWithAttestations([del()], [att], (a) => verifySigned(a, publicKey), { runId: RUN });
    expect(classifyDeterministic(ok[0]!)?.class).toBe("REVERSIBLE");

    const other = generateInstrumentKeypair();
    const forged = attestSigned({ actionId: "d1", claim: { recoverable: true }, runId: RUN, issuedAt: T0 }, other.privateKey);
    const bad = sanitizeWithAttestations([del()], [forged], (a) => verifySigned(a, publicKey), { runId: RUN });
    expect(classifyDeterministic(bad[0]!)?.class).toBe("IRREVERSIBLE");
  });

  it("severe-direction signals need no attestation (you never attest danger)", () => {
    const send: AgentAction = { id: "s1", tool: "email.send", op: "send", target: { kind: "email", externalized: true } };
    const [sanitized] = sani([send], []);
    expect(sanitized!.target?.externalized).toBe(true);
    expect(classifyDeterministic(sanitized!)?.class).toBe("IRREVERSIBLE");
  });
});
