/- Pin the axiom dependencies of the soundness theorem, the catastrophic-safety
   corollary, and the non-vacuity witnesses. Each `#guard_msgs` asserts the exact
   `#print axioms` output, so this module FAILS TO COMPILE if any theorem acquires
   `sorryAx` (a `sorry`-holed proof) or any non-kernel axiom. It is a default lake
   target: `lake build` — and therefore `npm run gate` and CI — enforce it. -/
import ToffoliFormal
open Toffoli

/-- info: 'Toffoli.soundness' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms soundness

/-- info: 'Toffoli.catastrophic_safety' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms catastrophic_safety

/-- info: 'Toffoli.overcall_update_strict' depends on axioms: [propext] -/
#guard_msgs in
#print axioms overcall_update_strict

/-- info: 'Toffoli.overcall_pay_strict' depends on axioms: [propext] -/
#guard_msgs in
#print axioms overcall_pay_strict

/-- info: 'Toffoli.overcall_execute_strict' depends on axioms: [propext] -/
#guard_msgs in
#print axioms overcall_execute_strict

/-- info: 'Toffoli.exact_create_match' depends on axioms: [propext] -/
#guard_msgs in
#print axioms exact_create_match

/-- info: 'Toffoli.exact_send_match' depends on axioms: [propext] -/
#guard_msgs in
#print axioms exact_send_match
