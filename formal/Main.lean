/-
  Exports the Lean decision table (the verified `classifyPlus` over the full finite
  `Signals` space) as JSON on stdout, so `formal/diff_check.ts` can pin the Lean model to
  the real TypeScript `classifyDeterministic`. Run via `lake exe export_table`.
-/
import ToffoliFormal
open Toffoli

private def allOps : List Op :=
  [.read, .create, .update, .delete, .append, .send, .pay, .publish, .deploy, .execute, .custom]

private def allBool : List Bool := [false, true]
private def allTri  : List Tri  := [.yes, .no, .unknown]

private def jbool : Bool → String := fun b => if b then "true" else "false"

private def rowJson (s : Signals) : String :=
  "{\"op\":\"" ++ s.op.name ++ "\""
  ++ ",\"committed\":" ++ jbool s.committed
  ++ ",\"destructiveDdl\":" ++ jbool s.destructiveDdl
  ++ ",\"neverRecoverable\":" ++ jbool s.neverRecoverable
  ++ ",\"openTxn\":" ++ jbool s.openTxn
  ++ ",\"recoverable\":\"" ++ s.recoverable.name ++ "\""
  ++ ",\"externalized\":\"" ++ s.externalized.name ++ "\""
  ++ ",\"priorState\":" ++ jbool s.priorState
  ++ ",\"class\":\"" ++ (classifyPlus s).name ++ "\"}"

/-- Enumerate the full finite Signals space in a fixed field order
    (op, committed, destructiveDdl, neverRecoverable, openTxn, recoverable, externalized,
     priorState) = 11 × 2 × 2 × 2 × 2 × 3 × 3 × 2 = 3168 points, and print each row's
    verified `classifyPlus` class as JSON. -/
def main : IO Unit := do
  let mut rows : Array String := #[]
  for op in allOps do
   for comm in allBool do
    for ddl in allBool do
     for nr in allBool do
      for txn in allBool do
       for rc in allTri do
        for ext in allTri do
         for prior in allBool do
          rows := rows.push (rowJson
            { op := op, committed := comm, destructiveDdl := ddl, neverRecoverable := nr,
              openTxn := txn, recoverable := rc, externalized := ext, priorState := prior })
  IO.println ("[" ++ String.intercalate "," rows.toList ++ "]")
