// INTERVAL CONSTRUCTION for the class-combo model (docs/plans/class-combo-inference.md § 4.5).
//
// PURE: observations + `/who` rows + level dings + user corrections in, ComboInterval[] out.
//
// A LOADOUT SWAP PRINTS NOTHING. `grep -ci loadout` over 1.1M lines returns 37 hits and every
// one is another player's chat. So every boundary here is INFERENCE, it is always a RANGE
// [startLo, startHi] rather than an instant, and the detectors are ranked by how much the log
// actually said:
//
//   who            two consecutive /who rows disagree. The game NAMED both loadouts; the swap
//                  is somewhere between the rows. Hard, and nothing overrides it.
//   levelDrop      a `Welcome to level N!` with N <= the previous ding. Displayed level is the
//                  MINIMUM of the loadout's class levels, so a non-increasing ding is a swap —
//                  note `<=`, not `<`: the real log has a genuine 11 → 11 REPEAT 0.9 h apart
//                  that a strict-descent predicate misses. (levelSeries.ts keeps `<` on
//                  purpose and is pinned by its own golden window — do not "fix" it.)
//   evidenceShift  a class with sustained exclusive evidence goes silent and a different one
//                  starts. This is what NARROWS a boundary: the Aug 2 swap is bracketed 33.9 h
//                  apart by level dings, and to ~60 min (last MNK Feign Death 00:57:55 → first
//                  ROG Backstab 01:57:42) by the shift. Both fire for the same swap; the
//                  narrower window wins and the other is recorded in `startAlso`.
//
// The one thing a `/who` row NEVER loses to is a narrower inferred window — hence the explicit
// precedence in `mergeBoundaries`.

import type {
  ClassAbbr,
  ClassObservation,
  ComboBoundaryReason,
  ComboCorrection,
  ComboInterval,
  ComboSlot
} from '../../shared/classCombo'
import { scoreSlots, statedSlots } from './comboScore'
import {
  levelRange,
  levelRegressedInside,
  type LevelPoint,
  type WhoRow
} from './comboLevels'

// The two shapes that STATE a level live beside the code that reconciles them (comboLevels.ts) and
// are re-exported here, which is the import path every caller already uses.
export type { LevelPoint, WhoRow }

export interface IntervalInput {
  observations: readonly ClassObservation[]
  whoRows: readonly WhoRow[]
  levels: readonly LevelPoint[]
  corrections: readonly ComboCorrection[]
}

/** One detected swap: it happened somewhere in [lo, hi]; `at` is where we cut. */
export interface Boundary {
  lo: number
  hi: number
  /** best estimate — always `hi`: the new loadout is only PROVEN at the arriving evidence. */
  at: number
  reason: ComboBoundaryReason
  /** other detectors that fired for the same swap. */
  also?: ComboBoundaryReason[]
}

/** The tertiary slot unlocks at level 10 — a PRIOR, overridden by a /who row's own arity. */
const TERTIARY_UNLOCK_LEVEL = 10

/** § 4.5 R8: never bisect below this, or an ambiguous span thrashes into confetti. */
const WINDOW_FLOOR_MS = 15 * 60_000

/** Bound on shift bisection. The real log needs one cut; this is the runaway guard. */
const MAX_SHIFT_CUTS = 16

// --------------------------------------------------------------------- detectors

/**
 * Consecutive `/who` rows that disagree, MINUS the swaps something sharper already dated.
 *
 * A `/who` pair only bounds the swap by "somewhere between these two rows", which in this log
 * runs to three hours and to 33 hours elsewhere. So the rule is: the disagreement is PROOF that
 * a swap happened, but if any already-detected boundary falls inside `(prev, row]` then that
 * boundary IS this swap, dated better, and adding a second one here would split the same event
 * twice. Only an undated disagreement opens its own (wide, honest) boundary.
 *
 * The FIRST row never opens one: with no earlier statement there is nothing to disagree with,
 * and splitting there would manufacture an empty interval in front of every anchored span.
 */
export function whoBoundaries(
  rows: readonly WhoRow[],
  dated: readonly Boundary[] = []
): Boundary[] {
  const out: Boundary[] = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const row = rows[i]
    if (prev.classes.join('/') === row.classes.join('/')) continue
    if (dated.some((b) => b.at > prev.ts && b.at <= row.ts)) continue
    out.push({ lo: prev.ts, hi: row.ts, at: row.ts, reason: 'who' })
  }
  return out
}

