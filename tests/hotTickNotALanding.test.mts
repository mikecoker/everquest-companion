// A HoT TICK IS NOT A LANDING (JOS-280) — the regression pin for the guard at the top of
// `BuffsModule.onHeal`.
//
// THE DEFECT, as the reporter described it (feedback 01KZVRZQNGJCG3V4KJFEVN6P86, v0.23.0) and as
// the characterization replay confirmed line for line: a heal-over-time prints
//
//     You healed <target> over time for N hit points by <Spell>.
//
// once per tick, with the spell's BASE name — no roman numeral, whatever rank you cast. `onHeal`
// never asked whether the line was a tick, so every six seconds it re-entered the landing path on
// the rank-stripped name. Three things followed, all of them visible on the buff bar:
//   1. `land()` restarted the clock, so a 41-second bar reset to full every six seconds and never
//      agreed with the buff the game was actually running;
//   2. `openRecord` writes "the NEWEST landing's word on what was cast, including nothing extra"
//      (buffsInstances.ts), and the tick states nothing — so `castName` was overwritten with
//      undefined and the rank chip vanished a tick after it appeared;
//   3. the tick→fade span became the duration SAMPLE the learner minted, so the model taught
//      itself a five-second duration for a spell that runs forty.
// And a tick arriving AFTER the wear-off opened the instance again from nothing: a phantom bar for
// a buff the log had just said was gone.
//
// The fix is one guard, and it is the JOS-118 law one lane over: an instance opens only from a
// line that CONFIRMS a landing. A tick confirms that a buff which landed EARLIER is still
// running — it is cast-detached by construction, which is exactly why `buffFanOut.onHeal`
// (buffFanOut.ts:88) has refused the same event since JOS-118.
//
// WHAT STAYS: the DIRECT heal line. `You healed Primitive … by Symbol of Pinzarn.` is how the
// Quick Buff burst's self buffs become visible at all (W7 in messageDrivenWindows.test.mts,
// W17b in refinementWindows.test.mts) — that arm carries no `over time` and is untouched here.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture, replayBuffTimers, tsOf, findActive } from './harness.mts'
import { rowRankLabel } from '../src/shared/buffTimers'

const at = (stamp: string): number => tsOf(`[${stamp} 2026] x`)

// ─────────────────────────────────────────────────────────────────────────────
// THE WINDOW — tests/fixtures/w42-effect-proc-resist.log, the owner's REAL bytes, Mon Aug 03.
// Ethereal Cleansing (Paladin 44, DB duration 24 s, "Increase Hitpoints by 10 per tick") is cast
// twice against Lord of Ire and both cycles run start to finish inside the fixture:
//
//   23:01:19  Your Ethereal Cleansing spell fizzles!
//   23:01:20  You begin casting Ethereal Cleansing.
//   23:01:20  Ethereal light pumps through your body.          ← THE LANDING
//   23:01:25 … 23:01:55  You healed Primitive over time for 102 hit points by Ethereal Cleansing.
//                                                              ← six ticks, every 6 s
//   23:02:00  The ethereal light fades.                        ← THE WEAR-OFF (40 s after landing)
//   23:02:01  You healed Primitive over time …                 ← THE POST-FADE TICK
//   23:02:02  You begin casting Ethereal Cleansing. / Ethereal light pumps through your body.
//   23:02:07 … 23:02:37  seven more ticks
//   23:02:42  The ethereal light fades.                        ← 40 s again
//   23:02:43  You healed Primitive over time …                 ← the second post-fade tick
//
// The bar is read through the real projection (`replayBuffTimers` → `buildTimerRows`), which is
// what the buffs overlay draws.
const LANDING_1 = at('Mon Aug 03 23:01:20')
const LANDING_2 = at('Mon Aug 03 23:02:02')
const TICKS_1 = ['23:01:25', '23:01:31', '23:01:37', '23:01:43', '23:01:49', '23:01:55']

