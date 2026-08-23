// THE EARLY WARNING OFFSET (JOS-216), pinned to real bytes.
//
// THE ASK, quoted from report 01KZQF4YMVRPFKZHK7GDT90AWD: "the ability to program a 10 second
// warning on mez, slow, tash". The owner's ruling is that it is an OFFSET on an alert the user
// already has — the alert stops firing when the debuff LANDS and fires N seconds before the model's
// estimated END instead.
//
// NOTHING HERE IS AUTHORED. `tests/fixtures/w10-cazic-slow.log` is a scrubbed Plane of Fear pull
// that already contains all three cases, in twenty seconds of one fight:
//
//   [20:50:33] You begin casting Mesmerization III.
//   [20:50:34] a turmoil toad has been mesmerized.        ← runs its course; the warning FIRES
//   [20:50:34] a scareling has been mesmerized.           ← broken at :36; the warning is CANCELLED
//   [20:50:36] Your Mesmerization spell has worn off of a scareling.
//   [20:50:37] You begin casting Shiftless Deeds IV.
//   [20:50:38] a scareling slows down.                    ← its mob dies at :50; CANCELLED
//   [20:50:50] You have slain a scareling!
//   [20:50:52] Your Mesmerization spell has worn off of a turmoil toad.
//
// The replay is the REAL parser into the REAL AlertsModule, BuffsModule and BuffTimersModule, wired
// in the SAME registration order production uses — `replayAlertLines` in tests/harness.mts, which
// carries the argument for why that order is load-bearing rather than incidental. (It moved there
// when JOS-235's break-family matrix, tests/earlyWarningBreaks.test.mts, needed the same driver.)
//
// The expected fire instant is DERIVED from the row the model actually built (`startedTs +
// durationMs - offset`), never frozen: the estimate is learned, spells.json can be re-scraped, and
// a test that hard-coded today's 24 s would rot into a false red (AGENTS.md: frozen numbers rot).
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import type { BuffTimerRow } from '../src/shared/buffTimers'
import {
  MAX_EARLY_WARN_SEC,
  MIN_EARLY_WARN_SEC,
  earlyWarnFireAt,
  earlyWarnRowFor,
  normalizeEarlyWarnSec
} from '../src/shared/earlyWarning'
import { sanitizeAlertDef } from '../src/shared/shareSchema'
import type { AlertDef, FiredAlert } from '../src/shared/types'
import { readFixture, replayAlertLines, replayBuffTimers, tsOf } from './harness.mts'

const W10 = readFixture('w10-cazic-slow.log')

const CAST = tsOf('[Sat Aug 01 20:50:33 2026] You begin casting Mesmerization III.')
const LANDED = CAST + 1_000
const SCARELING_BREAK = tsOf('[Sat Aug 01 20:50:36 2026] x')
const SCARELING_DEATH = tsOf('[Sat Aug 01 20:50:50 2026] x')
const WINDOW_END = tsOf('[Sat Aug 01 20:51:05 2026] x')

/** An alert on every crowd-control line, with (or without) an early-warning offset. */
function mezAlert(earlyWarnSec?: number): AlertDef {
  return {
    id: 'mez-warn',
    name: 'Mez about to break',
    enabled: true,
    trigger: { type: 'event', kind: 'cc' },
    sound: { packId: 'p', soundId: 's' },
    // Long enough that the ordinary alert-wide clock could hide a second fire — so a test that
    // sees exactly one fire has seen the feature, not the cooldown.
    cooldownMs: 0,
    ...(earlyWarnSec === undefined ? {} : { earlyWarnSec })
  }
}

/**
 * An alert on the slow LANDING (`<mob> slows down.` → buffApply), scoped to the one mob.
 *
 * The `where` is not decoration: the fixture opens four minutes earlier on a different fight whose
 * OWN slow (Forlorn Deeds on Fright, 20:46:53) runs its full 180 s and legitimately warns at
 * 20:49:53. Measuring the cancellation means measuring one hold, not every buff in the log.
 */