/**
 * A `/who` ROW THAT CONTRADICTS THE EVIDENCE BEHIND IT — the swap cut nothing else can see
 * (JOS-192).
 *
 * THE DEFECT THIS EXISTS FOR. `whoBoundaries` above needs TWO rows to disagree, and the log has
 * eleven rows in 1.1M lines. Inside a slice nothing else cut, `slotsFor` rule 1 takes the LAST
 * `/who` row in that slice and states the WHOLE slice with it — so a player who swaps loadouts,
 * sees the app naming the trio they left, and types `/who` on themselves to correct it has their
 * correction applied backwards over every hour the slice already covered. The range-stat chips,
 * the boss loadout sections and the level-up toasts all rewrite to a loadout that was not being
 * played then, and the one honest thing in the picture — the pre-swap inference — is the thing
 * that gets overwritten. That is the trigger report's other half.
 *
 * THE RULE. A `/who` row states the loadout AT ITS OWN TIMESTAMP and nowhere else. When the
 * evidence in front of it inside its own segment SUSTAINS a class the row does not name, the game
 * and the log disagree about the same span, which can only mean a swap happened between them — so
 * the boundary is cut AT THE ROW and the span before it keeps what it inferred.
 *
 * WHY DEPARTURE ALONE, when `reinstatedDrops` demands departure AND arrival. That rule compares
 * evidence to evidence across a ding, where "everything looks departed" right after the cut simply
 * because no time has passed. This one compares evidence to a STATEMENT: a class carrying ≥2
 * hourly buckets of exclusive evidence that the game says you are not running is a contradiction
 * on its own, and waiting for the new loadout to prove itself would reintroduce the hours of
 * staleness the row was typed to end.
 *
 * WHY IT CANNOT MANUFACTURE BOUNDARIES. It is silent when the row AGREES with the evidence — the
 * ordinary case, and the reason CW1's seven rows still yield four intervals — and it only ever
 * looks at evidence the same `exclusiveSpans` bar admits everywhere else in this file. `/who`
 * observations are excluded from that evidence: a row is a statement, never a score (§ 4.4), and a
 * single-class row would otherwise draw an exclusive span for itself.
 *
 * `dated` is every boundary already placed (including cuts this pass has made), so `from` is the
 * start of the row's own segment and the window is never wider than the era it describes.
 */
export function whoShiftBoundaries(
  observations: readonly ClassObservation[],
  rows: readonly WhoRow[],
  dated: readonly Boundary[],
  firstTs: number
): Boundary[] {
  const out: Boundary[] = []
  const evidence = observations.filter((o) => o.source !== 'who')
  for (const row of rows) {
    const placed = [...dated, ...out]
    if (placed.some((b) => b.at === row.ts)) continue
    const before = placed.filter((b) => b.at <= row.ts).map((b) => b.at)
    const from = before.length > 0 ? Math.max(...before) : firstTs
    if (row.ts <= from) continue
    const departed = exclusiveSpans(
      evidence.filter((o) => o.ts >= from && o.ts < row.ts)
    ).filter((s) => !row.classes.includes(s.cls))
    if (departed.length === 0) continue
    // The window opens no earlier than the last word of a class that is gone — the same honest
    // left edge `reinstatedDrops` uses — and closes at the row, which is where the game spoke.
    out.push({
      lo: Math.max(from, ...departed.map((s) => s.last)),
      hi: row.ts,
      at: row.ts,
      reason: 'who'
    })
  }
  return out
}

/**
 * A non-increasing level ding. The window is honestly WIDE — the Aug 2 swap's is 33.9 h — and
 * the UI is expected to draw it as a range. Exported so a test can assert that the evidence
 * shift genuinely NARROWS this rather than replacing a window nobody looked at.
 */
export function levelDropBoundaries(levels: readonly LevelPoint[]): Boundary[] {
  const out: Boundary[] = []
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]
    const ding = levels[i]
    if (ding.level > prev.level) continue
    out.push({ lo: prev.ts, hi: ding.ts, at: ding.ts, reason: 'levelDrop' })
  }
  return out
}

/** A class's exclusive-evidence span, for classes the window actually stands behind. */
interface Span {
  cls: ClassAbbr
  first: number
  last: number
}

/**
 * Classes carrying SUSTAINED EXCLUSIVE evidence — ≥2 distinct hourly buckets of observations
 * that name that class and nothing else.
 *
 * A STRICTER bar than admission on purpose. Admission's `sustain` counts every bucket holding
 * any evidence for the class, twelve-class invocations included; that is the right question for
 * "is this class in the loadout", and the WRONG one for "when was this class present", where a
 * shared invocation would smear a class across the whole log and manufacture boundaries. Here
 * only the class's own unambiguous evidence draws the span.
 */
