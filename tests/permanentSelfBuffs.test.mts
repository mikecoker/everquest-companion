// JOS-215 — THE SELF/PERMANENT BUFFS THE WINDOW USED TO OMIT, pinned to real bytes.
//
// THE REPORT (01KZS7FZEAC0Q0T76ZJRS32DSR, v0.21.0): "the buff window omits self buffs". The cause
// was one line in `BuffInstances.applyMessageBuff` — a landing with no duration and no illusion
// flag was dropped — and a PERMANENT buff has no duration precisely because it is permanent. So
// Yaulp, Instrument of Nife, Divine Purpose, the Shielding ladder, the rogue blade coats and 57
// other spells printed their landing sentence, produced a perfectly good `buffApply`, and opened
// nothing at all.
//
// WHAT THIS FILE PROVES, in the order the fix is built:
//   1. the DISCRIMINATOR is honest — `durationText === 'Permanent'`, never the null `durationMs`
//      beside it, which 453 Self rows also carry (instant nukes among them);
//   2. a permanent landing OPENS A ROW, off the owner's own committed fixture bytes;
//   3. that row never counts down, never mints a sample, and — the second half of the ticket —
//      SURVIVES the 90-minute hygiene cull that used to retire the five illusion permanents;
//   4. the two arms of permanence are told apart (`permanentSource`), which is what lets the Buffs
//      tab stop calling a rogue's poison coat an illusion AA;
//   5. the honest LIMIT: a buff cast before the log window is invisible until its next recast.
//
// Nothing here is authored. Every assertion is read off `tests/fixtures/*.log` — scrubbed excerpts
// of the owner's real log — replayed through the real parser, the real BuffsModule and the real
// projection.

import test from 'node:test'
import assert from 'node:assert/strict'
import { lastTs, readFixture, replayBuffs, replayBuffTimers, tsOf } from './harness.mts'
import { landingIsPermanent } from '../src/main/modules/buffsInstanceRules.ts'
import {
  applyTimerOverlayKnobs,
  filterPermanentRows,
  orderTimerRows,
  rowsForSurface
} from '../src/shared/buffTimers.ts'
import type { OverlayConfig } from '../src/shared/types.ts'
import { loadSpellDb, spellNature } from '../src/main/data/spellDb.ts'
// The game's own `Sat Aug 01 19:02:06 2026` prefix, built by the ONE implementation this repo has
// (scripts/smokeLog.mts) rather than a third hand-rolled copy — a synthetic line only proves
// something if the real parser reads it exactly as it reads the fixture's own bytes.
import { eqStamp } from '../scripts/smokeLog.mjs'
import type { ActiveBuff } from '../src/shared/types.ts'

/** Every DB row whose duration the wiki states as `Permanent`. */
function permanentRows(): { name: string; durationMs: number | null; illusion: boolean; targetType?: string; spellType?: string }[] {
  return loadSpellDb().spells.filter((s) => s.durationText === 'Permanent')
}

function activeNamed(active: readonly ActiveBuff[], name: string): ActiveBuff | undefined {
  return active.find((a) => a.spell.toLowerCase() === name.toLowerCase())
}

// ---------------------------------------------------------------------------------------------
// 1. THE DISCRIMINATOR. `durationMs == null` is the WRONG test and this is the measurement saying so.
// ---------------------------------------------------------------------------------------------

test('every spell the wiki calls Permanent is a SELF buff with no parsed duration', () => {
  const perm = permanentRows()
  // A floor rather than an equality: spells.json is a committed scrape and a re-scrape may add
  // rows. What must not change is the SHAPE of the set — that is what the admission rests on.
  assert.ok(perm.length >= 60, `expected the permanent family to be ~62 rows, found ${perm.length}`)
  for (const s of perm) {
    assert.equal(s.durationMs, null, `${s.name}: a permanent duration must not parse to a number`)
    assert.equal(s.targetType, 'Self', `${s.name}: a permanent buff the model admits must be Self`)
    assert.notEqual(spellNature(s.spellType), 'detrimental', `${s.name}: no permanent DEBUFFS`)
  }
  // The reported spells are in it — the sanity check that the set is the one the ticket is about.
  const names = new Set(perm.map((s) => s.name))
  for (const n of ['Yaulp', 'Instrument of Nife', 'Divine Purpose', 'Arch Shielding', 'Neurotoxic Poison']) {
    assert.ok(names.has(n), `${n} should be a permanent spell`)
  }
})