function slowAlert(earlyWarnSec: number): AlertDef {
  return {
    id: 'slow-warn',
    name: 'Slow about to drop',
    enabled: true,
    trigger: { type: 'event', kind: 'buffApply', where: { target: 'a scareling' } },
    sound: { packId: 'p', soundId: 's' },
    cooldownMs: 0,
    earlyWarnSec
  }
}

/**
 * Replay the FIXTURE through the real modules in production order (tests/harness.mts
 * `replayAlertLines`, which is where the registration-order argument lives) and collect everything
 * the alerts module fired. `to` bounds the window the way the buff-timer goldens do — the same log
 * keeps going for another three minutes.
 */
function replayAlerts(defs: AlertDef[], to: number): FiredAlert[] {
  return replayAlertLines(W10, defs, to)
}

/** The row the model built for one target at an instant, straight off the shared projection. */
function rowFor(target: string, at: number): BuffTimerRow {
  const { rows } = replayBuffTimers(W10, { until: at })
  const row = rows.find((r) => r.target === target)
  assert.ok(row, `no timer row for ${target} at ${String(at)}`)
  return row
}

// ---------------------------------------------------------------------------------------------
// THE OFFSET MOVES THE FIRE. It does not add a second one, and it does not fire on the landing.
// ---------------------------------------------------------------------------------------------

test('without an offset the alert fires on the LANDING — the behavior the offset moves', () => {
  const fires = replayAlerts([mezAlert()], SCARELING_BREAK - 1)
  assert.equal(fires.length, 2, 'one fire per mob the AE mez landed on')
  for (const f of fires) assert.equal(f.ts, LANDED, 'a plain alert fires when the line arrives')
})

test('WITH an offset the landing is silent, and the warning lands 10s before the estimated end', () => {
  const row = rowFor('a turmoil toad', LANDED)
  assert.equal(row.mode, 'countdown', 'the fixture must give the toad a stated end to count back from')
  const due = earlyWarnFireAt(row, 10)
  assert.ok(due != null && due > LANDED, 'the warning must be in the future at the landing')

  const fires = replayAlerts([mezAlert(10)], WINDOW_END)
  assert.equal(fires.length, 1, 'ONE warning: the toad ran its course, the scareling did not')
  assert.equal(fires[0].alertId, 'mez-warn')
  assert.equal(fires[0].ts, due, 'fires at the row`s estimated end minus the offset')
  assert.ok(fires[0].ts > LANDED, 'and NOT when the mez landed')
  // The firing still says what the LANDING matched — the warning is that alert, moved.
  assert.match(fires[0].matchedText, /a turmoil toad has been mesmerized/)
})

// ---------------------------------------------------------------------------------------------
// CANCELLATION. A debuff that ends early takes its pending warning with it — and the rule is the
// row's disappearance, so every way a hold can end is covered by construction.
// ---------------------------------------------------------------------------------------------

test('a mez broken before the warning is due never warns — the scareling`s 2-second hold', () => {
  const fires = replayAlerts([mezAlert(10)], WINDOW_END)
  for (const f of fires) {
    assert.doesNotMatch(f.matchedText, /a scareling has been mesmerized/, 'a broken mez must not warn')
  }
})

test('…and neither does a slow whose mob dies first', () => {
  // `a scareling slows down.` at 20:50:38 on a mob slain at 20:50:50. The slow's estimated end is
  // far past the death, so the ONLY thing that can suppress this warning is the cancellation.
  const row = rowFor('a scareling', SCARELING_BREAK + 3_000)
  const due = earlyWarnFireAt(row, 10)
  assert.ok(due != null && due > SCARELING_DEATH, 'the fixture`s slow must outlive its mob')

  const fires = replayAlerts([slowAlert(10)], WINDOW_END)
  assert.equal(fires.length, 0, 'the mob died; there is nothing left to warn about')
})

// ---------------------------------------------------------------------------------------------
// THE PURE HALVES — the bounds, and the rule that picks which row a landing is tracked by.
// ---------------------------------------------------------------------------------------------