function exclusiveSpans(observations: readonly ClassObservation[]): Span[] {
  const spans = new Map<ClassAbbr, Span & { buckets: Set<number> }>()
  for (const o of observations) {
    if (o.candidates.length !== 1) continue
    const cls = o.candidates[0]
    const span = spans.get(cls)
    if (span) {
      span.first = Math.min(span.first, o.ts)
      span.last = Math.max(span.last, o.ts)
      span.buckets.add(Math.floor(o.ts / 3_600_000))
    } else {
      spans.set(cls, { cls, first: o.ts, last: o.ts, buckets: new Set([Math.floor(o.ts / 3_600_000)]) })
    }
  }
  return [...spans.values()]
    .filter((s) => s.buckets.size >= 2)
    .map(({ cls, first, last }) => ({ cls, first, last }))
}

/**
 * ONE cut inside a window, or null.
 *
 * The window is over-determined when more classes carry sustained exclusive evidence than a
 * loadout can hold. The swap is then bounded below by the EARLIEST departure (the first class
 * to fall silent — `Feign Death` at 00:57:55) and above by the EARLIEST arrival after it (the
 * first class to appear — `Backstab` at 01:57:42). Earliest on both ends is what makes the
 * window narrow AND honest: anything before the departure is still the old loadout, anything
 * from the first arrival on is provably the new one.
 */
function cutOnce(observations: readonly ClassObservation[], expectedSlots: number): Boundary | null {
  const spans = exclusiveSpans(observations)
  if (spans.length <= expectedSlots) return null
  const departing = spans.reduce((a, b) => (b.last < a.last ? b : a))
  const arrivals = spans.filter((s) => s.first > departing.last)
  if (arrivals.length === 0) return null
  const arriving = arrivals.reduce((a, b) => (b.first < a.first ? b : a))
  if (arriving.first - departing.last < 0) return null
  return { lo: departing.last, hi: arriving.first, at: arriving.first, reason: 'evidenceShift' }
}

/**
 * Evidence-shift boundaries inside one hard segment, found by bisecting until every sub-window
 * holds at most `expectedSlots` sustained classes. On hitting the 15-minute floor while still
 * over-determined we DO NOT split — an honest "we can't tell" beats a fabricated boundary
 * (§ 4.5); the interval keeps its candidates wide and `startAlso` records `overDetermined`.
 */
export function evidenceShiftBoundaries(
  observations: readonly ClassObservation[],
  expectedSlots: number
): Boundary[] {
  const out: Boundary[] = []
  const queue: (readonly ClassObservation[])[] = [observations]
  while (queue.length > 0 && out.length < MAX_SHIFT_CUTS) {
    const window = queue.shift()
    if (!window || window.length === 0) continue
    const span = window[window.length - 1].ts - window[0].ts
    if (span < WINDOW_FLOOR_MS) continue
    const cut = cutOnce(window, expectedSlots)
    if (!cut) continue
    out.push(cut)
    queue.push(
      window.filter((o) => o.ts <= cut.lo),
      window.filter((o) => o.ts >= cut.hi)
    )
  }
  return out.sort((a, b) => a.at - b.at)
}

// --------------------------------------------------------------------- assembly

/**
 * Windows that OVERLAP describe the same swap, and the NARROWEST of them is the answer. This
 * is the wave-2 correction made structural: the Aug 2 level ding says "somewhere in these 33.9
 * hours" and the evidence shift says "somewhere in these 60 minutes", about the same event —
 * so the shift wins the window and the ding is recorded in `also` rather than thrown away.
 *
 * The CUT itself is the EARLIEST `at` any detector in the group offers (clamped into the
 * winning window). `at` is where the new interval opens, so taking the earliest keeps a `/who`
 * row on the far side of a narrower inferred boundary inside the interval it describes.
 */
function pickBoundary(group: Boundary[]): Boundary {
  const best = group.reduce((a, b) => (b.hi - b.lo < a.hi - a.lo ? b : a))
  const at = Math.min(Math.max(Math.min(...group.map((b) => b.at)), best.lo), best.hi)
  const also = group.filter((b) => b !== best).map((b) => b.reason)
  const merged: Boundary = { ...best, at }
  if (also.length > 0) merged.also = [...new Set(also)]
  return merged
}

/** The window an absorbed drop is judged against: from the boundary that swallowed it to the
 *  next cut after it (or the end of the evidence). */
function absorbedWindow(
  drop: Boundary,
  dated: readonly Boundary[],
  end: number
): { from: number; to: number } | null {
  const before = dated.filter((b) => b.at <= drop.at)
  if (before.length === 0) return null
  const from = before.reduce((a, b) => (b.at > a.at ? b : a)).at
  const after = dated.filter((b) => b.at > drop.at).map((b) => b.at)
  return { from, to: after.length > 0 ? Math.min(...after) : end }
}