test('JOS-280 (a) a HoT tick never restarts the bar: startedTs stays at the landing', () => {
  const lines = readFixture('w42-effect-proc-resist.log')
  for (const tick of TICKS_1) {
    // Observe one second AFTER each tick, so the tick is inside the fold.
    const observe = at(`Mon Aug 03 ${tick}`) + 1000
    const { rows, buffs } = replayBuffTimers(lines, { until: observe, tickMs: observe })
    const row = rows.find((r) => r.name === 'Ethereal Cleansing')
    assert.ok(row, `the bar is still up one second after the ${tick} tick`)
    assert.equal(
      row.startedTs,
      LANDING_1,
      `the ${tick} tick must not re-land: startedTs stays at the 23:01:20 landing`
    )
    // Same reading on the instance the row projects from.
    const active = findActive(buffs, 'ethereal cleansing')
    assert.equal(active?.startedTs, LANDING_1, 'the ActiveBuff agrees with the row')
  }
})

test('JOS-280 (a2) the SECOND cycle is one landing too, not seven', () => {
  const lines = readFixture('w42-effect-proc-resist.log')
  const observe = at('Mon Aug 03 23:02:38')
  const { rows } = replayBuffTimers(lines, { until: observe, tickMs: observe })
  const row = rows.find((r) => r.name === 'Ethereal Cleansing')
  assert.ok(row, 'the re-cast bar is up')
  assert.equal(row.startedTs, LANDING_2, 'startedTs is the 23:02:02 landing, not the last tick')
  // AND THE SECOND BAR IS ALREADY WISER THAN THE FIRST. The first cycle closed at 23:02:00 with a
  // clean 40 s sample, which beats the DB's 24 s baseline, so this row counts down against what
  // the log measured rather than against the wiki. Before the fix that first sample was the 5 s
  // tick→fade sliver and the row here read the DB's 24 000 — the learner had nothing true to say.
  assert.equal(row.durationMs, 40_000, 'the row counts down against the cycle just observed')
})

test('JOS-280 (c) a tick that arrives AFTER the wear-off opens nothing', () => {
  const lines = readFixture('w42-effect-proc-resist.log')
  for (const [fade, tick] of [
    ['Mon Aug 03 23:02:00', 'Mon Aug 03 23:02:01'],
    ['Mon Aug 03 23:02:42', 'Mon Aug 03 23:02:43']
  ] as const) {
    const atFade = at(fade)
    const cleared = replayBuffTimers(lines, { until: atFade, tickMs: atFade })
    assert.equal(
      cleared.rows.find((r) => r.name === 'Ethereal Cleansing'),
      undefined,
      `"The ethereal light fades." at ${fade.slice(-8)} takes the bar down`
    )
    const atTick = at(tick)
    const after = replayBuffTimers(lines, { until: atTick, tickMs: atTick })
    assert.equal(
      after.rows.find((r) => r.name === 'Ethereal Cleansing'),
      undefined,
      `the ${tick.slice(-8)} tick must NOT resurrect a phantom bar`
    )
    assert.equal(findActive(after.buffs, 'ethereal cleansing'), undefined, 'and no instance either')
  }
})

