// SERIALIZATION of the attack-round counters into the Rounds panel's payload
// (docs/plans/attack-round-stats.md §3). Pure functions over a frozen `SourceStat`: no engine
// state, no clock, and — like every view build in this engine — NO WRITE to the aggregate
// (tests/combatSourceViewsPurity.test.mts pins that invariant repo-wide; `RoundAccum.snapshot`
// is the half of it that lives on the accumulator).
//
// Everything here is a COUNT or a ratio of counts. Nothing reads a damage amount, so nothing
// here can move a damage total (law 8's tripwire).

import { roundConfidence } from './rounds'
import type { SourceStat } from './aggregate'
import type { ModifierTallyView, RoundLaneView, SourceRoundsView } from '../../shared/combat'

/** The generic lane name the parser gives every weapon verb — a label to REPLACE, not to show
 *  four times in one table (`slash`, `pierce`, `crush` and `hit` all answer "Melee"). */
const GENERIC_LANE = 'Melee'

/** Title-case a verb for display ('backstab' → 'Backstab'). */
function titleVerb(verb: string): string {
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}

/**
 * The row label for a verb lane. A special-attack lane the log NAMED wins ("Flying Kick"); a
 * weapon verb falls back to the verb itself, because the parser's answer for all of them is the
 * same word and a table of four "Melee" rows would be unreadable.
 */
export function roundLaneLabel(verb: string, skill: string): string {
  return skill === '' || skill === GENERIC_LANE ? titleVerb(verb) : skill
}

/** One base modifier's tally, ranked by count desc then name (stable across snapshots). */
function modifierViews(s: SourceStat): ModifierTallyView[] {
  return [...s.mods.values()]
    .map((m): ModifierTallyView => ({ name: m.name, count: m.count, avoided: m.avoided }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function tallyOf(mods: ModifierTallyView[], name: string): number {
  return mods.find((m) => m.name.toLowerCase() === name)?.count ?? 0
}

/**
 * THE RIPOSTE COUNTER-SWING, read off the accumulator rather than off `modifierViews` (JOS-354).
 *
 * `ModifierTallyView` is the counts-only shape on the wire and stays that way; the landed count
 * and the damage come from the raw tally, which is where the amount was re-read on ingest. The
 * key is the log's own spelling ('Riposte') because that is what `parseModifiers` emits — the
 * view's lowercase lookup above is a display-side convenience and not the storage key.
 */
function riposteTally(s: SourceStat): { landed: number; damage: number } {
  const t = s.mods.get('Riposte')
  if (!t) return { landed: 0, damage: 0 }
  return { landed: t.count - t.avoided, damage: t.total }
}

/**
 * Build one source's Rounds payload, or undefined when the source has nothing to say — no
 * rounds AND no annotations. Undefined rather than an empty shell so a spell-only source (or a
 * mob that only ever cast) shows no panel instead of a row of zeroes.
 *
 * `taken` is the segment-level incoming annotation count, resolved by the caller because it is
 * NOT a property of this source's own rows: a `(Riposte)` counter aimed at you is booked on the
 * MOB that swung it. See SourceRoundsView.ripostesTaken for the asymmetry this encodes.
 */
export function roundStatsView(
  s: SourceStat,
  taken: { riposte: number; rampage: number } = { riposte: 0, rampage: 0 }
): SourceRoundsView | undefined {
  const modifiers = modifierViews(s)
  const tallies = s.roundAcc.snapshot()
  if (tallies.length === 0 && modifiers.length === 0) return undefined
  const lanes: RoundLaneView[] = tallies
    .map((t): RoundLaneView => ({
      verb: t.verb,
      label: roundLaneLabel(t.verb, t.skill),
      rounds: t.rounds,
      buckets: [...t.buckets],
      multiRounds: t.multiRounds,
      multiPct: t.rounds > 0 ? (t.multiRounds / t.rounds) * 100 : 0,
      fannedRounds: t.fannedRounds,
      confidence: roundConfidence(t.verb)
    }))
    .sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label))
  const primaryRounds = lanes.reduce((n, l) => n + l.rounds, 0)
  const flurries = tallyOf(modifiers, 'flurry')
  const riposte = riposteTally(s)
  return {
    lanes,
    primaryRounds,
    excluded: { ...s.roundAcc.excluded },
    modifiers,
    ripostesGiven: tallyOf(modifiers, 'riposte'),
    riposteLanded: riposte.landed,
    riposteDamage: riposte.damage,
    ripostesTaken: taken.riposte,
    rampagesTaken: taken.rampage,
    flurries,
    flurryPct: primaryRounds > 0 ? (flurries / primaryRounds) * 100 : 0
  }
}

/**
 * The segment's INCOMING annotation totals — what was done TO you. Summed over every incoming
 * row because the engine books an annotation on the source that swung it, and "taken" is the
 * same fact read from the other end. Incoming means the defender is You by construction of
 * `classify`, so this needs no further gating.
 */
export function takenAnnotations(inc: ReadonlyMap<string, SourceStat>): { riposte: number; rampage: number } {
  let riposte = 0
  let rampage = 0
  for (const s of inc.values()) {
    riposte += s.mods.get('Riposte')?.count ?? 0
    rampage += s.mods.get('Rampage')?.count ?? 0
  }
  return { riposte, rampage }
}