/**
 * LEVEL DINGS THE MERGE SWALLOWED, PUT BACK WHEN THE EVIDENCE SAYS THEY WERE A SECOND SWAP.
 * This is the JOS-79 convergence fix, and it is worth stating exactly what went wrong.
 *
 * `levelDropBoundaries` dates a ding's swap as "somewhere between the previous ding and this
 * one" — and after a swap that previous ding is by construction in the PREVIOUS era, so the
 * window routinely reaches back across an earlier swap. `mergeBoundaries` then reads that
 * overlap as "these two detectors describe the same event", keeps the narrower one, and the
 * ding's CUT is gone. MEASURED on the live log (2026-08-06): the swap into a wizard loadout
 * dinged at Aug 06 19:31:23, and its window opened at the previous ding on Aug 04 20:57:35 —
 * 46.6 h earlier, swallowing the Aug 04 23:38:01 evidence shift that was itself a real swap.
 * One boundary came out where there were two, and the app spent the whole evening naming a
 * loadout the owner had stopped playing.
 *
 * The discriminator is the EVIDENCE, never the clock, and it is the same test an evidence shift
 * already has to pass: a class with sustained exclusive evidence GOES SILENT and a different one
 * STARTS. Applied across the ding:
 *
 *   Aug 02 (the swap CW2 pins): before = {BER,ROG}, after = {BER,ENC,PAL,ROG}. Nothing departs —
 *          the ding 19 minutes after the shift is that same swap, dated worse. Absorbed, as it
 *          has always been, and CW2's boundary is untouched.
 *   Aug 06: before = {ENC,MNK,PAL}, after = {ENC,PAL,WIZ}. MNK leaves, WIZ arrives. Two swaps.
 *
 * Requiring BOTH directions is what keeps it conservative: right after a ding everything looks
 * "departed" simply because no time has passed, so an arrival that clears the ≥2-bucket sustain
 * bar is what has to carry the claim. And because this only ever RE-ADDS a cut the merge had
 * already deleted, it cannot move a boundary the model gets right today.
 *
 * THE DEPARTURE TEST SILENTLY UN-FIXED ITSELF AS THE LOG GREW (JOS-239, owner-reported: a wizard
 * the owner levelled to 25 was credited with a Lord Nagafen kill at D4). `absorbedWindow` runs to
 * the END of the observations, so "MNK left" is a question asked over all of recorded history —
 * and the owner swapped BACK into PAL/MNK/ENC on Aug 08, 40.1 h after the Aug 06 19:31 ding.
 * Nothing departed, the cut was never reinstated, and ONE 4.5-day interval carried two loadouts
 * plus a level range of 11-50 that no single loadout can produce. Fixture cw5 kept passing
 * because it ENDS inside the wizard evening; cw6 is the same span with the swap-back on it.
 *
 * THE SECOND ARM, and why it needs no clock constant. The question a merge answers is "are these
 * two detectors describing ONE event?", and the honest disqualifier is that the stretch between
 * them is an ERA IN ITS OWN RIGHT: it sustains a FULL LOADOUT's worth of exclusive evidence, by
 * the same ≥2-hourly-bucket bar everything else in this file uses. Measured on the two fixtures
 * that disagree:
 *
 *   CW2 (Aug 02, a genuine one-event merge): the ding lands 19 minutes past the shift's window
 *        and the stretch between them sustains {BER,ROG} — TWO classes, not a loadout. Absorbed,
 *        exactly as before, and CW2's boundary is untouched.
 *   CW6 (Aug 06): the ding lands 43.9 h past it and the stretch sustains {ENC,MNK,PAL} — a whole
 *        loadout, playing for two days. Two swaps, whatever the far side of the ding later does.
 *
 * The second condition is the model's own admission that it is out of its depth: the absorbed
 * span is OVER-DETERMINED (more classes clear the sustained-exclusive bar than the loadout has
 * slots). It is not strictly needed — an era between two detectors already disproves one event —
 * but it keeps the new arm to spans the model has already declared it cannot explain, which is
 * the conservative reading of "only ever re-add a cut the merge deleted".
 *
 * The WINDOW degrades honestly. `lo` is still the last word of a class that is gone; when the
 * second arm fires there may be none (that is what it is for), and the spread collapses to
 * `window.from` — "somewhere between the previous boundary and the ding", which is a superset of
 * the truth rather than a narrower claim than the evidence supports.
 */
