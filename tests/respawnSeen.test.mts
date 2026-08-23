// SEEN ON LOG EVIDENCE (JOS-194, owner ruling from prototype round 3) — the half of the respawn
// feature that is an OBSERVATION rather than an estimate.
//
// The ladder, the gap rules and the zone scope are pinned in tests/respawnTimers.test.mts over the
// same committed fixture; the wiki floor has tests/respawnWiki.test.mts. This file is round 3 and
// nothing else, because that file reached the repo's 400-code-line factoring ceiling and the answer
// to that is a split, not a widened threshold.
//
// WHAT PRODUCED THE RULING, from live play: the owner was killing a watched mob that had spawned on
// time, he arrived late, the mob was actively hitting him — and the row still read due-in-the-past.
// So (1) a watched mob NAMED in the log in the current zone flips its row to an explicit UP state,
// and (2) a sighting NEVER re-bases the clock on its own, because it proves the mob is up and says
// nothing about when it spawned. Both halves are asserted below, and the second one is asserted as
// an ABSENCE first: the fold tests check the clock did NOT move before anything is confirmed.
//
// EVERY PLAYED LINE IS A REAL SHAPE. The damage / miss / consider / mez / loot sentences are
// verbatim from committed fixtures (e2e-combat.log, p2-pet-arc-bound.log, wl40-farm-run.log) with
// the mob name swapped for the Guk knight tests/respawnTimers.test.mts already folds — the same
// discipline the round-2 zone tests used, so no shape here is one EQ has never printed.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule, seenNamesOf } from '../src/main/modules/respawn'
import {
  DEFAULT_RESPAWN_PREFS,
  RESPAWN_LINGER_MS,
  orderRespawnRows,
  respawnBasisLabel,
  respawnClockLabel,
  respawnReading,
  respawnSeenLabel,
  type RespawnPrefs,
  type RespawnRow
} from '../src/shared/respawn'

/**
 * The app's ONE duration formatter, which lives in the renderer and is injected into the pure label
 * helpers (shared/respawn.ts says why it is injected). Spelled here because a node test cannot
 * import a renderer module; the shapes it produces are pinned by the buffs format tests.
 */
function fmt(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '-'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${String(totalSec)}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (totalMin < 60) return `${String(totalMin)}m ${String(sec).padStart(2, '0')}s`
  const hr = Math.floor(totalMin / 60)
  return `${String(hr)}h ${String(totalMin % 60).padStart(2, '0')}m`
}

