// READING THE CHARACTER'S LEVEL, for the class-combo interval builder.
//
// PURE, and its own file because comboIntervals.ts is at the measured 400-code-line ceiling and
// this is a coherent question of its own: EQ Legends states your level in exactly TWO places — a
// `Welcome to level N!` ding and your own `/who` row's bracket — and every one of the three answers
// below is about reconciling them.
//
// THE ONE FACT EVERYTHING HERE RESTS ON: the displayed level is the MINIMUM over the loadout's
// class levels (shared/classCombo.ts). Two consequences, and they pull in opposite directions:
//   * inside ONE loadout the number only ever RISES, because classes gain levels and never lose
//     them — so a level that goes backwards is proof of a swap;
//   * ACROSS a swap it can fall by forty, which is why `levelDropBoundaries` treats a
//     non-increasing ding as the loudest swap signal in the log.

import type { ClassAbbr } from '../../shared/classCombo'

/** A `/who` row, reduced to what interval construction needs. */
export interface WhoRow {
  ts: number
  seq: number
  classes: ClassAbbr[]
  /** the bracketed level — min over the loadout, so it is the interval's level too. */
  level: number
}

/** A `You have gained a level!` ding. */
export interface LevelPoint {
  ts: number
  level: number
}

/** Everything that ever STATES a level, which is the whole input to this file. */
export interface LevelStatements {
  levels: readonly LevelPoint[]
  whoRows: readonly WhoRow[]
}

/**
 * The level in force at `ts` — the LATEST statement at or before it, from either source.
 *
 * The two loops used to run one after the other with the `/who` pass writing unconditionally, so a
 * row's level won over every ding after it however old the row was. On the live log that put a
 * level 50 from a Jul 31 row on top of the Aug 06 ding to level 11 and reported the wizard interval
 * as `levels 11-50` — an impossible span under min-of-loadout, manufactured by the reader rather
 * than observed (JOS-239; the confidence gate reads this number, so it has to be the log's answer
 * and not the iteration order's). A row at the SAME instant as a ding still wins: it states the
 * bracket outright.
 */
export function levelAt(input: LevelStatements, ts: number): number | null {
  let level: number | null = null
  let at = -Infinity
  for (const p of input.levels) {
    if (p.ts <= ts && p.ts >= at) {
      level = p.level
      at = p.ts
    }
  }
  for (const r of input.whoRows) {
    if (r.ts <= ts && r.ts >= at) {
      level = r.level
      at = r.ts
    }
  }
  return level
}

/**
 * Every level STATED inside `[from, end)` — the two sources, in one list. `from` is INCLUSIVE for
 * the range (a ding that opens an interval is that interval's level) and the regression test asks
 * for the half-open form instead, which is why it is a parameter rather than a convention.
 */
function statedIn(input: LevelStatements, from: number, end: number | null, inclusive: boolean): number[] {
  const inside = (ts: number): boolean =>
    (inclusive ? ts >= from : ts > from) && (end === null || ts < end)
  return [
    ...input.levels.filter((p) => inside(p.ts)).map((p) => p.level),
    ...input.whoRows.filter((r) => inside(r.ts)).map((r) => r.level)
  ]
}

/** Levels observed inside a slice, for the interval's honest level range. */
export function levelRange(
  input: LevelStatements,
  startAt: number,
  end: number | null
): [number | null, number | null] {
  const inside = statedIn(input, startAt, end, true)
  const inForce = levelAt(input, startAt)
  if (inForce !== null) inside.push(inForce)
  if (inside.length === 0) return [null, null]
  return [Math.min(...inside), Math.max(...inside)]
}

/**
 * A LEVEL SPAN ONE LOADOUT CANNOT PRODUCE (JOS-239). Inside a fixed loadout the minimum only ever
 * goes UP, so a level observed inside the interval that is BELOW the level in force when it opened
 * is proof a swap happened in there that no detector cut.
 *
 * It is stated as a REGRESSION rather than as a width, because a width is not evidence of anything:
 * `levels 24-50` is a legitimate month of grinding, and `levels 11-50` is impossible only because
 * the 11 came AFTER the 50. The interval keeps carrying the honest [lo, hi] hull; this is the fact
 * the hull cannot express.
 */
export function levelRegressedInside(
  input: LevelStatements,
  startAt: number,
  end: number | null
): boolean {
  const inForce = levelAt(input, startAt)
  if (inForce === null) return false
  return statedIn(input, startAt, end, false).some((level) => level < inForce)
}
