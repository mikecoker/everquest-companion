// CW7 — A `/who` ROW IS GROUND TRUTH AT ITS TIMESTAMP, AND NO MERGE MAY OUTRANK IT (JOS-287).
//
// Its own file for the same reason CW6 has one: comboWindows.test.mts is at the measured
// 400-code-line ceiling, and this is a boundary RULE rather than another window over the same one.
//
// THE DEFECT. `mergeBoundaries` reads two overlapping detector windows as "one swap, dated twice",
// keeps the narrower window and cuts at the earliest `at` in the group. That is the right answer
// for two INFERENCES about the same event (CW2's shift narrowing a 33.9 h ding, CW5's reinstated
// ding) and a false one the moment a `/who` cut is in the group, because a row is not a window
// over a swap — it is the game naming the loadout at an instant.
//
// MEASURED on the owner's log at 2026-08-13 (1.63M lines, 15 self rows). The Aug 12 re-roll dinged
// NON-INCREASING (50 → 11), so its level-drop window opened at the previous ding on Aug 06
// 22:27:32 — six days — and overlapped all four `/who` cuts inside it. One boundary came out where
// there were four; the slice in front of it held rows that contradict each other; and `slotsFor`'s
// last-row rule stated `PAL/ROG/BER` over the Aug 09 10:41:31 `[50 PAL/MNK/ENC]` row, over the
// three days behind it and over the whole wizard era. Both live-log tripwires fired — the row
// reproduction arm in comboWindows.test.mts and the backwards-reach arm in comboWhoBoundary.
//
// THE RULE (`resolveGroup`, src/main/modules/comboIntervals.ts). Every distinct `/who` cut in a
// merge group survives at its own instant; an inferred detector whose window CONTAINS a row cut is
// that same swap dated better by the game, so it is absorbed and recorded in `also`; an inferred
// detector no row dated keeps its own boundary. And because a cut the merge can still absorb is an
// INFERRED one, `buildIntervals` asks the `/who` PAIR rule its question a second time against the
// boundaries that actually survived — so no slice can ever hold two rows that disagree.
//
// THE FIXTURE IS THE SHAPE, FROZEN. `cw7-who-swap-boundary-aug12.log` is five small ranges of the
// real log (tests/extract-combo-fixtures.mjs, shared scrub, real parser): the Aug 06 ding that
// opens the window, the four rows, and the Aug 12 ding that closes it. 72 lines. Verified against
// the pre-fix model: it reports TWO intervals, the second stating `PAL/RNG/SHM` from Aug 10
// 20:13:00 — the Aug 12 row applied backwards over both rows in front of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { ComboModule } from '../src/main/modules/combo'
import { levelDropBoundaries, mergeBoundaries, type Boundary } from '../src/main/modules/comboIntervals'
import { comboAt } from '../src/shared/comboIndex'
import { resolvedClasses, type ComboSnap } from '../src/shared/classCombo'
import { readFixture } from './harness.mts'

/** The tailed character — the `/who` rule keys the self row on THIS name and nothing else. */
const SELF = 'Primitive'

const at = (stamp: string): number => parseEqTimestamp(stamp)

const FIXTURE = 'cw7-who-swap-boundary-aug12.log'

function replay(lines: string[]): ComboSnap {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const mod = new ComboModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

/** The rows the fixture states, read back through the real parser. */
function rowsOf(lines: string[]): { ts: number; classes: string[]; raw: string }[] {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const out: { ts: number; classes: string[]; raw: string }[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'selfWho') out.push({ ts: ev.ts, classes: ev.classes, raw: ev.raw })
  }
  return out
}

test('CW7: every /who row in the span is reproduced by the interval covering it', () => {
  // The live tripwire's question, asked of a fixture that can never grow: for each row, the
  // interval containing it states exactly that loadout. Derived from the fixture's own rows rather
  // than from a frozen list, so the assertion is the LAW and not a transcript of one log state.
  const lines = readFixture(FIXTURE)
  const intervals = replay(lines).intervals
  const rows = rowsOf(lines)
  assert.equal(rows.length, 4, 'the fixture states four loadouts')
  for (const row of rows) {
    const interval = comboAt(intervals, row.ts)
    assert.ok(interval, `no interval covers ${row.raw}`)
    assert.equal(resolvedClasses(interval).join('/'), row.classes.join('/'), row.raw)
  }
})