export function reinstatedDrops(
  observations: readonly ClassObservation[],
  drops: readonly Boundary[],
  dated: readonly Boundary[],
  expectedSlots: number
): Boundary[] {
  if (observations.length === 0) return []
  const end = observations[observations.length - 1].ts + 1
  const out: Boundary[] = []
  for (const drop of drops) {
    if (dated.some((b) => b.at === drop.at)) continue
    const window = absorbedWindow(drop, dated, end)
    if (!window) continue
    const was = exclusiveSpans(observations.filter((o) => o.ts >= window.from && o.ts < drop.at))
    const now = exclusiveSpans(observations.filter((o) => o.ts >= drop.at && o.ts < window.to))
    const departed = was.filter((s) => !now.some((n) => n.cls === s.cls))
    const arrived = now.some((n) => !was.some((s) => s.cls === n.cls))
    const swapped = departed.length > 0 && arrived
    // The absorbed stretch is a loadout era of its own, inside a span the model cannot explain.
    const ownEra = was.length >= expectedSlots
    const overDetermined =
      exclusiveSpans(observations.filter((o) => o.ts >= window.from && o.ts < window.to)).length >
      expectedSlots
    if (!swapped && !(ownEra && overDetermined)) continue
    // The ding is the cut (the log spoke there); the window opens no earlier than the last
    // evidence of a class that is gone, which is the narrowest honest left edge available.
    const lo = Math.max(window.from, ...departed.map((s) => s.last))
    out.push({ lo, hi: drop.at, at: drop.at, reason: 'levelDrop', also: ['evidenceShift'] })
  }
  return out
}

/**
 * ONE GROUP OF OVERLAPPING WINDOWS, RESOLVED — and a `/who` cut is never what gets resolved away
 * (JOS-287).
 *
 * THE DEFECT THIS EXISTS FOR. `pickBoundary` answers "these detectors describe one swap" by
 * keeping the NARROWEST window and cutting at the EARLIEST `at` in the group. Applied to a group
 * that contains `/who` cuts that is a lie about the log, and the live log proved it: the Aug 12
 * re-roll dinged non-increasing (50 → 10), so `levelDropBoundaries` opened a window at the
 * previous ding — Aug 06 22:27:32 → Aug 12 22:47:00, SIX DAYS — and that one window overlapped
 * all four `/who` cuts inside it (Aug 09 10:41:31 `PAL/MNK/ENC`, Aug 10 20:13:00 `PAL/ROG/BER`,
 * Aug 11 21:01:24 `PAL/MNK/ENC`, Aug 12 22:42:20 `PAL/RNG/SHM`). One boundary came out where
 * there were four, its cut clamped to Aug 11 21:00:24, and the slice in front of it held two
 * rows that contradict each other — so `slotsFor` rule 1 took the LAST of them and stated
 * `PAL/ROG/BER` over the Aug 09 row, over the six days behind it, and over the whole wizard era
 * CW5 pins as real. A row the owner typed on Aug 10 was applied BACKWARDS across a swap
 * boundary. That is the tripwire's own words: the interval contradicted a row it covered.
 *
 * THE RULE. A `/who` row is ground truth AT ITS TIMESTAMP. Two rows are therefore two
 * statements, never one event, and no window drawn by inference may move, merge or delete the
 * cut a row makes — inference cannot outrank the game naming the loadout. So:
 *
 *   * every distinct `/who` cut in the group survives, at its own `at` (rows landing on the SAME
 *     instant are one statement and keep the narrowest window between them),
 *   * an inferred detector whose window CONTAINS a surviving row cut is that same swap, dated
 *     better by the game: it is absorbed and recorded in `also`. This is `whoBoundaries`' own
 *     suppression predicate read the other way round — there, an already-dated cut inside
 *     `(prev, row]` means the pair rule must not open a second boundary for one swap; here, a row
 *     cut inside `(lo, hi]` means the inferred window has already been dated by the row.
 *   * an inferred detector the rows did NOT date keeps its own boundary — it is a swap nothing
 *     stated, which is the case the whole file exists for — and those merge among themselves
 *     exactly as before.
 *
 * Groups with no `/who` cut in them are untouched: `pickBoundary` still resolves them, so CW2's
 * shift-narrows-the-ding and CW5's reinstated ding read exactly as they did.
 */
function resolveGroup(group: Boundary[]): Boundary[] {
  const stated = group.filter((b) => b.reason === 'who')
  if (stated.length === 0) return [pickBoundary(group)]
  const byInstant = new Map<number, Boundary[]>()
  for (const b of stated) byInstant.set(b.at, [...(byInstant.get(b.at) ?? []), b])
  const kept = [...byInstant.values()].map(pickBoundary)
  const undated: Boundary[] = []
  for (const b of group) {
    if (b.reason === 'who') continue
    const dating = kept.filter((k) => k.at > b.lo && k.at <= b.hi)
    if (dating.length === 0) {
      undated.push(b)
      continue
    }
    // Corroboration goes on the row cut nearest the detector's own date — the one it was
    // describing — so `startAlso` still says which detectors agreed about that swap.
    const host = dating.reduce((a, k) => (Math.abs(k.at - b.at) < Math.abs(a.at - b.at) ? k : a))
    host.also = [...new Set([...(host.also ?? []), b.reason, ...(b.also ?? [])])]
  }
  return [...kept, ...mergeBoundaries(undated)].sort((a, b) => a.at - b.at)
}

