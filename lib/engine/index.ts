/** Toffoli engine — public surface. */

export * from "./types";
export { classifyDeterministic } from "./classify";
export { plan } from "./plan";
export { buildDependencyGraph, type DependencyGraph, type DepEdge, type Conflict } from "./graph";
export { planResumable, type ResumablePlan, type RecoveryStep } from "./resumable";
export { attest, verify, attestSigned, verifySigned, generateInstrumentKeypair, extractSafeClaim, sanitizeWithAttestations, type RecoveryAttestation, type RecoveryClaim, type AttestArgs } from "./attest";
export { classifyAction, restitute, type RestituteOptions } from "./restitute";
export { claudeJudge, isJudgeAvailable, type ReversibilityJudge, type JudgeVerdict, type ClaudeJudgeOptions } from "./judge";
export { evaluate, CLASSES, type EvalReport, type ClassMetric } from "./metrics";