test('…and a null durationMs is NOT the discriminator — hundreds of Instant self spells share it', () => {
  const db = loadSpellDb()
  const nullSelf = db.spells.filter((s) => s.durationMs == null && s.targetType === 'Self')
  const perm = nullSelf.filter((s) => s.durationText === 'Permanent')
  assert.ok(
    nullSelf.length > perm.length * 3,
    `admitting on the null would open ${nullSelf.length} rows to reach ${perm.length} real ones`
  )
  // The biggest bucket among them is `Instant`, which is a nuke, not a buff. Naming it here is
  // what makes the previous assertion a fact rather than an arithmetic curiosity.
  assert.ok(
    nullSelf.some((s) => s.durationText === 'Instant'),
    'the null-duration Self population should contain instant spells'
  )
})

// ---------------------------------------------------------------------------------------------
// 2. THE RULE. Two arms, and which one the five illusion permanents take.
// ---------------------------------------------------------------------------------------------

/** A plain (non-illusion) landing at t=1, with no Permanent Illusion AA in the picture. */
const PLAIN = { illusion: false, ts: 1 }

test('a SELF landing of a spell the DB calls Permanent is permanent, with or without the AA', () => {
  assert.equal(landingIsPermanent(true, true, PLAIN), true)
  assert.equal(landingIsPermanent(true, false, PLAIN), false, 'an ordinary self buff is not permanent')
  assert.equal(
    landingIsPermanent(false, true, PLAIN),
    false,
    'permanence is a SELF rule — nothing on another entity may escape the hygiene long stop'
  )
})

test('the Permanent Illusion AA arm still works, and still needs the AA', () => {
  const at = (permanentIllusionOwnedTs?: number): { illusion: boolean; ts: number; permanentIllusionOwnedTs?: number } =>
    permanentIllusionOwnedTs == null
      ? { illusion: true, ts: 2_000 }
      : { illusion: true, ts: 2_000, permanentIllusionOwnedTs }
  assert.equal(landingIsPermanent(true, false, at()), false, 'no AA, and the spell states a duration')
  assert.equal(landingIsPermanent(true, false, at(3_000)), false, 'cast BEFORE the AA was bought')
  assert.equal(landingIsPermanent(true, false, at(1_000)), true)
})

test('the five illusion PERMANENTS take the DB arm — the 90-minute cull no longer reaches them', () => {
  const both = permanentRows().filter((s) => s.illusion).map((s) => s.name).sort()
  assert.deepEqual(both, [
    'Call of Bones',
    'Form of the Great Wolf',
    'Greater Wolf Form',
    'Lich',
    'Wolf Form'
  ])
  // Without the AA these used to be admitted (the old guard let an illusion through) and then
  // modelled as ordinary count-up rows the hygiene long stop retired after 90 minutes — a form
  // the player was still wearing, taken off the window by a timer. The DB arm answers first.
  for (const name of both) {
    assert.equal(
      landingIsPermanent(true, true, { illusion: true, ts: 1 }),
      true,
      `${name} must be permanent on the spell's own duration`
    )
  }
})

