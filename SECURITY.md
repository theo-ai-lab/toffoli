# Security Policy

Toffoli is an undo/restitution engine that can be asked to act on real systems, so its security
posture matters. The defensive controls are documented and tested in [`SAFETY.md`](SAFETY.md) and
`lib/runtime/`.

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue for a vulnerability.

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" in the
  repository's **Security** tab), which opens a private advisory thread with the maintainer.

When reporting, include: affected version/commit, a description, reproduction steps or a proof of
concept, and the impact you observed. You'll get an acknowledgement, and a fix or mitigation plan
once the report is triaged.

## Scope

In scope: the engine and runtime (`lib/`), the recovery-soundness gate, and the deterministic
classification/attestation logic. Of particular interest:

- **Soundness bypasses** — any input that makes the classifier label an irreversible action as
  auto-undoable (a "dangerous miss"), or that defeats the no-under-call property.
- **Attestation bypasses** — forging or replaying an attested recovery context (`lib/engine/attest.ts`).
- **Kill-switch / mode bypasses** — any path that mutates the world while the kill-switch is engaged
  or the mode is `dry-run`/`sandbox` (`lib/runtime/mode.ts`, `safe-executor.ts`).
- **Fabrication** — any path that reports an action "restored" without a journal-confirmed write
  (`lib/runtime/journal.ts`).
- **Prompt-injection** of the gated judge through agent-authored action text (`lib/engine/judge.ts`).

Out of scope: the sandboxed reference world is intentionally in-memory and not hardened against a
malicious operator; real-world adapters are a deploy-time concern, out of scope for v1.

## Supply chain

Dependencies are constrained by a release-age cooldown (`.npmrc` `min-release-age`) and CI runs
`npm ci --ignore-scripts`, `npm audit --audit-level=high`, and `npm audit signatures`. Report any
suspected dependency compromise through the same private channel.