/** Collapse overlapping candidates into one boundary each, in time order. Windows that merely
 *  TOUCH (one ends exactly where the next begins) are separate swaps, not one. A `/who` cut is
 *  never collapsed away — see `resolveGroup`. */
export function mergeBoundaries(candidates: readonly Boundary[]): Boundary[] {
  const sorted = [...candidates].sort((a, b) => a.lo - b.lo || a.hi - b.hi)
  const out: Boundary[] = []
  let group: Boundary[] = []
  let groupHi = -Infinity
  for (const b of sorted) {
    if (group.length > 0 && b.lo >= groupHi) {
      out.push(...resolveGroup(group))
      group = []
    }
    group.push(b)
    groupHi = Math.max(groupHi, b.hi)
  }
  if (group.length > 0) out.push(...resolveGroup(group))
  return out.sort((a, b) => a.at - b.at)
}

/** Split observations at hard cut points so shift detection never reasons across a swap the
 *  log already announced. */
function hardSegments(
  observations: readonly ClassObservation[],
  hard: readonly Boundary[]
): (readonly ClassObservation[])[] {
  if (hard.length === 0) return [observations]
  const cuts = hard.map((b) => b.at).sort((a, b) => a - b)
  const segments: ClassObservation[][] = Array.from({ length: cuts.length + 1 }, () => [])
  for (const o of observations) {
    let i = 0
    while (i < cuts.length && o.ts >= cuts[i]) i++
    segments[i].push(o)
  }
  return segments
}

/** Every raw slice of the timeline, before scoring: [start, end) plus the boundary that made it. */
interface Slice {
  start: Boundary
  end: number | null
  observations: ClassObservation[]
}

function sliceTimeline(
  observations: readonly ClassObservation[],
  boundaries: readonly Boundary[],
  firstTs: number
): Slice[] {
  const opens: Boundary[] = [
    { lo: firstTs, hi: firstTs, at: firstTs, reason: 'logStart' },
    ...boundaries
  ]
  return opens.map((start, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].at : null
    return {
      start,
      end,
      observations: observations.filter((o) => o.ts >= start.at && (end === null || o.ts < end))
    }
  })
}

/** Latest-set wins: two statements about one span are one statement, the later one. */
function laterOf(a: ComboCorrection, b: ComboCorrection): ComboCorrection {
  return b.setAt >= a.setAt ? b : a
}

/** How much of `[start, end)` a correction covers. `Infinity` for two open-ended edges. */
function overlapMs(c: ComboCorrection, start: number, end: number | null): number {
  return Math.min(c.endTs ?? Infinity, end ?? Infinity) - Math.max(c.startTs, start)
}

/**
 * The correction that governs a SLICE, or null. TWO RULES, in order, and the second one is the
 * whole of JOS-87's "autodetect never silently overwrites an explicit override".
 *
 *   1. A correction COVERING the slice's start wins — the original rule, unchanged, so every
 *      span that resolves today resolves the same way (this pass is strictly additive, the
 *      law-8 shape: it only fills in cases that used to return null).
 *   2. Otherwise the correction OVERLAPPING the slice most wins.
 *
 * Rule 2 exists because boundaries move under a standing override. A correction is written
 * against the interval the user was looking at (`startTs` = that interval's cut) and intervals
 * are rebuilt from scratch on every fold — `mergeBoundaries`/`reinstatedDrops`/`collapse` are
 * not monotone, so a cut that existed when the user pressed Save can be gone one event later.
 * When that happens the slice covering *now* begins BEFORE the correction, rule 1 misses, and
 * under the old code the override vanished with no UI event and inference silently reclaimed
 * the display — the exact failure the ticket is about. Greatest-overlap is the conservative
 * repair: it never displaces a covering correction, and where several merely overlap it picks
 * the one with the most claim on the span rather than the most recent opinion about a sliver.
 * Ties (identical overlap, including two open-ended corrections) fall back to latest `setAt`.
 */
