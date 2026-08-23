// CW6 — A `/who` ROW STATES YOUR LOADOUT WHERE IT STANDS, NOT BACKWARDS (JOS-192).
//
// Its own file for the reason comboWindows.test.mts's other neighbours have theirs: that file is
// at the measured 400-code-line ceiling, and this is a rule of its own rather than another window
// over the same one.
//
// THE DEFECT. A loadout swap prints nothing, so the only move a player has when the app names the
// trio they left is to type `/who` on themselves. `whoBoundaries` needs TWO rows to disagree, and
// the log holds thirteen rows in 1.57M lines — so inside a slice nothing else cut, `slotsFor`
// rule 1 took the LAST row in the slice and stated the WHOLE slice with it. The correction was
// applied backwards over every hour that slice already covered, and the honest pre-swap inference
// was the thing it overwrote. That is the other half of trigger report 01KZP6SDZJK6BPEWA4Z0MF5ANG.
//
// THE RULE (`whoShiftBoundaries`, src/main/modules/comboIntervals.ts). When the evidence in front
// of a row, inside its own segment, SUSTAINS a class the row does not name, the game and the log
// disagree about the same span — which can only mean a swap between them — so the boundary is cut
// AT THE ROW and the span before it keeps what it inferred.
//
// The fixture is `cw1-who-anchored.log`, already committed and already cut through the shared
// scrub for the golden windows. It contains the case whole: a repeat level ding at 16:46:22, monk
// evidence for the 24 minutes after it, and a `/who` at 17:25:15 naming no monk.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEqTimestamp, parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { EpochDetector } from '../src/main/log/epochDetector'
import { ComboModule } from '../src/main/modules/combo'
import { classObservation } from '../src/main/modules/comboEvidence'
import { whoShiftBoundaries } from '../src/main/modules/comboIntervals'
import { resolvedClasses, type ClassAbbr, type ClassObservation, type ComboSnap } from '../src/shared/classCombo'
import { readFixture } from './harness.mts'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** The tailed character — the `/who` rule keys the self row on THIS name and nothing else. */
const SELF = 'Primitive'

const at = (stamp: string): number => parseEqTimestamp(stamp)

/** Replay lines through the real parser into a fresh combo module (comboWindows' own harness). */
function replay(lines: string[], opts: { epochs?: boolean } = {}): ComboSnap {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const mod = new ComboModule()
  mod.reset()
  const epoch = new EpochDetector()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (opts.epochs) {
      const boundary = epoch.observe(ev)
      if (boundary) mod.onEvent(boundary)
    }
    mod.onEvent(ev)
  }
  return mod.snapshot().state
}

/** Every observation a line set yields — the input the SCORER sees. */
function observationsOf(lines: string[]): ClassObservation[] {
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const out: ClassObservation[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    const observation = ev ? classObservation(ev) : null
    if (observation) out.push(observation)
  }
  return out
}

/**
 * Classes an observation stream names EXCLUSIVELY in ≥2 distinct hourly buckets — the same bar
 * `comboIntervals.exclusiveSpans` applies, restated from the observations so the assertion checks
 * the module against the LOG rather than against itself. `/who` never scores (§ 4.4).
 */
function sustainedExclusive(observations: readonly ClassObservation[]): Set<ClassAbbr> {
  const buckets = new Map<ClassAbbr, Set<number>>()
  for (const o of observations) {
    if (o.source === 'who' || o.candidates.length !== 1) continue
    const seen = buckets.get(o.candidates[0]) ?? new Set<number>()
    seen.add(Math.floor(o.ts / 3_600_000))
    buckets.set(o.candidates[0], seen)
  }
  return new Set([...buckets].filter(([, b]) => b.size >= 2).map(([cls]) => cls))
}

