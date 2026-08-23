// "DEFEATED ONLY" MEANS TWO DIFFERENT THINGS (JOS-237) — the raid roster's toolbar filter, read
// against the same real kill histories tests/bossLockouts.test.mts replays.
//
// OWNER-REPORTED 2026-08-12, release-testing: the switch does not work right on the THIS WEEK
// view. It filtered on `s.killed` — the ALL-TIME flag — in BOTH modes, so the week view answered
// "ever defeated" while everything else on the card (the corner chip, the five rungs, the tally)
// answered "this reset week". A boss cleared three weeks ago and not since stayed on screen with
// five grey rungs under it, which is precisely the card a coordinator flips the switch to lose.
//
// THE FIX IS ONE PREDICATE PER MODE (src/renderer/src/features/bosses/rosterFilter.ts), and the
// week one is `tierLocks` over the window the view already computes for the ladder — so the switch
// and the rungs cannot disagree: a card survives exactly when at least one of its rungs is green.
// There is no second clock; the reset arithmetic and its sources stay lockout.ts's alone.
//
// WHY THE HISTORIES ARE THE REAL ONES. The whole defect is a disagreement between two readings of
// ONE record, so hand-building a status for each reading would assume away the thing being tested.
// These are the committed fixtures: Lord of Ire's Sat Aug 01 d4 clear (the boss killed LAST week),
// Maestro of Rancor's five-rung Sat Aug 01 afternoon, and Master of Spite's open-world kills
// either side of the Tue Aug 04 reset.
//
// THE TZ PIN is the same one bossLockouts.test.mts states at length: the fixtures' EQ timestamps
// parse to LOCAL epochs, so an unpinned machine would be asserting its own zone. node:test runs
// each file in its own process, so this pin is this file's alone — and tests/bossHistories.mts
// deliberately parses nothing at import time, which is what lets the pin below still be first.
//
// Run: `npm test`.

process.env.TZ = 'America/Los_Angeles'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEqTimestamp } from '../src/main/log/parser'
import { lockoutWindow, tierLadder, tierLocks, type LockoutWindow } from '../src/renderer/src/features/bosses/lockout'
import {
  defeatedThisWeek,
  everDefeated,
  filterRoster
} from '../src/renderer/src/features/bosses/rosterFilter'
import { byName, hateWeek, history } from './bossHistories.mts'

/** The week Lord of Ire's d4 clear is inside: Tue Jul 28 08:00 Pacific → Tue Aug 04 08:00. */
const BEFORE_RESET = lockoutWindow(parseEqTimestamp('Mon Aug 03 23:30:00 2026'))
/** The week after it: the same record, one Tuesday later. */
const AFTER_RESET = lockoutWindow(parseEqTimestamp('Wed Aug 05 12:00:00 2026'))

test('the pin took — every assertion here dates a fixture kill', () => {
  assert.equal(new Date(2026, 6, 15).getTimezoneOffset(), 420, 'July is PDT (UTC-7)')
})

test('THE BUG: a boss killed LAST week is defeated all-time and open this one', () => {
  // The ticket's acceptance criterion, on the record bossLockouts already reads three ways. Lord
  // of Ire's only lockout-taking kill is the Sat Aug 01 d4 clear — inside the week that closes
  // Tue Aug 04 08:00, outside the one that opens with it.
  const ire = byName(history(), 'Lord of Ire')
  assert.equal(everDefeated(ire), true, 'the OVERALL roster still has him: progression is forever')
  assert.equal(defeatedThisWeek(BEFORE_RESET)(ire), true, 'and that week he was taken')
  assert.equal(
    defeatedThisWeek(AFTER_RESET)(ire),
    false,
    'one Tuesday later he is open again — which is what the week view must say'
  )
  assert.equal(everDefeated(ire), true, 'while the all-time reading never moved')
})

test('a boss killed THIS week passes both readings', () => {
  // Maestro of Rancor's five clears all landed Sat Aug 01, inside the pre-reset week.
  const maestro = byName(hateWeek(), 'Maestro of Rancor')
  assert.equal(everDefeated(maestro), true)
  assert.equal(defeatedThisWeek(BEFORE_RESET)(maestro), true, 'five locks is emphatically non-empty')
  assert.equal(
    tierLocks(maestro.tiers, BEFORE_RESET).length > 0,
    defeatedThisWeek(BEFORE_RESET)(maestro),
    'the predicate IS the lock set — there is no second definition of "this week"'
  )
})

test('the week reading inherits every qualification tierLocks makes', () => {
  // Master of Spite is killed, credited, twice — one kill inside EACH of the two weeks — and both
  // were in the OPEN WORLD, which takes no lockout (JOS-166). So he is defeated all-time and never
  // defeated-this-week, in either week. A filter written as "a kill inside the window" rather than
  // as "a LOCK inside the window" would show him under a switch whose five rungs are all grey.
  const spite = byName(hateWeek(), 'Master of Spite')
  assert.equal(everDefeated(spite), true, 'both kills are on the roster')
  for (const [label, w] of [['before', BEFORE_RESET], ['after', AFTER_RESET]] as const) {
    assert.equal(defeatedThisWeek(w)(spite), false, `${label} the reset: no lockout was ever taken`)
    assert.equal(
      tierLadder(tierLocks(spite.tiers, w)).some((r) => r.cleared),
      defeatedThisWeek(w)(spite),
      `${label} the reset: the switch agrees with the card's own rungs`
    )
  }
})

test('the roster filter narrows by the mode predicate AND the search box', () => {
  const list = history() // Lord of Ire (a d4 clear) + Thunder Spirit Princess (open world only)
  const none = { query: '', defeatedOnly: false, defeated: everDefeated }
  assert.equal(filterRoster(list, none), list, 'an untouched toolbar hands back the same array')

  assert.deepEqual(
    filterRoster(list, { ...none, defeatedOnly: true }).map((s) => s.target.name),
    ['Lord of Ire', 'Thunder Spirit Princess'],
    'ALL-TIME: both have kills on the record, open-world ones included'
  )

  const thisWeek = (w: LockoutWindow, query = ''): string[] =>
    filterRoster(list, { query, defeatedOnly: true, defeated: defeatedThisWeek(w) }).map(
      (s) => s.target.name
    )
  assert.deepEqual(thisWeek(BEFORE_RESET), ['Lord of Ire'], 'THIS WEEK: only the d4 clear counts')
  assert.deepEqual(thisWeek(AFTER_RESET), [], 'and after the reset the week view has nothing left')
  assert.deepEqual(thisWeek(BEFORE_RESET, 'lord'), ['Lord of Ire'], 'the search still applies')
  assert.deepEqual(thisWeek(BEFORE_RESET, 'princess'), [], 'both filters, never either')
  assert.deepEqual(
    filterRoster(list, { ...none, query: 'princess' }).map((s) => s.target.name),
    ['Thunder Spirit Princess'],
    'and the search on its own is unchanged by any of this'
  )
})