export function correctionForSlice(
  corrections: readonly ComboCorrection[],
  start: number,
  end: number | null
): ComboCorrection | null {
  const covering = corrections.filter(
    (c) => start >= c.startTs && (c.endTs === null || start <= c.endTs)
  )
  if (covering.length > 0) return covering.reduce(laterOf)
  const overlapping = corrections.filter((c) => overlapMs(c, start, end) > 0)
  if (overlapping.length === 0) return null
  return overlapping.reduce((a, b) => {
    const da = overlapMs(a, start, end)
    const db = overlapMs(b, start, end)
    if (db > da) return b
    if (db < da) return a
    return laterOf(a, b)
  })
}

/** What `slotsFor` decided, and how much of it the user is responsible for. */
interface SlotDecision {
  slots: ComboSlot[]
  expectedSlots: 2 | 3
  /** the user's override is what is on screen — inference must not touch these slots */
  provenanceLock: boolean
  /** the user's override applies here and a `/who` row inside the span said otherwise */
  overruled: boolean
}

/**
 * Slots for one slice, in authority order (§ 4.4):
 *   1. the LAST `/who` row inside it — the game named the loadout for this very span, so it
 *      wins even over a user correction (a correction on an anchored span is the user being
 *      wrong, and it is the game that just spoke),
 *   2. a user override governing it (`correctionForSlice`),
 *   3. inference.
 * A `/who` row also sets `expectedSlots` from its own arity, which is ground truth about
 * cardinality, not just membership.
 *
 * RULE 1 STILL WINS AND IS NOW AUDIBLE. It is the only way an explicit override loses, so when
 * it fires against a live override the interval carries `userOverruled` and the surface says
 * so. Silence there is what the ticket forbids — not the precedence itself.
 */
function slotsFor(slice: Slice, input: IntervalInput, prior: 2 | 3): SlotDecision {
  const rows = input.whoRows.filter(
    (r) => r.ts >= slice.start.at && (slice.end === null || r.ts < slice.end)
  )
  const row = rows.length > 0 ? rows[rows.length - 1] : null
  const correction = correctionForSlice(input.corrections, slice.start.at, slice.end)
  if (row) {
    const expected = row.classes.length === 2 ? 2 : 3
    return {
      slots: statedSlots(row.classes, 'who'),
      expectedSlots: expected,
      provenanceLock: false,
      overruled: correction !== null && correction.classes.join('/') !== row.classes.join('/')
    }
  }
  if (correction) {
    const expected = correction.classes.length === 2 ? 2 : 3
    return {
      slots: statedSlots(correction.classes, 'user'),
      expectedSlots: expected,
      provenanceLock: true,
      overruled: false
    }
  }
  return {
    slots: scoreSlots(slice.observations, prior),
    expectedSlots: prior,
    provenanceLock: false,
    overruled: false
  }
}

function toInterval(slice: Slice, input: IntervalInput, index: number): ComboInterval {
  const [levelLo, levelHi] = levelRange(input, slice.start.at, slice.end)
  const prior: 2 | 3 = levelLo !== null && levelLo < TERTIARY_UNLOCK_LEVEL ? 2 : 3
  const { slots, expectedSlots, provenanceLock, overruled } = slotsFor(slice, input, prior)
  const last = slice.observations[slice.observations.length - 1]
  const interval: ComboInterval = {
    id: `ci${index + 1}`,
    startTs: slice.start.at,
    endTs: slice.end,
    startLo: slice.start.lo,
    startHi: slice.start.hi,
    // An OPEN interval has not ended, so `endHi` stays null — but `endLo` is honest and useful:
    // it is the last moment we HAVE evidence for, i.e. "it was still this loadout at least
    // until here". A closed interval's end is simply the next boundary's cut.
    endLo: slice.end ?? last?.ts ?? null,
    endHi: slice.end,
    startReason: slice.start.reason,
    expectedSlots,
    slots,
    levelLo,
    levelHi,
    evidenceCount: slice.observations.length,
    userLocked: provenanceLock
  }
  // Optional and set only when true, so an interval nobody overrode serializes exactly as it
  // did before this change — the delta transport diffs intervals by JSON.stringify.
  if (overruled) interval.userOverruled = true
  // Same rule for the same reason (JOS-239): absent unless the span really did see the level go
  // backwards, so no interval's JSON moves for a flag that does not apply to it.
  if (levelRegressedInside(input, slice.start.at, slice.end)) interval.levelRegressed = true
  const also = [...(slice.start.also ?? [])]
  // The window could not be split further and still names more classes than a loadout holds:
  // say so rather than silently dropping the surplus (§ 4.5's floor rule).
  if (exclusiveSpans(slice.observations).length > expectedSlots) also.push('overDetermined')
  if (also.length > 0) interval.startAlso = [...new Set(also)]
  return interval
}