// ---------------------------------------------------------------------------------------------
// 3. THE ROWS, off real bytes.
//
//   tests/fixtures/w40-nife-buff.log
//     [19:26:47] You begin casting Instrument of Nife.
//     [19:26:48] A brilliant blue aura surrounds your weapon.
//     [19:27:01] You feel a surge of strength as you let forth a mighty yaulp.
//
//   tests/fixtures/e2e-overlay.log — a Quick Buff burst at 20:42:56 landing eleven spells at once,
//   three of which are permanent (Yaulp, Instrument of Nife, Divine Purpose).
// ---------------------------------------------------------------------------------------------

const W40 = readFixture('w40-nife-buff.log')
const NIFE_LANDS = tsOf('[Sun Aug 02 19:26:48 2026] A brilliant blue aura surrounds your weapon.')

test('a permanent self buff OPENS A ROW — the whole of the reported defect', () => {
  const { buffs } = replayBuffTimers(W40, { until: NIFE_LANDS })
  const nife = activeNamed(buffs.active, 'Instrument of Nife')
  assert.ok(nife, 'Instrument of Nife must be active after its landing line')
  assert.equal(nife.permanent, true)
  assert.equal(nife.self, true)
  assert.equal(nife.cls, 'buff')
})

test('…and it states WHY it never expires: the spell, not the illusion AA', () => {
  const { buffs } = replayBuffTimers(W40)
  for (const name of ['Instrument of Nife', 'Yaulp']) {
    const b = activeNamed(buffs.active, name)
    assert.ok(b, `${name} should be active`)
    assert.equal(b.permanent, true)
    assert.equal(b.permanentSource, 'spell', `${name} is permanent because the SPELL is, not because of an AA`)
  }
})

test('…and every other row keeps saying nothing about permanence', () => {
  const { buffs } = replayBuffTimers(W40)
  for (const b of buffs.active) {
    if (b.permanent === true) continue
    assert.equal(b.permanentSource, undefined, `${b.spell}: a finite buff must not carry a permanence reason`)
  }
})

test('a permanent row never counts down and never carries an estimate', () => {
  const { buffs, rows } = replayBuffTimers(W40)
  const perm = buffs.active.filter((a) => a.permanent === true)
  assert.ok(perm.length >= 2, 'the fixture should leave at least Nife and Yaulp standing')
  for (const b of perm) {
    assert.equal(b.estimatedMs, null, `${b.spell}: a permanent buff has no estimate`)
    assert.equal(b.overlayDurationMs, null, `${b.spell}: …and no overlay countdown`)
    const row = rows.find((r) => r.name === b.spell)
    assert.ok(row, `${b.spell}: no timer row`)
    assert.equal(row.mode, 'permanent')
    assert.equal(row.durationMs, undefined, `${b.spell}: a permanent row must carry no duration at all`)
  }
})

test('a permanent row mints NOTHING into the learner — there is no cycle to measure', () => {
  const { spellStats } = replayBuffTimers(W40)
  for (const key of ['instrument of nife', 'yaulp']) {
    const st = spellStats.statFor(key)
    assert.equal(st, null, `${key}: a permanent buff must never produce a duration sample`)
  }
})

// ---------------------------------------------------------------------------------------------
// 4. THE CULL. The reason permanence is a MODEL fact and not a display one.
// ---------------------------------------------------------------------------------------------

test('the 90-minute hygiene long stop retires the timed buffs and leaves the permanent ones', () => {
  const end = lastTs(W40)
  const near = replayBuffTimers(W40, { tickMs: end + 30 * 60_000 }).buffs.active
  const far = replayBuffTimers(W40, { tickMs: end + 200 * 60_000 }).buffs.active

  // Half an hour on: the fixture's finite self buffs are still standing beside the permanent ones.
  assert.ok(activeNamed(near, 'Center'), 'a finite buff should still be up half an hour later')
  // Three hours on: the long stop has collected them, and only the permanent ones remain.
  assert.equal(activeNamed(far, 'Center'), undefined, 'the hygiene long stop must retire a finite buff')
  assert.ok(far.length > 0, 'the permanent buffs must not go with them')
  for (const b of far) {
    assert.equal(b.permanent, true, `${b.spell} outlived the long stop without being permanent`)
  }
  assert.ok(activeNamed(far, 'Yaulp'), 'Yaulp is permanent and must still be up')
  assert.ok(activeNamed(far, 'Instrument of Nife'), 'Instrument of Nife is permanent and must still be up')
})