/** A plain row to read against the clock. The same builder the sibling file uses, kept local. */
function row(over: Partial<RespawnRow> = {}): RespawnRow {
  return {
    id: 'z::m',
    key: 'm',
    display: 'M',
    zone: 'Z',
    baseTs: 1_000_000,
    basis: 'death',
    source: 'wiki',
    samples: 0,
    kills: 1,
    estimateMs: 600_000,
    ...over
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. READING A SEEN ROW
// ─────────────────────────────────────────────────────────────────────────────

test('evidence after the clock started flips the row UP, and the estimate is untouched', () => {
  // The owner's own case: a mob that came due four minutes ago and is standing in front of him.
  const overdue = row({ baseTs: 1_000_000, estimateMs: 600_000 })
  assert.equal(respawnClockLabel(overdue, 1_840_000, fmt), 'due 4m 00s ago')
  const seen = row({ baseTs: 1_000_000, estimateMs: 600_000, seenTs: 1_838_000, seenVia: 'combat' })
  const r = respawnReading(seen, 1_840_000)
  assert.equal(r.seen, true)
  assert.equal(r.seenAgoMs, 2_000)
  // Still due, still overdue by the same amount — the ROW leads with the fact, the clock is intact.
  assert.equal(r.due, true)
  assert.equal(r.overdueMs, 240_000)
  assert.equal(respawnClockLabel(seen, 1_840_000, fmt), 'UP')
  assert.equal(respawnSeenLabel(seen, 1_840_000, fmt), 'seen 2s ago (a combat line)')
})

test('a mention from BEFORE the clock started is not a sighting of the spawn it is about', () => {
  // The fight that killed the mob names it on every swing. If those counted, every row would open
  // in the seen state at the instant the corpse hit the floor.
  const stale = row({ baseTs: 1_000_000, seenTs: 999_000 })
  assert.equal(respawnReading(stale, 1_100_000).seen, false)
  assert.equal(respawnSeenLabel(stale, 1_100_000, fmt), '')
  // …and one exactly AT the base is not after it either.
  assert.equal(respawnReading(row({ baseTs: 1_000_000, seenTs: 1_000_000 }), 1_100_000).seen, false)
})

test('a sighting outranks a tired clock, and stops being one after the linger', () => {
  // ROUND 8 CHANGED WHAT THIS WINDOW DOES, not what it means. Round 3 had to spare seen rows from a
  // sweep that DELETED them, because the owner's own case is a mob that came due long ago and is
  // standing in front of him. Nothing is deleted now: a row forty minutes overdue reads `stale`,
  // and evidence inside the window overrides that — the row leads with the fact, exactly as before.
  const ancient = row({ baseTs: 0, estimateMs: 600_000 })
  const now = 600_000 + RESPAWN_LINGER_MS + 60_000
  assert.equal(respawnReading(ancient, now).stale, true)
  const witnessed = respawnReading({ ...ancient, seenTs: now - 1_000 }, now)
  assert.equal(witnessed.seen, true)
  assert.equal(witnessed.stale, false, 'fresh evidence is the better answer; the clock stops leading')
  assert.equal(respawnClockLabel({ ...ancient, seenTs: now - 1_000 }, now, fmt), 'UP')
  // …and the claim is bounded by that same window, which is the linger's remaining job: `UP` is the
  // one label here that says a mob is standing there, and a line from an hour ago does not say it.
  const old = { ...ancient, seenTs: now - RESPAWN_LINGER_MS - 1 }
  assert.equal(respawnReading(old, now).seen, false)
  assert.equal(respawnReading(old, now).stale, true, 'the row is still published, and says so honestly')
  assert.equal(respawnSeenLabel(old, now, fmt), '')
})

test('SEEN outranks every countdown, because it is a different kind of fact', () => {
  const seenLate = row({ id: 'seen-old', display: 'A', estimateMs: 900_000, seenTs: 1_000_100 })
  const seenNow = row({ id: 'seen-new', display: 'B', estimateMs: 900_000, seenTs: 1_000_400 })
  const soon = row({ id: 'soon', display: 'C', estimateMs: 60_000 })
  const order = orderRespawnRows([soon, seenLate, seenNow], 1_000_500).map((r) => r.id)
  // Freshest evidence leads among the seen; a row about to come due still sorts under both.
  assert.deepEqual(order, ['seen-new', 'seen-old', 'soon'])
})

test('a re-based clock says so, and a death-based one says nothing', () => {
  assert.equal(respawnBasisLabel(row()), '')
  // A LABEL, not a caption (round 5): it rides a run of chips beside the zone and the rung.
  assert.equal(respawnBasisLabel(row({ basis: 'sighting' })), 'from your sighting')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FOLD, over the real parser
// ─────────────────────────────────────────────────────────────────────────────

/** The Guk knight, watched with a one-minute number so the clock is comfortably due by the end. */
function watchingVis(): RespawnPrefs {
  return { watches: [{ key: 'a vis ghoul knight', display: 'a vis ghoul knight', customSec: 60 }] }
}

/** Fold the given raw lines through the real parser and read the snapshot at `nowMs`. */
function foldLines(mod: RespawnModule, lines: string[], seqFrom = 0): number {
  let seq = seqFrom
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return seq
}

const GUK_ENTER = '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.'
const VIS_DEATH = '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!'
/** The owner's report, in one line: the mob is hitting him while the row reads due-in-the-past. */
const VIS_HITS_YOU = '[Sun Aug 02 23:56:00 2026] A vis ghoul knight hits YOU for 106 points of damage.'
const AT_2356_10 = Date.parse('2026-08-02T23:56:10')

test('the seen mapping reads TYPED EVENTS, and a corpse is not a sighting', () => {
  // The coverage statement, held against the parser rather than against a comment. A raw-text sweep
  // is what this deliberately is NOT — the parser is the only thing here that reads sentences.
  const kinds = (raw: string): { names: string[]; via: string } | null => {
    const ev = parseEvent(raw, 0)
    assert.ok(ev, raw)
    const got = seenNamesOf(ev)
    return got === null ? null : { names: got.names.filter((n): n is string => typeof n === 'string'), via: got.via }
  }
  // The parser normalizes the shouted `YOU` to `You`. Never watched either way, so it falls out at
  // the watch guard — the mapping only reports the names the event states.
  assert.deepEqual(kinds(VIS_HITS_YOU), { names: ['A vis ghoul knight', 'You'], via: 'combat' })
  assert.deepEqual(kinds('[Sun Aug 02 23:56:00 2026] You slash a vis ghoul knight for 65 points of damage.'), {
    names: ['You', 'a vis ghoul knight'],
    via: 'combat'
  })
  assert.deepEqual(kinds('[Sun Aug 02 23:56:00 2026] A vis ghoul knight tries to hit YOU, but misses!'), {
    names: ['A vis ghoul knight', 'You'],
    via: 'combat'
  })
  assert.deepEqual(
    kinds(
      '[Sun Aug 02 23:56:00 2026] A vis ghoul knight regards you indifferently -- what would you like your tombstone to say? (Lvl: 33)'
    ),
    { names: ['A vis ghoul knight'], via: 'consider' }
  )
  assert.deepEqual(kinds('[Sun Aug 02 23:56:00 2026] A vis ghoul knight has been mesmerized.'), {
    names: ['A vis ghoul knight'],
    via: 'hold'
  })
  // THE TWO REFUSALS, both verbatim fixture lines. A death is the thing that STARTS a clock and a
  // loot line names a CORPSE; either one marking its own row seen would flip every kill to "UP" at
  // the instant it went down.
  assert.equal(kinds(VIS_DEATH), null)
  assert.equal(
    kinds("[Sun Aug 02 16:46:17 2026] --You have looted a Mote of Minor Potential from a vis ghoul knight's corpse.--"),
    null
  )
  assert.equal(kinds(GUK_ENTER), null)
})

test('a watched mob NAMED in this zone flips its row UP, and the revision moves', () => {
  // The defect, end to end: the clock ran out at 23:51 and the mob is hitting the player at 23:56.
  const mod = new RespawnModule(watchingVis())
  mod.reset()
  const seq = foldLines(mod, [GUK_ENTER, VIS_DEATH])
  mod.onTick(AT_2356_10)
  const before = mod.snapshot()
  const dueRow = before.state.rows[0]
  assert.equal(respawnReading(dueRow, AT_2356_10).due, true, 'due, and about to be overtaken by events')
  assert.equal(respawnReading(dueRow, AT_2356_10).seen, false)

  foldLines(mod, [VIS_HITS_YOU], seq)
  const after = mod.snapshot()
  const row = after.state.rows[0]
  assert.equal(row.seenTs, Date.parse('2026-08-02T23:56:00'))
  assert.equal(row.seenVia, 'combat')
  const r = respawnReading(row, AT_2356_10)
  assert.equal(r.seen, true)
  assert.equal(r.seenAgoMs, 10_000)
  assert.equal(respawnClockLabel(row, AT_2356_10, fmt), 'UP')
  // JOS-87, third input: a sighting changes what the screen shows, so it must move the revision or
  // `useModule`'s `d.seq <= knownSeq` throws the one push that carries it away.
  assert.ok(after.seq > before.seq, 'a sighting must advance the module revision')

  // AND IT CHANGED NOTHING ELSE. The clock is where the death put it, and no gap was learned.
  assert.equal(row.baseTs, dueRow.baseTs)
  assert.equal(row.basis, 'death')
  assert.equal(row.samples, 0)
  assert.equal(row.kills, 1)
  assert.equal(row.estimateMs, 60_000)
})

test('a sighting in ANOTHER zone lights nothing here', () => {
  // Rows are keyed (zone, mob) and only the entry for the zone the fold is standing in can be
  // marked — the same one piece of zone state the gap rule and the display scope both read.
  const mod = new RespawnModule(watchingVis())
  mod.reset()
  const seq = foldLines(mod, [GUK_ENTER, VIS_DEATH, '[Sun Aug 02 23:54:00 2026] You have entered Befallen.'])
  foldLines(mod, [VIS_HITS_YOU], seq)
  mod.onTick(AT_2356_10)
  const row = mod.snapshot().state.rows.find((r) => r.zone === 'The Ruins of Old Guk')
  assert.ok(row)
  assert.equal(row.seenTs, undefined, 'the Guk row heard a Befallen line and ignored it')
  assert.equal(respawnReading(row, AT_2356_10).seen, false)
})

test('an unwatched mob is never marked seen — watching is still the only admission rule', () => {
  const mod = new RespawnModule(DEFAULT_RESPAWN_PREFS)
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH, VIS_HITS_YOU])
  mod.onTick(AT_2356_10)
  assert.equal(mod.snapshot().state.rows.length, 0)
})

test('confirming a sighting re-bases the clock, and says that is what happened', () => {
  // The second ruling: the app never does this by itself. Nothing above moved a clock; this call is
  // the user saying "that sighting WAS the spawn".
  const mod = new RespawnModule(watchingVis())
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH, VIS_HITS_YOU])
  mod.onTick(AT_2356_10)
  const seenRow = mod.snapshot().state.rows[0]
  const before = mod.snapshot().seq

  assert.equal(mod.confirmSighting(seenRow.id), true)
  const after = mod.snapshot()
  const row = after.state.rows[0]
  assert.ok(after.seq > before, 'a confirmation must advance the module revision too')
  assert.equal(row.baseTs, Date.parse('2026-08-02T23:56:00'), 'the clock now counts from the sighting')
  assert.equal(row.basis, 'sighting')
  assert.equal(respawnBasisLabel(row), 'from your sighting')
  // The countdown restarted, so the row is no longer due and no longer seen — the evidence is now
  // AT the base rather than after it. Fresh evidence will mark it again, which is correct: it is up.
  const r = respawnReading(row, AT_2356_10)
  assert.equal(r.due, false)
  assert.equal(r.seen, false)
  assert.equal(r.remainingMs, 50_000)
  // AND THE LADDER LEARNED NOTHING FROM IT. A confirmation is not a death and never a gap sample.
  assert.equal(row.samples, 0)
  assert.equal(row.kills, 1)
})