/** Two intervals that resolve to the SAME classes across a SOFT boundary were never two. */
function mergeable(a: ComboInterval, b: ComboInterval): boolean {
  if (b.startReason === 'who' || b.startReason === 'levelDrop' || b.startReason === 'user') {
    return false
  }
  // A locked span is the user's statement and an overruled one carries a notice they have to
  // see; collapsing either into a neighbour would delete the thing the row exists to say.
  if (a.userLocked || b.userLocked) return false
  if (a.userOverruled === true || b.userOverruled === true) return false
  const key = (i: ComboInterval): string =>
    i.slots.map((s) => s.candidates.join('|')).sort().join('/')
  return key(a) === key(b)
}

/**
 * The whole pass. Observations MUST arrive in seq order (the module keeps them that way).
 *
 * Note this recomputes from scratch every time — that is deliberate (§ 4.5): a `/who` typed an
 * hour from now, or a user correction, retroactively re-labels the past, and patching intervals
 * in place would leave a stale id pointing at a span that no longer exists. Ids are therefore
 * snapshot-scoped and the delta carries `removed`.
 */
export function buildIntervals(input: IntervalInput): ComboInterval[] {
  const observations = [...input.observations].sort((a, b) => a.seq - b.seq)
  if (observations.length === 0) return []
  // Level dings first (the log SAYS a swap happened), then the evidence shift inside each
  // segment they cut — a shift is only meaningful within one announced era. `/who`
  // disagreements come LAST because they only fire where nothing sharper already cut.
  const drops = levelDropBoundaries(input.levels)
  const shifts = hardSegments(observations, mergeBoundaries(drops)).flatMap((segment) =>
    // The prior is enough here: a 2-slot era simply cannot be over-determined at 3.
    evidenceShiftBoundaries(segment, 3)
  )
  const merged = mergeBoundaries([...drops, ...shifts])
  // …and put back any ding the merge swallowed that the evidence says was its OWN swap. Done
  // after the merge rather than inside it because the test needs the observations, and because
  // it may only ever ADD a cut the merge deleted (see reinstatedDrops).
  // The prior is enough for the slot count here for the same reason it is inside the shift
  // bisector: a 2-slot era cannot be over-determined at 3, so 3 is the conservative bar.
  const dated = mergeBoundaries([...merged, ...reinstatedDrops(observations, drops, merged, 3)])
  // …then the two `/who` rules, NARROW FIRST. `whoShiftBoundaries` cuts at a row the evidence
  // behind it contradicts (JOS-192) — a swap the log otherwise never dates, and the reason a
  // correcting `/who` no longer relabels the hours in front of it. Its cuts are handed to
  // `whoBoundaries` as already-dated, so a disagreement between two rows that the row-level rule
  // has just placed does not open a second, three-hours-wide boundary for the same swap.
  const shifted = whoShiftBoundaries(observations, input.whoRows, dated, observations[0].ts)
  const placed = mergeBoundaries([
    ...dated,
    ...shifted,
    ...whoBoundaries(input.whoRows, [...dated, ...shifted])
  ])
  // THE TRIPWIRE LAW, MADE STRUCTURAL (JOS-287). `whoBoundaries` stands down when something
  // already-dated cuts between two disagreeing rows — but it is handed the candidates, and an
  // INFERRED candidate can still be absorbed by the merge that follows (a `/who` cut cannot, since
  // `resolveGroup`). Asking the same question again of the boundaries that actually SURVIVED
  // closes that: every adjacent pair of rows that disagree ends up with a cut between them, so no
  // slice can hold two contradictory rows and `slotsFor`'s last-row rule can never state one row
  // over another. Nothing merges these — a row is ground truth at its timestamp, full stop.
  const boundaries = [...placed, ...whoBoundaries(input.whoRows, placed)]
    .sort((a, b) => a.at - b.at)
    .filter((b) => b.at > observations[0].ts)
  const slices = sliceTimeline(observations, boundaries, observations[0].ts)
  const built = slices.map((slice, i) => toInterval(slice, input, i))
  return collapse(built)
}

/** Post-pass for the merge rule (§ 4.5): a soft boundary between identical slot sets was noise. */
function collapse(intervals: ComboInterval[]): ComboInterval[] {
  const out: ComboInterval[] = []
  for (const interval of intervals) {
    const prev = out[out.length - 1]
    if (prev && mergeable(prev, interval)) {
      prev.endTs = interval.endTs
      prev.endLo = interval.endLo
      prev.endHi = interval.endHi
      prev.evidenceCount += interval.evidenceCount
      prev.levelHi = Math.max(prev.levelHi ?? -Infinity, interval.levelHi ?? -Infinity)
      if (prev.levelHi === -Infinity) prev.levelHi = null
      continue
    }
    out.push({ ...interval, id: `ci${out.length + 1}` })
  }
  return out
}
