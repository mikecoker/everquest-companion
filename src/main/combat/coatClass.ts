// LEAVING ROGUE BARES THE BLADES (JOS-305) — the second of the two boundaries eqlwiki's Rogue
// page names ("poisons remain active until class swap or death"), and the one the app could not
// see until this file existed.
//
// THE REPORT. The owner, 2026-08-13: "the poisons shown in the combat module are from the last
// ROGUE session". Coats are session-scoped and deliberately survive zoning, and the only two
// things that could remove one were a printed dry line and your own death. So a character who
// swapped away from rogue kept a header pill naming venoms that had been off the blades for days,
// and every pull since opened `slowExpected` — the Procs surface blaming the dice for a slow that
// could not physically land.
//
// IT IS IN THE FOLD, NOT IN THE UI, and that is not a stylistic preference. A UI-side "hide the
// coat pill when the class is not ROG" would leave `coatUtility` naming a poison inside the engine,
// where `lifecycle.ts` stamps it onto every encounter as `coatAtEngage` and the state timeline
// keeps its span open forever. Replaying the same log has to reach the same answer as the live
// tail did (AGENTS.md: a historical replay reads no wall clock), so the clear happens where the
// state lives and is driven by event timestamps only.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// THE SEAM, AND WHY IT IS A GATED PULL RATHER THAN A SUBSCRIPTION
//
// There is exactly ONE class detector in this app and it is the combo module (modules/combo.ts +
// comboEvidence / comboScore / comboIntervals). Growing a second one inside the combat engine —
// "did I see a rogue skill lately?" — would be a model that disagrees with the one on screen, so
// this reads the combo module's own resolved interval through `EngineState.comboProvider` and
// asks it one question via the shared `comboMayInclude`.
//
// The combo module emits no derived events, so there is nothing to subscribe to; it answers when
// asked. And answering is NOT free: `ComboModule.currentInterval()` rebuilds the intervals from
// every retained observation whenever one has arrived since the last ask, which measures ~5 ms at
// 30,000 observations (the owner's log's order of magnitude). Asking per line would add minutes to
// a full historical fold. So this file is, in its entirety, the honest gate on when to ask.
//
// THE GATE, three clauses, each earning its place:
//
//   1. THERE MUST BE SOMETHING TO CLEAR. Two field reads. Every non-rogue in the world pays this
//      and nothing else, forever, and a rogue stops paying the moment the coats come off.
//   2. A LOADOUT-STATING EVENT ASKS IMMEDIATELY. `selfWho` is the game naming the loadout
//      outright (§ 4.4 — nothing in the combo model overrides a /who row) and `level` is where
//      that model's own levelDrop swap detector fires, because your displayed level is the
//      MINIMUM over the loadout's class levels and only a swap makes it fall. Both are rare —
//      eleven /who rows in 1.1M lines — so this clause is free and it is the one that makes the
//      fix feel instant: a player who swaps, sees the stale pill and types /who on themselves has
//      the coats gone on that line.
//   3. OTHERWISE, AT MOST ONCE PER `CLASS_CHECK_MS` OF LOG TIME. This is the clause that catches
//      the swap nobody announced — an `evidenceShift` boundary, where the model simply watched
//      rogue evidence stop and something else start.
//
// WHAT THIS DOES NOT CATCH, said out loud rather than papered over: a swap detected purely by
// evidence drift clears the coats up to `CLASS_CHECK_MS` after the model first knew, not at the
// instant it knew. That is a bounded lateness on an inference whose own boundary is a RANGE, and
// the range is wider than the lateness (see `CLASS_CHECK_MS`). It is not a lie the UI can print:
// the coats are gone within the same interval the model dated the swap to.

import { clearCoats } from './procRouting'
import { comboMayInclude, loadoutUncertain } from '../../shared/comboIndex'
import type { EngineState } from './state'
import type { LogEvent } from '../../shared/logEvents'

/**
 * THE POLL PERIOD, in LOG milliseconds — never a wall clock, so a replay consults at exactly the
 * instants the live tail did.
 *
 * Fifteen minutes because that is `WINDOW_FLOOR_MS` in modules/comboIntervals.ts: the interval
 * model refuses to bisect a span below it ("or an ambiguous span thrashes into confetti"), so it
 * CANNOT date a swap finer than fifteen minutes and a faster poll could not sharpen the answer —
 * it would only re-ask a question whose answer is not allowed to have moved. Duplicated as a
 * local constant rather than imported: the combat engine does not otherwise depend on the module
 * layer, and one number with its reasoning written down beats a coupling edge for a coincidence
 * of value. If the model's floor ever moves, this comment is the pointer to move with it.
 */
export const CLASS_CHECK_MS = 15 * 60_000

/** The event kinds that make the loadout question worth asking on the spot — see gate clause 2. */
function statesTheLoadout(kind: LogEvent['kind']): boolean {
  return kind === 'selfWho' || kind === 'level'
}

/**
 * Consult the class model and strip the coats if this character can no longer be a rogue
 * (JOS-305). Called once per ingested event, beside the charm / ally / pet-nudge sweeps, and for
 * the same reason they are: a deadline the log crosses should be observed by the fold that
 * crossed it.
 *
 * THE REFUSALS ARE THE FEATURE. This is an inference that DESTROYS state, so every uncertainty in
 * the class model has to resolve toward leaving the blades alone:
 *
 *   * no provider / no interval — the module is not wired or has never had an observation. There
 *     is no answer, and the absence of an answer must never read as "not a rogue".
 *   * `loadoutUncertain` (JOS-239) — the model has already declared it cannot explain this span
 *     (over-determined, or the displayed level went backwards inside it). A span that swallowed
 *     two swaps is exactly the one whose "current" trio is the ranking's opinion; acting on it is
 *     how you delete a live rogue's poisons.
 *   * `comboMayInclude(..., 'ROG')` — permissive by construction (comboIndex.ts): an UNKNOWN slot
 *     carries all sixteen candidates, so an unresolved loadout answers YES and nothing happens.
 *     Only a loadout whose every slot has positively RULED ROG OUT bares the blades.
 *
 * ONE-DIRECTIONAL, deliberately. A poison coat is ROG evidence at weight 3 (comboEvidence.ts), so
 * the class model reads coats — and this reads the class model. The loop is broken because a
 * clear writes no observation anywhere: it can only ever remove state, never mint evidence. Nor
 * does it ever RESTORE a coat; coats come back only when the log prints another coat line, which
 * is itself a fresh ROG observation the model will see first.
 */
export function sweepCoatClass(st: EngineState, ev: LogEvent): void {
  if (st.coatUtility === undefined && st.coatCombat.length === 0) return
  if (!statesTheLoadout(ev.kind) && ev.ts - st.coatClassCheckedTs < CLASS_CHECK_MS) return
  st.coatClassCheckedTs = ev.ts
  const interval = st.comboProvider()
  if (!interval) return
  if (loadoutUncertain(interval)) return
  if (comboMayInclude(interval, 'ROG')) return
  clearCoats(st, ev.ts, 'classSwap')
}