test('a kill of the seen mob resumes the normal death-driven clock', () => {
  // "Death messages keep driving the cycle exactly as today." The later of (death, confirmation)
  // wins, so the next kill takes the base back with no code to undo the confirmation.
  const mod = new RespawnModule(watchingVis())
  mod.reset()
  const seq = foldLines(mod, [GUK_ENTER, VIS_DEATH, VIS_HITS_YOU])
  mod.onTick(AT_2356_10)
  assert.equal(mod.confirmSighting(mod.snapshot().state.rows[0].id), true)
  assert.equal(mod.snapshot().state.rows[0].basis, 'sighting')

  foldLines(mod, ['[Sun Aug 02 23:57:00 2026] You have slain a vis ghoul knight!'], seq)
  mod.onTick(Date.parse('2026-08-02T23:57:10'))
  const row = mod.snapshot().state.rows[0]
  assert.equal(row.basis, 'death')
  assert.equal(row.baseTs, Date.parse('2026-08-02T23:57:00'))
  assert.equal(row.kills, 2)
  assert.equal(respawnReading(row, Date.parse('2026-08-02T23:57:10')).seen, false)
  // The gap is measured between the two DEATHS (7 minutes), never from the confirmation.
  assert.equal(row.samples, 1)
  assert.equal(row.observedMs, 420_000)
})

test('a confirmation with nothing to confirm is refused, not invented', () => {
  const mod = new RespawnModule(watchingVis())
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH])
  mod.onTick(AT_2356_10)
  const row = mod.snapshot().state.rows[0]
  assert.equal(mod.confirmSighting(row.id), false, 'the row is due, but nothing has been seen')
  assert.equal(mod.confirmSighting('no such row'), false)
  assert.equal(mod.snapshot().state.rows[0].basis, 'death')
})