test('CW6: a /who the evidence contradicts cuts at itself instead of relabelling the slice', () => {
  // The Jul 28 excursion, read as the two spans it always was. The ding at 16:46:22 opened a
  // span; the `/who` at 17:25:15 named `PAL/ROG/ENC`; and between them the character was swinging
  // MONK skills, which that row names no class for. So the row cuts at 17:25:15 and the span in
  // front of it keeps its own reading.
  const snap = replay(readFixture('cw1-who-anchored.log'))
  const [beforeRow, atRow] = [snap.intervals[2], snap.intervals[3]]

  assert.equal(beforeRow.startTs, at('Tue Jul 28 16:46:22 2026'), 'opens at the repeat ding')
  assert.equal(beforeRow.endTs, at('Tue Jul 28 17:25:15 2026'), 'and CLOSES at the /who row')
  for (const slot of beforeRow.slots) {
    assert.equal(slot.provenance, 'inferred', 'the pre-row span keeps what the LOG showed')
  }
  assert.equal(
    resolvedClasses(beforeRow).includes('MNK'),
    true,
    'monk was evidenced here and is not overwritten by a row 39 minutes later'
  )
  assert.equal(
    resolvedClasses(beforeRow).includes('ROG'),
    false,
    'and the row 39 minutes later does not retro-fit its rogue onto it'
  )

  assert.equal(atRow.startTs, at('Tue Jul 28 17:25:15 2026'))
  assert.equal(atRow.startReason, 'who', 'the game spoke; the cut goes exactly there')
  assert.deepEqual(resolvedClasses(atRow), ['PAL', 'ROG', 'ENC'], 'and the row states this span')
  for (const slot of atRow.slots) assert.equal(slot.provenance, 'who')
  // The window is honest at BOTH ends: it opens no earlier than the last word of the class that
  // is gone (a Mend skill-up at 17:00:36 — MNK's final observation in the span) and closes at the
  // row. 24.7 minutes, against the three hours the /who PAIR rule could have offered.
  assert.equal(atRow.startLo, at('Tue Jul 28 17:00:36 2026'), 'last MNK-exclusive observation')
  assert.equal(atRow.startHi, at('Tue Jul 28 17:25:15 2026'), 'the row itself')
  assert.ok(atRow.startHi - atRow.startLo < 25 * 60_000)
})

test('CW6: a /who row that AGREES with the evidence cuts nothing', () => {
  // The anti-thrash half, and the reason CW1 is five intervals rather than seven. Four of the
  // fixture's seven rows say `PAL/MNK/ENC` in a row (20:16:48, 20:30:29, 20:31:47, 20:42:43) and
  // the evidence between them names nothing they exclude — so exactly ONE interval covers all
  // four. A rule that cut at every row would put a boundary at each, and `mergeable` refuses to
  // collapse a `who` boundary, so the confetti would be permanent.
  const snap = replay(readFixture('cw1-who-anchored.log'))
  const covering = snap.intervals.filter(
    (i) =>
      i.startTs <= at('Tue Jul 28 20:42:43 2026') &&
      (i.endTs === null || i.endTs > at('Tue Jul 28 20:16:48 2026'))
  )
  assert.equal(covering.length, 1, 'four agreeing rows, one interval')
  assert.equal(covering[0].startTs, at('Tue Jul 28 20:16:48 2026'))
})

test('CW6: the detector is silent unless a SUSTAINED class is missing from the row', () => {
  // The rule, exercised directly on synthetic evidence so each half of it is visible. The bar is
  // `exclusiveSpans`': a class the row omits, named exclusively in ≥2 distinct hourly buckets.
  const HOUR = 3_600_000
  const t0 = at('Tue Jul 28 12:00:00 2026')
  const obs = (
    ts: number,
    candidates: ClassAbbr[],
    source: ClassObservation['source'] = 'skillUp'
  ): ClassObservation => ({ ts, seq: ts, source, label: candidates.join('|'), candidates, weight: 1 })
  const row = { ts: t0 + 3 * HOUR, seq: 999, classes: ['PAL', 'ROG', 'ENC'] as ClassAbbr[], level: 20 }

  // Two buckets of MNK-exclusive evidence, and the row names no monk ⇒ a cut at the row.
  const cut = whoShiftBoundaries([obs(t0, ['MNK']), obs(t0 + HOUR, ['MNK'])], [row], [], t0)
  assert.equal(cut.length, 1)
  assert.equal(cut[0].at, row.ts, 'the cut is the row itself')
  assert.equal(cut[0].lo, t0 + HOUR, 'and the window opens at the departing class’s last word')
  assert.equal(cut[0].reason, 'who')

  // ONE bucket is not sustained — the same floor every other detector here applies.
  assert.deepEqual(whoShiftBoundaries([obs(t0, ['MNK'])], [row], [], t0), [], 'one bucket is noise')
  // Evidence that only names classes the row DOES name is agreement, not contradiction.
  assert.deepEqual(
    whoShiftBoundaries([obs(t0, ['ROG']), obs(t0 + HOUR, ['ROG'])], [row], [], t0),
    [],
    'the row and the log agree'
  )
  // An AMBIGUOUS observation names no class exclusively and can never contradict anything.
  assert.deepEqual(
    whoShiftBoundaries([obs(t0, ['CLR', 'PAL']), obs(t0 + HOUR, ['CLR', 'PAL'])], [row], [], t0),
    [],
    'a candidate SET is not a departure'
  )
  // A `/who` observation is a STATEMENT, never a score (§ 4.4) — including its own single-class
  // form, which would otherwise draw an exclusive span and contradict the next row.
  assert.deepEqual(
    whoShiftBoundaries([obs(t0, ['WAR'], 'who'), obs(t0 + HOUR, ['WAR'], 'who')], [row], [], t0),
    [],
    'a row never scores against another row'
  )
  // Already cut there ⇒ nothing to add; the boundary that exists IS this swap.
  assert.deepEqual(
    whoShiftBoundaries(
      [obs(t0, ['MNK']), obs(t0 + HOUR, ['MNK'])],
      [row],
      [{ lo: t0, hi: row.ts, at: row.ts, reason: 'levelDrop' }],
      t0
    ),
    [],
    'a dated boundary at the row is not doubled'
  )
})

