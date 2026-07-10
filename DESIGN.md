# Toffoli — Design System

> One physical referent governs every choice: the **accountant's reversing entry on rag
> paper, read as a conservator's repair.** A restitution receipt is a *correction* artifact,
> not a success artifact. If a real ledger correction or a museum conservation note wouldn't
> do it, neither do we. That single rule is the defense against generic, "AI-slop" UI.

Toffoli is the contra column of a ledger run **backwards** — the spirit of double-entry bookkeeping
applied to agent actions. Where a ledger enters what happened, Toffoli enters the equal-and-opposite
action beside it. Two principles from art conservation map onto the engine's invariants with
uncanny precision: **reversibility** ("the golden rule of modern conservation") and
**distinguishability** (Cesare Brandi: a repair "must always be easily recognizable… without
interfering with the unity"). Distinguishability *is* the IRREVERSIBLE-recall metric rendered
as aesthetics — it must be structurally impossible to mistake a compensated seam for a restored
closed loop.

---

## 1. The four states → conservation grades

The receipt never collapses the states into a binary "everything reversed" — that collapse
*is* the eval failure (under-counting IRREVERSIBLE). Each state carries **three redundant
signals: glyph + word + color**, so the verdict survives grayscale and color-vision deficiency.

| State | Glyph | Conservation analog | Visual move |
|---|---|---|---|
| **no effect** (NULLIPOTENT) | `·` | untouched surface | faint, recessive — it changed nothing, so it barely marks the page |
| **RESTORED** (reversible) | `‹` | *selezione cromatica* / full reintegration | the reversing-entry pair **balanced to zero** — original struck with a single rule, inverse beneath, net 0. Calm, closed, resting ink |
| **COMPENSATED** (compensable) | `~` | *tratteggio* hatch / **kintsugi** gold seam | the original is **left standing** (it really happened) beside an annotated contra-entry. The seam is **shown, not hidden** — a metallic gold/ochre accent |
| **REQUIRES HUMAN** (irreversible) | `!` | *astrazione cromatica* / neutral-fill lacuna | the **loudest, most-framed** state — an open mark + a `REQUIRES HUMAN` stamp, red ink as **frame/accent only, never a fill** |

(Conservation lineage: Brandi's *tratteggio* at the ICR, ~1945–50; Baldini & Casazza formalized
*selezione*/*astrazione cromatica* in the 1970s, applied to Cimabue's *Crucifix* after the 1966
Florence flood. Kintsugi: the gold seam is highlighted because the repair becomes part of the
object's history.)

## 2. Color

Two functional colors plus a metallic seam, derived from the referent — never pure `#000`/`#fff`.

| Token | Hex | Role |
|---|---|---|
| `desk` | `#1A1714` | dark frame around the receipt |
| `paper` | `#F4EFE3` | warm rag-paper stock |
| `ink` | `#26221E` | body ink (~12:1 on paper) |
| `ink-faint` | `#8A7E6B` | NULLIPOTENT rows, fine print, hairline rules |
| `restored` | `#1E5E3A` | RESTORED — balanced to zero |
| `seam` | `#9A6A1E` | COMPENSATED — the kintsugi seam (gold/ochre) |
| `escalate` | `#8A2D2D` | REQUIRES HUMAN — red ink, frame/accent only |

Color never carries meaning alone (WCAG 1.4.1): each state is also a glyph, a word, and a
column position. The receipt survives grayscale — and a snapshot test should assert IRREVERSIBLE
is still the loudest state with color removed.

## 3. Type

- **Display, state labels, narrative — a transitional/old-style serif** (Spectral), with **true
  designed small caps** for state labels via the self-hosted **Spectral SC** family (not synthesized
  `font-variant: small-caps`). Fonts are subset and self-hosted (`design/fonts/`, `design/fonts.css`)
  — zero network dependency. Authority through restraint.
- **The ledger grid, numerals, IDs, hashes, rule-refs — IBM Plex Mono** with **tabular figures**
  (`font-feature-settings: "tnum"`), so columns align to the digit — the first tell of real
  financial typesetting. Oldstyle figures are reserved for the serif voice; the mono carries
  lining tabular figures. Mono is reserved for machine entries, never for prose.
- **Negatives in genuine parentheses** `(12.00)`, the GAAP/IFRS/SEC convention — a minus sign is
  easy to miss and color alone fails colorblind users.

## 4. Layout — the reversing ledger

The **contra grid is the layout primitive**, not a stack of cards. `ACTION │ spine │ RESTITUTION`
— what the agent did on the left, the equal-and-opposite entry on the right. Structure comes from
hairline rules, **sharp corners** (ledgers aren't rounded), and column alignment. The **pivot** is
a heavier horizontal rule labeled *point of no return*; rows below it can only be escalated. A
**condition-notes margin** carries provenance: which rule (or marked judge) produced each
classification, its confidence, and a hash of the original action.

## 5. Motion — at most two, then stop

Transform/opacity only, 200–400ms ease-out. No spring, bounce, or confetti (bounce easing is
itself a slop tell). (1) The receipt prints top-down like a ledger being posted. (2) The
`REQUIRES HUMAN` stamp lands once, on the verdict — never on hover. `prefers-reduced-motion`
renders everything at its final state instantly; the verdict is mirrored to `aria-live` so it
reaches screen readers as text.

## 6. The slop audit (run before shipping any screen)

Banned from day one: **Inter** (or any system-font default), purple→blue gradients, rounded-corner
cards, drop shadows, three-icon grids, emoji state badges, a green-check "done." The Toffoli
gate motif is **structural only**: paired entries must read as an inverse operation, while every
non-invertible break is left visibly open. **No logic-gate clip art, faux circuit boards, or
mathematical kitsch.**

*Design references that hold this bar: the correcting-journal-entry convention (post beside, never
erase); art-conservation reversibility + Brandi distinguishability; kintsugi; the Plaid/Robinhood
serif+mono restraint; WCAG 2.2 contrast and non-color encoding.*

## 7. Built from the engine — the no-drift rule

The published pages are **rendered from live engine output, never hand-written**. Each page in
`design/` carries marked regions (`toffoli:<name>:start/end`); `npm run design:build`
(lib/design/build.ts) fills them from the real thing:

| Region | Source of truth |
|---|---|
| receipt rows / pivot / summary / verdict / escalations | the same `restitute(run)` plan `npm run demo` prints (lib/demo.ts) |
| receipt methods table + headline | the same per-class report `npm run eval` prints (gold set, deterministic floor) |
| explorer `ACTIONS` array | the engine's classifications + planned compensations for lib/design/explorer-run.ts |
| index "measured" line | the live eval report + the end-to-end recovery harness (`npm run recover`'s scenario) |

Everything outside the markers is hand-authored design; everything inside is generated. The
committed pages are locked by the no-drift test (lib/design/build.test.ts): CI fails the moment a
page claims something the engine no longer produces — fix by re-running `npm run design:build`
and committing the diff, never by editing the region. `npm run design:check` is the same check as
a command. The Pages workflow regenerates before every deploy and fails the deploy if the result
differs from the committed pages, so the live demo equals both the engine and the repository by
construction.