test('an offset is a whole number of seconds inside the bounds, or it is nothing', () => {
  assert.equal(normalizeEarlyWarnSec(10), 10)
  assert.equal(normalizeEarlyWarnSec(9.6), 10, 'rounded, not truncated')
  assert.equal(normalizeEarlyWarnSec(MAX_EARLY_WARN_SEC + 500), MAX_EARLY_WARN_SEC, 'clamped at the top')
  assert.equal(normalizeEarlyWarnSec(MIN_EARLY_WARN_SEC), MIN_EARLY_WARN_SEC)
  // Everything that means "no warning" arrives as undefined, so no caller has to know the spellings.
  for (const off of [0, -5, 0.4, NaN, Infinity, '10', null, undefined, {}]) {
    assert.equal(normalizeEarlyWarnSec(off), undefined, `${String(off)} must mean no early warning`)
  }
})

test('a landing with no stated end arms nothing — an invented remaining is never warned against', () => {
  const elapsed: BuffTimerRow = {
    id: 'cc|a mob|hex',
    kind: 'cc',
    name: 'Hex',
    group: 'target',
    target: 'a mob',
    targetKey: 'a mob',
    startedTs: 1_000,
    mode: 'elapsed'
  }
  assert.equal(earlyWarnRowFor([elapsed], { targetKey: 'a mob', spellNames: ['Hex'] }), undefined)
  assert.equal(earlyWarnFireAt(elapsed, 10), undefined)
})

test('the row is picked by ENTITY, then by the spell family, then by the newest landing', () => {
  const row = (over: Partial<BuffTimerRow> & { id: string; startedTs: number }): BuffTimerRow => ({
    kind: 'cc',
    name: 'Mesmerization VII',
    group: 'target',
    target: 'a turmoil toad',
    targetKey: 'a turmoil toad',
    mode: 'countdown',
    durationMs: 44_000,
    ...over
  })
  const toad = row({ id: 'toad-mez', startedTs: 10_000 })
  const otherMob = row({ id: 'other-mez', startedTs: 90_000, target: 'a scareling', targetKey: 'a scareling' })
  const toadSlow = row({ id: 'toad-slow', startedTs: 20_000, name: 'Shiftless Deeds IV' })
  const rows = [toad, otherMob, toadSlow]

  // The entity comes first: a newer landing on ANOTHER mob is never the answer.
  const mez = earlyWarnRowFor(rows, { targetKey: 'a turmoil toad', spellNames: ['Mesmerization'] })
  assert.equal(mez?.id, 'toad-mez', 'the rank-stripped family name must match the ranked row name')

  // No usable name ⇒ the most recent landing on that entity, which is the one the arming line made.
  const newest = earlyWarnRowFor(rows, { targetKey: 'a turmoil toad', spellNames: [] })
  assert.equal(newest?.id, 'toad-slow')

  // A self landing reads the self rows, and never a mob's.
  const selfRow = row({ id: 'self-haste', startedTs: 5_000, group: 'self', target: undefined, targetKey: undefined })
  assert.equal(earlyWarnRowFor([...rows, selfRow], { spellNames: [] })?.id, 'self-haste')
})

// ---------------------------------------------------------------------------------------------
// THE SHARE. Anything added to AlertDef has to survive `sanitizeAlertDef` or an exported bundle
// silently reverts it (shareSchema.ts's own warning, learned when voice alerts were dropped).
// ---------------------------------------------------------------------------------------------

test('an offset survives a share, and a stranger`s out-of-range one does not', () => {
  const shared = sanitizeAlertDef({ ...mezAlert(10) })
  assert.equal(shared?.earlyWarnSec, 10)
  const absurd = sanitizeAlertDef({ ...mezAlert(), earlyWarnSec: 99_999 })
  assert.equal(absurd?.earlyWarnSec, MAX_EARLY_WARN_SEC, 'clamped to what this build would offer')
  const junk = sanitizeAlertDef({ ...mezAlert(), earlyWarnSec: 'ten' })
  assert.equal(junk?.earlyWarnSec, undefined, 'and dropped when it is not a number at all')
  // An alert that never asked for a warning still sanitizes without the key (import dedupe hashes
  // these fields; a redundant one would stop matching the copy already in the user's store).
  assert.equal('earlyWarnSec' in (sanitizeAlertDef(mezAlert()) ?? {}), false)
})