// ---------------------------------------------------------------------------------------------
// 5. IT STILL COMES OFF THE BOARD. Permanent means "no timer", never "unremovable".
//
//   tests/fixtures/w44-poison-slow-per-mob.log  [.. ] The divine flame leaves.   ← Divine Purpose
// ---------------------------------------------------------------------------------------------

const OVERLAY = readFixture('e2e-overlay.log')

/** One more real-shaped line, a minute after the fixture's last, through the real parser. */
function andThen(lines: string[], sentence: string): string[] {
  return [...lines, `[${eqStamp(lastTs(lines) + 60_000)}] ${sentence}`]
}

test('a wears-off line clears a permanent buff exactly as it clears a timed one', () => {
  const before = replayBuffs(OVERLAY).active
  assert.ok(activeNamed(before, 'Divine Purpose'), 'the fixture should leave Divine Purpose standing')
  // `The divine flame leaves.` is Divine Purpose's own wears-off message in the committed DB, and
  // it appears verbatim in tests/fixtures/w44-poison-slow-per-mob.log — a shape the game prints.
  const after = replayBuffs(andThen(OVERLAY, 'The divine flame leaves.')).active
  assert.equal(activeNamed(after, 'Divine Purpose'), undefined, 'a permanent buff still wears off when the log says so')
  // …and the buffs beside it are untouched: the wear-off names one spell, not the permanent class.
  assert.ok(activeNamed(after, 'Yaulp'), 'the other permanent buffs are not collateral')
})

test('death strips a permanent self buff — the one event that heals the honest limit below', () => {
  const before = replayBuffs(OVERLAY).active
  assert.ok(before.some((a) => a.self && a.permanent === true), 'there must be one to strip')
  const after = replayBuffs(andThen(OVERLAY, 'You have been slain by a fire giant warrior!')).active
  assert.equal(
    after.filter((a) => a.self && a.permanent === true).length,
    0,
    'a death takes your self buffs, permanent ones included'
  )
})

// ---------------------------------------------------------------------------------------------
// 6. THE HONEST LIMIT, pinned rather than merely written down.
//
// The model learns a permanent buff is up only from its CAST. There is no login roster in the log
// and a permanent buff prints no periodic reminder, so one raised before the window began is
// invisible until the next recast. Cutting the fixture AFTER the landing line is exactly that
// situation, and the window is empty of it — which is the failure erring in the safe direction.
// ---------------------------------------------------------------------------------------------

/** The fixture recasts Instrument of Nife 13 s later, at 19:27:01 — the recast in the limit below. */
const NIFE_RECAST = tsOf('[Sun Aug 02 19:27:01 2026] A brilliant blue aura surrounds your weapon.')

test('a permanent buff cast before the log window began is NOT shown — it waits for the recast', () => {
  const between = (from: number, to: number): string[] =>
    W40.filter((l) => {
      const ts = tsOf(l)
      return ts === 0 || (ts > from && ts < to)
    })
  // The window OPENS after Nife landed and CLOSES before it is recast. In the game the aura is on
  // the player's weapon for every second of it; in the log there is not one sentence that says so.
  const blind = replayBuffTimers(between(NIFE_LANDS, NIFE_RECAST)).buffs.active
  assert.equal(
    blind.filter((a) => a.permanent === true).length,
    0,
    'nothing in the log restates a permanent buff, so the model cannot know it is up'
  )
  // …AND THE RECAST IS WHAT FIXES IT. Same start, window extended past 19:27:01: the buff is back,
  // which is what makes the assertion above a claim about EVIDENCE rather than an empty fixture.
  const recast = replayBuffTimers(between(NIFE_LANDS, NIFE_RECAST + 1_000)).buffs.active
  assert.ok(activeNamed(recast, 'Instrument of Nife'), 'the next recast is what the model can see')
})