test('full-log replay: no /who row is applied BACKWARDS over evidence it contradicts', { skip: !existsSync(LOG) }, () => {
  // THE REGRESSION GUARD for JOS-192, and the exact complement of the test above. That one asks
  // "does the interval covering a row state that row" — which the OLD model also passed, by the
  // brute-force route of stating the row over every hour of the slice it happened to land in.
  // This one asks what that route cost: how far BACK does a row reach, and is there evidence in
  // there that the row's own words exclude?
  //
  // The reach is `[interval.startTs, firstRow.ts)` — the span a stated interval covers before
  // anything stated it. It should hold nothing the row denies, because a class sustained there
  // and absent from the row IS a swap, and the swap belongs at the row.
  //
  // MEASURED on the owner's log at 2026-08-10 (1.57M lines, 13 self rows). Before the change:
  // 9 intervals, and `ci8` ran Aug 04 23:38:01 → Aug 10 19:59:48 stated `PAL/MNK/ENC` by the
  // Aug 09 10:41:31 row — six days reached backwards, swallowing the entire wizard era CW5 pins
  // as real (the first `Shock of Lightning` lands Aug 06 19:31:49 and WIZ is exclusively
  // evidenced for hours after it). After: 11 intervals, the wizard era keeps its own inferred
  // span, and the row opens a new one at itself. This assertion is what fails if that returns.
  //
  // FORWARDS IS A DIFFERENT QUESTION AND IS DELIBERATELY NOT ASSERTED HERE. A row can also be
  // followed, inside its own interval, by evidence it denies — `ci2` (Jul 28 14:13–16:46, stated
  // `PAL/ENC`) sustains MNK after its row. That is a swap AFTER the statement, which is
  // `evidenceShiftBoundaries`' job, and it misses this one because a 2-slot era is scored against
  // a 3-slot over-determination bar (see `buildIntervals`). Pre-existing, unrelated to the reach
  // this test measures, and named rather than quietly excluded.
  //
  // The bar is `exclusiveSpans`' own — ≥2 distinct hourly buckets of evidence naming ONE class —
  // so a stray out-of-loadout cast (CW4) can never trip it, and `/who` observations are excluded
  // because a row is a statement rather than a score (§ 4.4).
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  const intervals = replay(lines, { epochs: true }).intervals
  const observations = observationsOf(lines).filter((o) => o.ts >= intervals[0].startTs)
  installSpellDb(loadSpellDb())
  installCharacterName(SELF)
  const rows: { ts: number; classes: string[] }[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'selfWho' && ev.ts >= intervals[0].startTs) rows.push({ ts: ev.ts, classes: ev.classes })
  }
  let reached = 0
  for (const interval of intervals) {
    if (!interval.slots.every((s) => s.provenance === 'who')) continue
    const first = rows.find(
      (r) => r.ts >= interval.startTs && (interval.endTs === null || r.ts < interval.endTs)
    )
    if (!first || first.ts === interval.startTs) continue
    reached++
    const back = observations.filter((o) => o.ts >= interval.startTs && o.ts < first.ts)
    for (const cls of sustainedExclusive(back)) {
      assert.ok(
        first.classes.includes(cls),
        `${interval.id} states ${first.classes.join('/')} from a row at ` +
          `${new Date(first.ts).toISOString()} yet the ${String(Math.round((first.ts - interval.startTs) / 60_000))} ` +
          `minutes before it sustain ${cls}`
      )
    }
  }
  assert.ok(reached >= 2, `expected several rows reaching back into their interval, found ${reached}`)
})
