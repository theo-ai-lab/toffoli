/-
  Toffoli — mechanized soundness of the reversibility classifier (operational model).

  This file discharges THEORY.md §4 tier-3 ("Mechanized proof — the research-gated
  remainder") FOR THE OPERATIONAL MODEL: it states the §3 soundness property
  (`∀ a. C⁺(a) ⪰ c*(a)`, no under-call) and the catastrophic-safety corollary, and
  proves them in Lean 4 with the kernel, using Lean core only (no Mathlib).

  SCOPE (honest — see formal/README.md):
    * Modeled at the RESOLVED-OP level. We ASSUME op-resolution is correct and do NOT
      model the tool-name regexes / SQL-verb parsing of `resolveOp` in classify.ts.
      `Signals.op` is the already-resolved op.
    * "Relative to honest metadata" per THEORY.md §7: a PRESENT safe-direction signal
      reflects the truth; a safe signal MAY be ABSENT/unknown even when the truth is
      safe (the attestation/stripping discipline), but never the reverse. This is what
      `observe` encodes, and it is exactly what makes the soundness inequality the
      genuine asymmetric `⪰` rather than a definitional equality.
    * Faithfulness of THIS model to the TS bytes of `classifyDeterministic` is pinned
      separately by `formal/diff_check.ts` (it enumerates the full finite Signals space
      and asserts the real TS classifier — with abstain↦IRREVERSIBLE — agrees with the
      Lean `classifyPlus` exported here for every point).

  No `sorry`. `#print axioms` (see Axioms.lean) shows only the standard kernel axioms.
-/

namespace Toffoli

-- The shared soundness leaf-closer runs `simp` with the same lemma set on every leaf;
-- some leaves legitimately do not need every lemma. Silence that purely-cosmetic lint.
set_option linter.unusedSimpArgs false

/-! ## 1. The four-class lattice -/

/-- The four reversibility classes, in ascending severity (decreasing recoverability).
    Mirrors `Reversibility` in lib/engine/types.ts. -/
inductive Rev where
  | nullipotent
  | reversible
  | compensable
  | irreversible
deriving DecidableEq, Repr

/-- The rank in the chain `NULLIPOTENT ⪯ REVERSIBLE ⪯ COMPENSABLE ⪯ IRREVERSIBLE`.
    Mirrors `REVERSIBILITY_ORDER` (the index into that array). -/
def Rev.rank : Rev → Nat
  | .nullipotent  => 0
  | .reversible   => 1
  | .compensable  => 2
  | .irreversible => 3

/-- `a ⪯ b` : `a` is no more severe than `b` (rank `a ≤` rank `b`). -/
def Rev.le (a b : Rev) : Prop := a.rank ≤ b.rank

/-- `a ≺ b` : strictly less severe. -/
def Rev.lt (a b : Rev) : Prop := a.rank < b.rank

instance (a b : Rev) : Decidable (Rev.le a b) := Nat.decLe a.rank b.rank
instance (a b : Rev) : Decidable (Rev.lt a b) := Nat.decLt a.rank b.rank

@[inherit_doc] scoped infix:50 " ⪯ " => Rev.le
@[inherit_doc] scoped infix:50 " ≺ " => Rev.lt

/-- `NULLIPOTENT` is the bottom of the chain. -/
theorem Rev.bot_le (r : Rev) : Rev.nullipotent ⪯ r := by cases r <;> decide

/-- `IRREVERSIBLE` (`⊤`) is the top of the chain. -/
theorem Rev.le_top (r : Rev) : r ⪯ Rev.irreversible := by cases r <;> decide

/-- Nothing is strictly above `⊤`: `⊤ ⪯ r → r = ⊤`. -/
theorem Rev.eq_irr_of_irr_le {r : Rev} (h : Rev.irreversible ⪯ r) : r = Rev.irreversible := by
  cases r <;> first | rfl | exact absurd h (by decide)

/-- A small string image for the JSON export consumed by diff_check.ts.
    These are exactly the `Reversibility` string literals in types.ts. -/
def Rev.name : Rev → String
  | .nullipotent  => "NULLIPOTENT"
  | .reversible   => "REVERSIBLE"
  | .compensable  => "COMPENSABLE"
  | .irreversible => "IRREVERSIBLE"

/-! ## 2. Resolved ops and a tri-state for the observable target signals -/

/-- The canonical operation, AFTER resolution (the regexes are out of scope). Mirrors
    `ActionOp` in types.ts. -/
inductive Op where
  | read | create | update | delete | append | send | pay | publish | deploy | execute | custom
deriving DecidableEq, Repr

/-- A target signal that the classifier reads can be attested-true, attested-false, or
    absent/unknown. (`recoverable`/`externalized` ∈ {true, false, absent}.) -/
inductive Tri where
  | yes | no | unknown
deriving DecidableEq, Repr

def Op.name : Op → String
  | .read => "read" | .create => "create" | .update => "update" | .delete => "delete"
  | .append => "append" | .send => "send" | .pay => "pay" | .publish => "publish"
  | .deploy => "deploy" | .execute => "execute" | .custom => "custom"

def Tri.name : Tri → String
  | .yes => "yes" | .no => "no" | .unknown => "unknown"

/-! ## 3. `Signals` — exactly the decision-relevant fields the rules branch on -/

/-- The observable inputs `classifyDeterministic` actually branches on, at the resolved-op
    level. `committed` collapses the TS `committed === false` test (false = the explicit
    "uncommitted" signal; true = committed-or-default). `destructiveDdl`/`neverRecoverable`
    are the structural SQL facts (DROP/TRUNCATE present; DROP DATABASE/TABLESPACE/SCHEMA).
    `openTxn` is `transaction === "open"`. `recoverable`/`externalized` are the
    target signals; `priorState` is `target.priorState !== undefined`.

    Note: a missing `target` is observationally the same as a present target with
    `recoverable = unknown`, `externalized = unknown`, `priorState = false` — the rules
    only ever read `t?.recoverable`, `t?.externalized`, `t?.priorState`. -/
structure Signals where
  op               : Op
  committed        : Bool
  destructiveDdl   : Bool
  neverRecoverable : Bool
  openTxn          : Bool
  recoverable      : Tri
  externalized     : Tri
  priorState       : Bool
deriving Repr

/-! ## 4. `classifyPlus` — a TOTAL function mirroring classify.ts EXACTLY, with the
        C⁺ fail-safe join `abstain ↦ IRREVERSIBLE`.

   The control flow mirrors `classifyDeterministic` precisely:
   committed-gate  →  destructive-DDL gate (BEFORE the op switch, op-independent)  →  op switch.
-/

def classifyPlus (s : Signals) : Rev :=
  -- 0. `if (action.committed === false) → NULLIPOTENT` (before resolveOp/DDL).
  match s.committed with
  | false => Rev.nullipotent
  | true =>
    -- 1. Destructive DDL is checked before the op switch, independent of the resolved op.
    if s.destructiveDdl then
      -- DROP DATABASE/TABLESPACE/SCHEMA can't roll back in a transaction (`neverRecoverable`).
      if s.openTxn && (!s.neverRecoverable) then
        Rev.reversible                                   -- sql:ddl-open-transaction-rollback
      else
        match s.recoverable with
        | .yes => Rev.compensable                        -- sql:ddl-destructive-with-backup
        | _    => Rev.irreversible                       -- sql:ddl-destructive
    else
      match s.op with
      | .read   => Rev.nullipotent                       -- read:no-mutation
      | .create =>
        match s.externalized with
        | .yes => Rev.compensable                        -- create:externalized-copy
        | _    => Rev.reversible                         -- create:inverse-delete
      | .append => Rev.compensable                       -- append:correcting-entry
      | .update =>
        if s.priorState then Rev.reversible              -- update:prior-state-captured
        else match s.recoverable with
          | .yes => Rev.reversible                       -- update:versioned-store
          | _    => Rev.irreversible                     -- ABSTAIN (null) ↦ ⊤
      | .delete =>
        match s.recoverable with
        | .yes => Rev.reversible                         -- delete:recoverable-copy
        | _    => if s.openTxn then Rev.reversible       -- delete:open-transaction-rollback
                  else Rev.irreversible                  -- delete:no-recoverable-copy
      | .send =>
        match s.externalized with
        | .no => Rev.reversible                          -- send:internal-undelivered
        | _   => Rev.irreversible                        -- send:external-dispatch
      | .pay =>
        match s.externalized with
        | .yes     => Rev.irreversible                   -- pay:funds-withdrawn
        | .no      => Rev.compensable                    -- pay:refundable-window
        | .unknown => Rev.irreversible                   -- ABSTAIN (null) ↦ ⊤
      | .publish =>
        match s.externalized with
        | .yes     => Rev.irreversible                   -- publish:fanned-out
        | .no      => Rev.compensable                    -- publish:retract-availability
        | .unknown => Rev.irreversible                   -- ABSTAIN (null) ↦ ⊤
      | .deploy  => Rev.compensable                      -- deploy:rollback
      | .execute => Rev.irreversible                     -- ABSTAIN (null) ↦ ⊤
      | .custom  => Rev.irreversible                     -- ABSTAIN (null) ↦ ⊤

/-! ## 5. Ground truth — defined HONESTLY so the theorem is not circular.

   `TrueEffect` captures the REAL reversibility-determining facts of an action, plus
   which safe-direction signals the trusted runtime managed to ATTEST. `trueClass` is the
   SPEC (the genuine reversibility given the real effects); `observe` is the
   honest-metadata map (a PRESENT safe signal reflects truth; safe signals may be ABSENT
   even when the truth is safe — never the reverse).
-/

structure TrueEffect where
  op                 : Op
  /-- Did a durable side effect really commit? -/
  trulyCommitted     : Bool
  /-- Is the statement really a destructive DDL (DROP/TRUNCATE)? (structural, visible) -/
  isDestructiveDdl   : Bool
  /-- DROP DATABASE/TABLESPACE/SCHEMA — structurally unrollbackable. (structural, visible) -/
  neverRecoverable   : Bool
  /-- Really inside an open, rollbackable transaction. (observed by the executing runtime) -/
  trulyInOpenTxn     : Bool
  /-- An INDEPENDENT recoverable copy genuinely exists. -/
  trulyRecoverable   : Bool
  /-- The effect genuinely crossed a trust boundary you don't control. -/
  trulyExternalized  : Bool
  /-- The prior value was genuinely captured. -/
  trulyPriorCaptured : Bool
  /-- For ops whose true reversibility is OPAQUE to the floor (an `update` with no
      recovery context, `execute`, `custom`), the genuine class is whatever it really is —
      a free parameter the classifier cannot see. The classifier abstains and C⁺ joins to
      ⊤; soundness holds for EVERY value here precisely because `⊤` is the top. -/
  opaqueTrue         : Rev
  -- ── attestation bits: did the trusted instrument attest each SAFE-direction signal? ──
  /-- attested the (safe) "uncommitted" claim -/
  attCommitted       : Bool
  /-- attested the (safe) "recoverable" claim -/
  attRecoverable     : Bool
  /-- attested the (safe) "not externalized" claim -/
  attExternalized    : Bool
  /-- attested the (safe) "prior captured" claim -/
  attPrior           : Bool

/-- The SPEC: the genuine reversibility class implied by the real effects.
    (Same control-flow skeleton as `classifyPlus`, but reading the TRUE facts, and
    returning the opaque true class exactly where the classifier must abstain.) -/
def trueClass (e : TrueEffect) : Rev :=
  if (!e.trulyCommitted) then Rev.nullipotent      -- nothing committed ⇒ truly NULLIPOTENT
  else if e.isDestructiveDdl then
    if e.trulyInOpenTxn && (!e.neverRecoverable) then Rev.reversible  -- ROLLBACK restores exactly
    else if e.trulyRecoverable then Rev.compensable                   -- restore from independent backup
    else Rev.irreversible                                             -- structure + rows destroyed
  else
    match e.op with
    | .read   => Rev.nullipotent
    | .create => if e.trulyExternalized then Rev.compensable else Rev.reversible
    | .append => Rev.compensable
    | .update =>
      if e.trulyPriorCaptured then Rev.reversible       -- restore the captured prior (exact)
      else if e.trulyRecoverable then Rev.reversible    -- roll back via version history
      else e.opaqueTrue                                 -- no recovery context ⇒ genuinely opaque
    | .delete =>
      if e.trulyRecoverable then Rev.reversible          -- independent recoverable copy
      else if e.trulyInOpenTxn then Rev.reversible       -- ROLLBACK
      else Rev.irreversible                              -- hard delete, gone
    | .send    => if e.trulyExternalized then Rev.irreversible else Rev.reversible
    | .pay     => if e.trulyExternalized then Rev.irreversible else Rev.compensable
    | .publish => if e.trulyExternalized then Rev.irreversible else Rev.compensable
    | .deploy  => Rev.compensable
    | .execute => e.opaqueTrue                           -- arbitrary code ⇒ genuinely opaque
    | .custom  => e.opaqueTrue                           -- unrecognized tool ⇒ genuinely opaque

/-- The honest-metadata observation map (§7).

    For each SAFE-direction signal, the OBSERVED value reflects the truth when attested,
    and is ABSENT/unknown (i.e. biased toward severe) when not — and NEVER reports a
    safe value the truth does not support:

      * committed:    if truly committed ⇒ reported committed (true). If truly uncommitted,
                      the safe "uncommitted" claim is surfaced (false) only when attested;
                      otherwise it is stripped (treated as committed → severe analysis).
      * recoverable:  reported `yes` ONLY when truly recoverable AND attested; otherwise
                      `unknown` (stripped). Never `yes` when not truly recoverable.
      * externalized: the SEVERE truth (`yes`) is always surfaced; the SAFE "not externalized"
                      claim is reported `no` only when attested, else `unknown` (stripped).
                      Never `no` when truly externalized.
      * priorState:   present ONLY when truly captured AND attested; else absent.
      * openTxn / destructiveDdl / neverRecoverable: structural facts the executing runtime
                      observes directly (transaction state; visible SQL text) — faithfully
                      reported. (`destructiveDdl`/`neverRecoverable` are severe-direction;
                      reporting them faithfully is conservative.) -/
def observe (e : TrueEffect) : Signals where
  op               := e.op
  committed        := e.trulyCommitted || (!e.attCommitted)
  destructiveDdl   := e.isDestructiveDdl
  neverRecoverable := e.neverRecoverable
  openTxn          := e.trulyInOpenTxn
  recoverable      := if e.trulyRecoverable && e.attRecoverable then Tri.yes else Tri.unknown
  externalized     :=
    if e.trulyExternalized then Tri.yes
    else if e.attExternalized then Tri.no else Tri.unknown
  priorState       := e.trulyPriorCaptured && e.attPrior

/-! ## 6. The main theorem and the catastrophic-safety corollary -/

/-- **Soundness (no under-call), THEORY.md §3.**
    `∀ e. classifyPlus (observe e) ⪰ trueClass e` — the classifier never assigns a class
    strictly safer than the truth (relative to honest metadata; abstain joins to ⊤).

    Proof: the committed-gate and DDL-gate are op-independent and handled first; then a
    case on the resolved op, splitting only the few fields each branch scrutinizes. Every
    leaf is closed by `decide` (a closed `Nat ≤ Nat`), except the genuinely-opaque
    branches (`update` with no recovery context, `execute`, `custom`) where the classifier
    yields `⊤` and `Rev.le_top` discharges `opaqueTrue ⪯ ⊤`. -/
theorem soundness (e : TrueEffect) : trueClass e ⪯ classifyPlus (observe e) := by
  obtain ⟨op, tc, ddl, nr, txn, rec, ext, prior, opq, ac, ar, ae, ap⟩ := e
  -- The leaf closer: try `⊤` (closes every leaf where the floor lands on IRREVERSIBLE —
  -- the abstain/opaque leaves and the truly-irreversible ones), else evaluate both sides
  -- to concrete ranks and discharge the resulting `Nat ≤ Nat`.
  cases tc with
  | false =>
      -- truly uncommitted ⇒ trueClass = NULLIPOTENT = ⊥, below everything.
      exact Rev.bot_le _
  | true =>
    cases ddl with
    | true =>
        -- destructive-DDL gate (op-independent): split the DDL-relevant fields only.
        cases nr <;> cases txn <;> cases rec <;> cases ar <;>
          first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
    | false =>
      cases op with
      | read    =>
          first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | create  =>
          cases ext <;> cases ae <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | update  =>
          cases prior <;> cases ap <;> cases rec <;> cases ar <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | delete  =>
          cases rec <;> cases ar <;> cases txn <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | append  =>
          first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | send    =>
          cases ext <;> cases ae <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | pay     =>
          cases ext <;> cases ae <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | publish =>
          cases ext <;> cases ae <;>
            first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | deploy  =>
          first | exact Rev.le_top _ | simp [trueClass, classifyPlus, observe, Rev.le, Rev.rank]
      | execute => exact Rev.le_top _
      | custom  => exact Rev.le_top _

/-- **Corollary (catastrophic safety), THEORY.md §3.**
    If the truth is `IRREVERSIBLE`, the floor commits to `IRREVERSIBLE` (it never assigns
    a recoverable verdict to a truly irreversible action). In the C⁺ model abstain has
    already joined to ⊤, so the floor's value is exactly `IRREVERSIBLE` here. -/
theorem catastrophic_safety (e : TrueEffect)
    (h : trueClass e = Rev.irreversible) :
    classifyPlus (observe e) = Rev.irreversible := by
  have hs : trueClass e ⪯ classifyPlus (observe e) := soundness e
  rw [h] at hs
  exact Rev.eq_irr_of_irr_le hs

/-! ## 7. Non-vacuity — the `⪰` is the genuine asymmetric inequality, NOT reflexivity.

   These witness that `observe` really does allow safe-signal absence, so the soundness
   inequality is strict on some inputs (conservative over-calls) and an exact match on
   others. If the model had collapsed to `trueClass = classifyPlus ∘ observe`, the strict
   witnesses below would be unprovable. (Mirrors the fast-check non-vacuity assertion.) -/

/-- (a) Strict over-call: an `update` whose prior value WAS truly captured, but whose
    capture was NOT attested (`attPrior = false`) and which is not otherwise recoverable.
    The runtime strips the unattested safe signal, the floor abstains, and C⁺ escalates to
    IRREVERSIBLE — strictly above the true REVERSIBLE. -/
def overCallUpdate : TrueEffect :=
  { op := .update, trulyCommitted := true, isDestructiveDdl := false, neverRecoverable := false,
    trulyInOpenTxn := false, trulyRecoverable := false, trulyExternalized := false,
    trulyPriorCaptured := true, opaqueTrue := .nullipotent,
    attCommitted := true, attRecoverable := false, attExternalized := false, attPrior := false }

theorem overcall_update_strict :
    trueClass overCallUpdate ≺ classifyPlus (observe overCallUpdate) := by decide

/-- (a') Strict over-call via a stripped "not externalized" claim: a `pay` that genuinely
    did NOT externalize (settle) but whose safe signal is unattested → unknown → the floor
    abstains to IRREVERSIBLE, strictly above the true COMPENSABLE. -/
def overCallPay : TrueEffect :=
  { op := .pay, trulyCommitted := true, isDestructiveDdl := false, neverRecoverable := false,
    trulyInOpenTxn := false, trulyRecoverable := false, trulyExternalized := false,
    trulyPriorCaptured := false, opaqueTrue := .nullipotent,
    attCommitted := true, attRecoverable := false, attExternalized := false, attPrior := false }

theorem overcall_pay_strict :
    trueClass overCallPay ≺ classifyPlus (observe overCallPay) := by decide

/-- (a'') The strongest over-call: an `execute` whose real effect is a harmless read
    (true class NULLIPOTENT), yet the opaque op abstains and C⁺ joins to ⊤ — the textbook
    over-approximation `⊥ ≺ ⊤`. -/
def overCallExecute : TrueEffect :=
  { op := .execute, trulyCommitted := true, isDestructiveDdl := false, neverRecoverable := false,
    trulyInOpenTxn := false, trulyRecoverable := false, trulyExternalized := false,
    trulyPriorCaptured := false, opaqueTrue := .nullipotent,
    attCommitted := true, attRecoverable := false, attExternalized := false, attPrior := false }

theorem overcall_execute_strict :
    trueClass overCallExecute ≺ classifyPlus (observe overCallExecute) := by decide

/-- (b) Exact match at a NON-trivial class: a `create` that genuinely was not externalized,
    with the safe signal attested — both sides say REVERSIBLE. (Shows `⪰` is not always
    strict, hence a real inequality.) -/
def exactCreate : TrueEffect :=
  { op := .create, trulyCommitted := true, isDestructiveDdl := false, neverRecoverable := false,
    trulyInOpenTxn := false, trulyRecoverable := false, trulyExternalized := false,
    trulyPriorCaptured := false, opaqueTrue := .nullipotent,
    attCommitted := true, attRecoverable := false, attExternalized := true, attPrior := false }

theorem exact_create_match :
    classifyPlus (observe exactCreate) = trueClass exactCreate
    ∧ trueClass exactCreate = Rev.reversible := by decide

/-- (b') Exact match at IRREVERSIBLE: a `send` that truly externalized — both sides ⊤,
    and (by `catastrophic_safety`) this is forced. -/
def exactSend : TrueEffect :=
  { op := .send, trulyCommitted := true, isDestructiveDdl := false, neverRecoverable := false,
    trulyInOpenTxn := false, trulyRecoverable := false, trulyExternalized := true,
    trulyPriorCaptured := false, opaqueTrue := .nullipotent,
    attCommitted := true, attRecoverable := false, attExternalized := false, attPrior := false }

theorem exact_send_match :
    classifyPlus (observe exactSend) = trueClass exactSend
    ∧ trueClass exactSend = Rev.irreversible := by decide

end Toffoli