test('JOS-280 the duration learner reads the real cycle, not a tick-to-fade sliver', () => {
  const lines = readFixture('w42-effect-proc-resist.log')
  const observe = at('Mon Aug 03 23:02:50')
  const { spellStats } = replayBuffTimers(lines, { until: observe, tickMs: observe })
  const stat = spellStats.statFor('ethereal cleansing')
  assert.ok(stat, 'both cycles minted a sample')
  // TWO cycles, each landing→fade: 23:01:20→23:02:00 and 23:02:02→23:02:42. Both are 40 s.
  //
  // THESE NUMBERS MOVED WITH THE FIX, and the move is the correction: before the guard the last
  // TICK stood in for the landing, so each cycle minted the 5 s sliver between the final tick and
  // the fade — median 5 000 ms for a spell this window shows running for 40 s, twice. The
  // estimator then read `observedMax 5 000 < dbMs 24 000` and fell back to the wiki's 24 s
  // (`estimatorSource: 'db'`), which is why the poisoning was invisible on the bar: the learner
  // was wrong in a direction the DB baseline happened to paper over. It is now RIGHT, and says so
  // — 40 s beats the DB baseline, so the estimate is `observed`. This log's own bytes are the
  // authority on how long the spell ran; the wiki's 24 s is a claim about a different rank.
  assert.equal(stat.n, 2, 'two clean landing→fade cycles')
  assert.equal(stat.medianMs, 40_000, 'the observed cycle is 40 s (was a 5 s tick→fade sliver)')
  assert.equal(stat.minMs, 40_000)
  assert.equal(stat.maxMs, 40_000)
  assert.equal(stat.dbDurationMs, 24_000, 'the wiki baseline is unchanged — only the samples moved')
  assert.equal(stat.estimateMs, 40_000, 'the estimate is now what the log measured')
  assert.equal(stat.estimatorSource, 'observed', 'and it no longer falls back to the DB')
})

// ─────────────────────────────────────────────────────────────────────────────
// (b) THE RANK CHIP — the half of the defect the owner's log cannot show.
//
// A REPORTER'S SLICE NEVER BECOMES A FIXTURE (AGENTS.md), so the window above stays the owner's
// real bytes. But the owner has never cast a RANKED heal-over-time: every `over time` line in
// every committed fixture is Ethereal Cleansing / Echoing Light / Celestial Echo / Sprouting Heal,
// all cast unranked, so w42 has no roman numeral for a tick to erase. The rank chip is therefore
// pinned by INJECTION, the petClaimWindows / mobLifetapPlayer precedent: the sentences below are
// quoted VERBATIM from feedback 01KZVRZQNGJCG3V4KJFEVN6P86's slice (lines 199/223/264/282), with
// the reporter's character name swapped for the owner's. Celestial Remedy is a real row of the
// committed spell DB (Cleric 19, 24 s, "Celestial light pumps through your body."), so the real
// parser and the real module fold these exactly as they folded the reporter's log.
//
// This is the reporter's own sentence, and it is the whole bug in one line: the cast says
// `Celestial Remedy III`, the tick says `Celestial Remedy`.
const REPORTER_LINES = [
  '[Wed Aug 12 12:30:24 2026] You begin casting Celestial Remedy III.',
  '[Wed Aug 12 12:30:25 2026] Celestial light pumps through your body.',
  '[Wed Aug 12 12:30:26 2026] You healed Primitive over time for 61 hit points by Celestial Remedy.',
  '[Wed Aug 12 12:30:44 2026] You healed Primitive over time for 61 hit points by Celestial Remedy.',
  '[Wed Aug 12 12:30:51 2026] You healed Primitive over time for 61 hit points by Celestial Remedy.'
]

test('JOS-280 (b) the rank chip survives the ticks — the reporter’s exact complaint', () => {
  const landed = at('Wed Aug 12 12:30:25')
  for (const stamp of ['Wed Aug 12 12:30:25', 'Wed Aug 12 12:30:27', 'Wed Aug 12 12:30:45', 'Wed Aug 12 12:30:52']) {
    const observe = at(stamp)
    const { rows } = replayBuffTimers(REPORTER_LINES, { until: observe, tickMs: observe })
    const row = rows.find((r) => r.name === 'Celestial Remedy')
    assert.ok(row, `the bar is up at ${stamp.slice(-8)}`)
    assert.equal(row.startedTs, landed, 'the clock stays at the 12:30:25 landing')
    // JOS-238: `name` is the identity, `castName` is the ranked text the cast line spelled, and
    // `rowRankLabel` is what the overlay renders as the chip.
    assert.equal(row.castName, 'Celestial Remedy III', 'the tick must not blank the ranked text')
    assert.equal(rowRankLabel(row.name, row.castName), 'III', 'the III chip is still on the row')
  }
})