test('CW7: a later row never reaches back across the swap boundary in front of it', () => {
  // The same failure stated as what it costs. Each row opens the era it names and closes the era
  // before it; nothing a row says is applied to a span another row already spoke for.
  const snap = replay(readFixture(FIXTURE))
  assert.deepEqual(
    snap.intervals.map((i) => [
      resolvedClasses(i).join('/'),
      i.startTs,
      i.endTs
    ]),
    [
      ['PAL/MNK/ENC', at('Thu Aug 06 22:27:16 2026'), at('Mon Aug 10 20:13:00 2026')],
      ['PAL/ROG/BER', at('Mon Aug 10 20:13:00 2026'), at('Tue Aug 11 21:01:24 2026')],
      ['PAL/MNK/ENC', at('Tue Aug 11 21:01:24 2026'), at('Wed Aug 12 22:42:20 2026')],
      ['PAL/RNG/SHM', at('Wed Aug 12 22:42:20 2026'), null]
    ],
    'four rows, four eras, each cut at the row that states it'
  )
  // The one the tripwire named: the Aug 09 morning is PAL/MNK/ENC and stays PAL/MNK/ENC.
  const morning = comboAt(snap.intervals, at('Sun Aug 09 10:41:31 2026'))
  assert.equal(resolvedClasses(morning!).join('/'), 'PAL/MNK/ENC')
  for (const slot of morning!.slots) assert.equal(slot.provenance, 'who', 'stated, not inferred')
  assert.ok(
    morning!.endTs !== null && morning!.endTs <= at('Mon Aug 10 20:13:00 2026'),
    'and it ENDS no later than the row that replaced it'
  )
})

test('CW7: the six-day ding window corroborates a row cut instead of replacing four of them', () => {
  // The mechanism, asserted rather than assumed. The drop really is six days wide and really does
  // cover every row cut — that is what made the merge group — and the model still reports one
  // boundary per row, with the ding recorded as corroboration on the swap it was describing.
  const lines = readFixture(FIXTURE)
  const levels: { ts: number; level: number }[] = []
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'level') levels.push({ ts: ev.ts, level: ev.level })
  }
  const drops = levelDropBoundaries(levels)
  assert.equal(drops.length, 1, 'one non-increasing ding: 50 → 11 on the re-roll')
  assert.equal(drops[0].lo, at('Thu Aug 06 22:27:32 2026'), 'the window opens at the previous ding')
  assert.equal(drops[0].hi, at('Wed Aug 12 22:47:00 2026'), 'and closes at the re-roll ding')
  assert.ok(drops[0].hi - drops[0].lo > 5 * 24 * 3_600_000, 'six days of not-knowing')

  const intervals = replay(lines).intervals
  const stated = intervals.filter((i) => i.startReason === 'who')
  assert.equal(stated.length, 3, 'every row after the first opens its own boundary')
  for (const interval of stated) {
    assert.ok(
      interval.startTs > drops[0].lo && interval.startTs <= drops[0].hi,
      `${interval.id} sits inside the ding window that used to swallow it`
    )
  }
  const reroll = intervals[intervals.length - 1]
  assert.equal(reroll.startTs, at('Wed Aug 12 22:42:20 2026'), 'the ROW dates the re-roll')
  assert.deepEqual(reroll.startAlso, ['levelDrop'], 'and the ding says so beside it')
})

test('a /who cut is never merged away, however wide the window over it', () => {
  // The rule on its own, away from any log: one inferred window covering three row cuts. Before
  // JOS-287 this returned a single boundary — the narrowest window in the group, cut at the
  // earliest `at` in it, clamped into that window. A row is ground truth at its timestamp, so all
  // three survive, and the inferred detector is recorded on the row cut nearest its own date.
  const HOUR = 3_600_000
  const t0 = at('Sun Aug 09 10:00:00 2026')
  const wide: Boundary = { lo: t0, hi: t0 + 6 * HOUR, at: t0 + 6 * HOUR, reason: 'levelDrop' }
  const rows: Boundary[] = [1, 3, 5].map((h) => ({
    lo: t0 + h * HOUR - 60_000,
    hi: t0 + h * HOUR,
    at: t0 + h * HOUR,
    reason: 'who'
  }))
  const merged = mergeBoundaries([wide, ...rows])
  assert.deepEqual(
    merged.map((b) => b.at),
    rows.map((b) => b.at),
    'three statements, three cuts — and the ding is not a fourth'
  )
  assert.deepEqual(merged[2].also, ['levelDrop'], 'the ding corroborates the swap it was nearest')
  assert.equal(merged[0].also, undefined)

  // An inferred window NO row dated is a swap nothing stated, and it keeps its own boundary.
  const undated: Boundary = {
    lo: t0 + 5 * HOUR,
    hi: t0 + 5.5 * HOUR,
    at: t0 + 5.5 * HOUR,
    reason: 'evidenceShift'
  }
  assert.deepEqual(
    mergeBoundaries([wide, ...rows, undated]).map((b) => b.at),
    [...rows.map((b) => b.at), undated.at],
    'the shift the rows do not cover survives'
  )
})