// ---------------------------------------------------------------------------------------------
// 7. THE DISPLAY, hidden by default (owner ruling) — a RENDERER filter over rows the model keeps.
// ---------------------------------------------------------------------------------------------

test('the buffs window hides the permanent rows by default, and shows every other one', () => {
  const all = rowsForSurface(replayBuffTimers(readFixture('e2e-overlay.log')).rows, 'buffs')
  const permanent = all.filter((r) => r.mode === 'permanent')
  assert.ok(permanent.length >= 3, 'the Quick Buff burst should leave Yaulp, Nife and Divine Purpose up')

  const hidden = filterPermanentRows(all, false)
  assert.equal(hidden.length, all.length - permanent.length)
  assert.equal(hidden.filter((r) => r.mode === 'permanent').length, 0)
  // NOTHING ELSE MOVES: a filter removes rows, it never re-sorts or renames them.
  assert.deepEqual(
    hidden.map((r) => r.id),
    all.filter((r) => r.mode !== 'permanent').map((r) => r.id)
  )
})

test('…and switching it on brings back exactly those rows, in the same order', () => {
  const all = rowsForSurface(replayBuffTimers(readFixture('e2e-overlay.log')).rows, 'buffs')
  const shown = filterPermanentRows(all, true)
  assert.deepEqual(shown.map((r) => r.id), all.map((r) => r.id))
  // A copy, never the caller's array — the same rule every other projection here follows.
  assert.notEqual(shown, all)
})

test('a permanent row still sorts LAST when it is shown — it is never going to expire', () => {
  const all = rowsForSurface(replayBuffTimers(readFixture('e2e-overlay.log')).rows, 'buffs')
  const flat = orderTimerRows(filterPermanentRows(all, true), 'none')
  const firstPermanent = flat.findIndex((r) => r.mode === 'permanent')
  assert.ok(firstPermanent >= 0, 'the fixture should leave a permanent row to place')
  assert.ok(
    flat.slice(firstPermanent).every((r) => r.mode === 'permanent'),
    'once the permanent rows start, nothing with a clock may follow them'
  )
})

test('the switch is stored only on the timer kinds, and only when it is ON', () => {
  const cfg = (patch: Partial<OverlayConfig>): OverlayConfig => ({
    open: false,
    locked: false,
    bgAlpha: 0.72,
    ...patch
  })

  const on = cfg({ showPermanent: true })
  applyTimerOverlayKnobs('buffs', on)
  assert.equal(on.showPermanent, true, 'a timer window remembers that you asked for the roster')

  const off = cfg({ showPermanent: false })
  applyTimerOverlayKnobs('buffs', off)
  assert.ok(!('showPermanent' in off), 'hidden is the default, so it is stored as an ABSENT key')

  const meter = cfg({ showPermanent: true })
  applyTimerOverlayKnobs('fight', meter)
  assert.ok(!('showPermanent' in meter), 'a damage meter must not grow a timer knob from a patch')

  // A hand-edited store cannot smuggle a truthy non-boolean past it.
  const forged = cfg({ showPermanent: 'true' as unknown as boolean })
  applyTimerOverlayKnobs('debuffs', forged)
  assert.ok(!('showPermanent' in forged), 'only a real `true` counts')

  // …and the arrangement it moved in beside still behaves exactly as it did (JOS-140).
  const grouped = cfg({ grouping: 'target' })
  applyTimerOverlayKnobs('debuffs', grouped)
  assert.equal(grouped.grouping, 'target')
  const bogus = cfg({ grouping: 'sideways' as unknown as 'none' })
  applyTimerOverlayKnobs('buffs', bogus)
  assert.ok(!('grouping' in bogus), 'an unknown arrangement degrades to the window default')
})
