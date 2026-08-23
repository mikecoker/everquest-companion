// SERIALIZATION of YOUR DEFENSE for one segment (JOS-354) — "how often am I blocking, dodging,
// parrying, riposting?", plus the riposte counter-swing's own damage.
//
// PURE, like every other view build in this engine: functions over frozen `SourceStat`s, no engine
// state, no clock, and NO WRITE to the aggregate (tests/combatSourceViewsPurity.test.mts pins that
// repo-wide).
//
// NOTHING IS PARSED OR COUNTED HERE THAT WAS NOT ALREADY COUNTED. Every figure is a re-reading of
// counters the ingest path has folded since Task #51: `SourceStat.miss` on the INCOMING rows (an
// avoided swing is booked on the mob that swung it — the defender is You by construction of
// `classify`, so summing the incoming rows IS your defence) and the `(Riposte)` modifier tally on
// your OWN row. That is why this whole module moves no damage total: the one amount it reads,
// `ModifierTally.total`, is an index over damage the melee lanes already booked.
//
// THE DENOMINATOR IS SWINGS AT YOU, AND ONLY SWINGS (law 5 — a rate whose denominator is wrong is
// a lie, not an approximation). Melee + slay hits, because those are the two categories a weapon
// swing lands in; a mob's nuke, DoT tick or damage shield is not a swing and cannot be blocked, so
// including it would silently deflate every rate here in exactly the fights with a caster in them.

import { MISS_KEYS } from './aggregate'
import type { SourceStat } from './aggregate'
import type { DefenseView, MissBreakdown, RiposteView } from '../../shared/combat'

/** The two categories a weapon SWING lands in (a Slay Undead proc rides an ordinary swing). */
const SWING_CATEGORIES = ['melee', 'slay'] as const

function zeroBreakdown(): MissBreakdown {
  return { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 }
}

/** Landed weapon-swing hits in one row — melee + slay, never the spell/dot/ds lanes. */
function swingHits(s: SourceStat): number {
  let n = 0
  for (const c of SWING_CATEGORIES) n += s.byCategory.get(c)?.hits ?? 0
  return n
}

/** Landed weapon-swing DAMAGE in one row — the denominator riposte damage is a share of. */
function swingDamage(s: SourceStat): number {
  let n = 0
  for (const c of SWING_CATEGORIES) n += s.byCategory.get(c)?.total ?? 0
  return n
}

/**
 * YOUR RIPOSTE, both halves (see RiposteView). `events` comes from the incoming avoidance
 * breakdown; everything else comes from the `(Riposte)` annotation on your own swings, which is a
 * DIFFERENT fact — Double Riposte fires more counters than events, so the two are reported side by
 * side and never reconciled into one number.
 *
 * `you` is absent for a segment in which you landed and missed nothing at all (a fight watched
 * from the sidelines): the offensive half is then all zeroes, which is the truth, while the
 * defensive `events` half still stands on its own.
 */
function riposteView(you: SourceStat | undefined, events: number, taken: number): RiposteView {
  const t = you?.mods.get('Riposte')
  const swings = t?.count ?? 0
  const avoided = t?.avoided ?? 0
  const damage = t?.total ?? 0
  const base = you ? swingDamage(you) : 0
  return {
    events,
    swings,
    hits: swings - avoided,
    damage,
    pctOfSwingDamage: base > 0 ? (damage / base) * 100 : 0,
    taken
  }
}

/**
 * Build the segment's defensive view.
 *
 * @param inc   the segment's INCOMING rows — one per mob that swung at you.
 * @param you   your own outgoing row, for the riposte counter-swing half. Undefined ⇒ zeroes.
 * @param taken `(Riposte)` counters mobs swung at you (roundViews.takenAnnotations), passed in
 *              rather than re-derived so the two readers of that sum can never disagree.
 */
export function buildDefenseView(
  inc: ReadonlyMap<string, SourceStat>,
  you: SourceStat | undefined,
  taken: number
): DefenseView {
  const avoided = zeroBreakdown()
  let hits = 0
  for (const s of inc.values()) {
    for (const k of MISS_KEYS) avoided[k] += s.miss[k]
    hits += swingHits(s)
  }
  let avoidedTotal = 0
  for (const k of MISS_KEYS) avoidedTotal += avoided[k]
  const swings = hits + avoidedTotal
  // The four ACTIVE defences. A mob's own `misses!` and your rune's `absorb` are deliberately not
  // among them: neither is a skill of yours, and folding either in would flatter every rate.
  const defended = avoided.block + avoided.parry + avoided.dodge + avoided.riposte
  const rate = (n: number): number => (swings > 0 ? (n / swings) * 100 : 0)
  const rates = zeroBreakdown()
  for (const k of MISS_KEYS) rates[k] = rate(avoided[k])
  return {
    swings,
    hits,
    avoided,
    avoidedTotal,
    avoidedPct: rate(avoidedTotal),
    defended,
    defendedPct: rate(defended),
    rates,
    riposte: riposteView(you, avoided.riposte, taken)
  }
}
