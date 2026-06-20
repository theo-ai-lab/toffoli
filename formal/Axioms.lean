/- Print the axiom dependencies of the soundness theorem, the catastrophic-safety
   corollary, and the non-vacuity witnesses. Run via `lake env lean Axioms.lean`.
   There must be NO `sorryAx` — only the standard kernel axioms. -/
import ToffoliFormal
open Toffoli

#print axioms soundness
#print axioms catastrophic_safety
#print axioms overcall_update_strict
#print axioms overcall_pay_strict
#print axioms overcall_execute_strict
#print axioms exact_create_match
#print axioms exact_send_match
