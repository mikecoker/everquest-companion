// THE CONDITIONING HELPER FOR THE KILL/EXPERIENCE JOIN — shared by the two full-log tripwires
// that need it (tests/progressionKillJoin.test.mts, tests/progressionWindows.test.mts).
//
// WHY IT EXISTS (JOS-234, sharpened by JOS-241 — AGENTS.md "a ratio rots too, if its denominator
// is the owner's play"). Both tests once froze a rate whose denominator was a fact about what the
// owner happened to be killing rather than about the code:
//
//   joined / CREDITED KILLS  > 0.9    (JOS-234) — 95.8% when written, 85.8% and falling by 08-12
//   CREDITED KILLS / exp samples ≈ 1  (JOS-241) — 1.153 by 08-12, past a frozen 1.15 bound
//
// Neither had a diff behind it. The character reached level 50 on 2026-08-04 and farms grey mobs,
// and a grey kill prints NO experience line: measured 2026-08-12 over 1.61M lines, the share of
// credited kills that had an experience line to claim runs 87-100% every day through 2026-08-10,
// then 6.1% (08-11) and 2.0% (08-12). The join never moved; the population under it did.
//
// So every statement built here is conditioned on THE CODE'S PRECONDITION — the two lines being
// within KILL_EXP_JOIN_MS of each other, in the direction the log actually prints them (the
// experience line PRECEDES its kill line: 4,887 of 4,909 in the full-log sweep quoted in
// src/main/modules/progression.ts). A grey kill is in NO term below. A quest turn-in's experience
// is in no term below. Party experience paid by a group-mate's killing blow is in no term below,
// because the kill line that follows it is witnessed rather than credited. What is left is the
// correspondence itself, which is the thing the code owns.
//
// EVERYTHING HERE READS THE COLUMNS, never the module's own `pendingExp` bookkeeping — a
// re-implementation of the claiming order would only prove itself. `pushExp` writes the experience
// columns before it ever offers the line to `pendingExp`, and no code on the claiming path reads
// them back, so they are an independent oracle for the join.

import { KILL_EXP_JOIN_MS } from '../src/main/modules/progression'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

/**
 * The newest experience line stamped inside KILL_EXP_JOIN_MS before `ts`, as an index into the
 * experience columns, or -1 when the kill had nothing to claim. This is the whole definition of a
 * PAYABLE kill.
 */
export function payableExpLine(snap: ProgressionSnap, ts: number): number {
  let lo = 0
  let hi = snap.expTs.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (snap.expTs[mid] <= ts) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (best < 0 || ts - snap.expTs[best] > KILL_EXP_JOIN_MS) return -1
  return best
}

/**
 * The MIRROR of `payableExpLine`: the first CREDITED kill stamped inside KILL_EXP_JOIN_MS after
 * experience line `i`, as an index into `killTs`, or -1 when nothing of yours died to claim it.
 * That is the whole definition of a PAID experience line — and the reason a group-mate's party
 * experience and a quest turn-in both drop out of every statement below: the kill line that
 * follows them is witnessed, or there is no kill line at all.
 */
export function paidKillLine(snap: ProgressionSnap, i: number): number {
  const t = snap.expTs[i]
  let lo = 0
  let hi = snap.killTs.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (snap.killTs[mid] >= t) {
      best = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  if (best < 0 || snap.killTs[best] - t > KILL_EXP_JOIN_MS) return -1
  return best
}

/** The two conditioned populations, plus the one measured reason they are not the same size. */
export interface ExpPairing {
  /** timestamps of the credited kills that HAD an experience line to claim, ascending. */
  payable: number[]
  /** timestamps of the experience lines that HAD a credited kill to pay, ascending. */
  paid: number[]
  /** payable kills pointing at an experience line an EARLIER payable kill already pointed at. */
  contended: number
}

/**
 * Both halves of the conditioned correspondence, read off the columns in one pass each.
 *
 * `payable` and `paid` are the two directions of the SAME relation, so their sizes agree exactly
 * to the extent that the relation is one-to-one. The two measured ways it is not:
 *   • CONTENTION — a mob and its pet dying in the same second share one experience line, and the
 *     module's join lets the first kill consume it (`takeExp`). Two payable kills, one paid line.
 *   • A SECOND LINE IN THE SAME SECOND — EQ stamps to the second, so two experience lines can both
 *     sit inside one kill's window. Two paid lines, one payable kill.
 * Measured 2026-08-12 over 1.61M lines: 5443 payable, 5433 paid, 14 contended (0.26%).
 */
export function expPairing(snap: ProgressionSnap): ExpPairing {
  const payable: number[] = []
  const claimed = new Set<number>()
  let contended = 0
  for (const ts of snap.killTs) {
    const i = payableExpLine(snap, ts)
    if (i < 0) continue
    payable.push(ts)
    if (claimed.has(i)) contended++
    else claimed.add(i)
  }
  const paid: number[] = []
  for (let i = 0; i < snap.expTs.length; i++) {
    if (paidKillLine(snap, i) >= 0) paid.push(snap.expTs[i])
  }
  return { payable, paid, contended }
}

/**
 * The same correspondence over the most RECENT `n` payable kills — the restatement that keeps a
 * regression breaking only NEW lines from being diluted by thousands of correct old ones.
 *
 * The window opens KILL_EXP_JOIN_MS BEFORE the oldest kill in the slice, because an experience
 * line precedes the kill that claims it: clipping on the kill's own timestamp would drop that
 * line from the denominator and bias the ratio up by one row.
 */
export function recentPairingRatio(p: ExpPairing, n: number): { ratio: number; kills: number; lines: number } {
  const tail = p.payable.slice(-n)
  const from = tail[0] - KILL_EXP_JOIN_MS
  const to = tail[tail.length - 1]
  const lines = p.paid.filter((t) => t >= from && t <= to).length
  return { ratio: tail.length / lines, kills: tail.length, lines }
}
