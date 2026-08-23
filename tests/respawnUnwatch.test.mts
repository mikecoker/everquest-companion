// UNWATCH ON THE MOB (JOS-194, owner ruling from prototype round 4) — the other half of Watch,
// offered wherever a surface names a watched mob instead of only in the global list.
//
// The ladder, the gap rules and the zone scope are pinned in tests/respawnTimers.test.mts; the
// seen state and the confirmed sighting in tests/respawnSeen.test.mts. This file is round 4 and
// nothing else, for the same reason that split happened: both of those files are at the repo's
// factoring ceiling and the answer to that is a split, not a widened threshold.
//
// WHAT THE RULING IS, and therefore what is asserted here. The UI half — a control on the clock
// row, on the interactive overlay row and on the Recently-killed entry — is what the e2e clicks
// (tests/e2e/respawn-timers.e2e.mts). What a unit test can hold is the part underneath, and it is
// the part with a promise in it: unwatching removes exactly one name and nothing else, it takes
// the clock off every surface at once, it moves the module revision (or `useModule`'s seq dedupe
// swallows the one push that says the row is gone — JOS-87, re-learned twice on this module), and
// it THROWS NOTHING AWAY. Kills, gaps and the LRU history are the fold's, derived from the log;
// only the watch list is a preference. So watching the mob again brings back the same clock with
// the same numbers, which is the property that makes a one-click unwatch over the game safe.
//
// Every played line is a real shape, verbatim from committed fixtures with the mob name swapped
// for the Guk knight the sibling files already fold.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule } from '../src/main/modules/respawn'
// The namespace import is deliberate: one test below asserts that a name is ABSENT from this
// module, which is not something a named import can express (it would be a compile error instead of
// a failing assertion, and the string would then be deleted from the test along with the code).
import * as respawn from '../src/shared/respawn'
import { respawnWithoutWatch, type RespawnPrefs } from '../src/shared/respawn'

const GUK_ENTER = '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.'
const VIS_DEATH_1 = '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!'
const VIS_DEATH_2 = '[Sun Aug 02 23:57:00 2026] You have slain a vis ghoul knight!'
/** A second watched name, so "removes exactly one" has something to leave behind. */
const WAN_DEATH = '[Sun Aug 02 23:52:00 2026] You have slain a wan ghoul knight!'
const AT_2358 = Date.parse('2026-08-02T23:58:00')

/** Two watches, one of them carrying a typed number — rung 1, which must survive its neighbour. */
function watchingBoth(): RespawnPrefs {
  return {
    watches: [
      { key: 'a vis ghoul knight', display: 'a vis ghoul knight', customSec: 600 },
      { key: 'a wan ghoul knight', display: 'a wan ghoul knight', customSec: 900 }
    ]
  }
}

function foldLines(mod: RespawnModule, lines: string[], seqFrom = 0): number {
  let seq = seqFrom
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return seq
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PURE WRITE — one definition of "stop watching this", shared by every surface
// ─────────────────────────────────────────────────────────────────────────────

test('unwatching removes exactly one name and leaves the other entry whole', () => {
  const after = respawnWithoutWatch(watchingBoth(), 'a vis ghoul knight')
  assert.deepEqual(after.watches, [
    { key: 'a wan ghoul knight', display: 'a wan ghoul knight', customSec: 900 }
  ])
})

test('the key is canonicalized at the boundary, so a row key and a typed name agree', () => {
  // Stored keys are lowercased by `normalizeRespawnPrefs`; a caller may hand over anything the log
  // printed. World-model law 2 — canonicalize at boundaries, display raw.
  assert.equal(respawnWithoutWatch(watchingBoth(), '  A Vis Ghoul Knight ').watches.length, 1)
})

test('removing a name nobody watches is a no-op, not an error', () => {
  const before = watchingBoth()
  const after = respawnWithoutWatch(before, 'a froglok guk shaman')
  assert.deepEqual(after.watches, before.watches)
  // The handler compares the lengths and declines to persist — that is what a click racing another
  // surface's unwatch looks like, and it must not rewrite the list it already agrees with.
  assert.equal(after.watches.length, before.watches.length)
})

test('the control says one word, and the module carries the promise it used to make', () => {
  // ROUND 7 ADDENDUM (owner): the Unwatch tooltip is GONE — "the control speaks for itself" — so
  // `respawnUnwatchTitle` no longer exists and this pins the ABSENCE, which is the only way a
  // deleted caption stays deleted. Round 5's length cap dies with the string it bounded.
  assert.equal(Object.hasOwn(respawn, 'respawnUnwatchTitle'), false, 'the unwatch tooltip string is deleted, not shortened')
  assert.equal(respawn.RESPAWN_UNWATCH_LABEL, 'Unwatch', 'one word, one spelling, three surfaces')

  // AND THE TWO FACTS IT USED TO RECITE ARE STILL TRUE — they were always properties of the WRITE
  // rather than of the caption, which is exactly why deleting the caption costs nothing. Asserted
  // here so "the button says nothing" can never quietly become "the button does something else".
  const both = watchingBoth()
  //  (1) a watch is a NAME, so removing it removes it everywhere — there is no zone in this list at
  //      all, and therefore nothing a per-zone removal could even be expressed against.
  assert.ok(both.watches.every((w) => !Object.hasOwn(w, 'zone')))
  //  (2) nothing but the watch goes: the neighbour keeps its own typed number, and the fold's kills
  //      and gaps are re-derived from the log (the two tests below drive that end to end).
  const after = respawnWithoutWatch(both, 'a vis ghoul knight')
  assert.deepEqual(after.watches, [{ key: 'a wan ghoul knight', display: 'a wan ghoul knight', customSec: 900 }])
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FOLD — the row leaves, the history stays, the revision moves
// ─────────────────────────────────────────────────────────────────────────────

test('unwatching takes the clock off the surfaces and moves the revision', () => {
  const mod = new RespawnModule(watchingBoth())
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH_1, WAN_DEATH])
  mod.onTick(AT_2358)
  const before = mod.snapshot()
  assert.deepEqual(
    before.state.rows.map((r) => r.key).sort(),
    ['a vis ghoul knight', 'a wan ghoul knight']
  )

  mod.setPrefs(respawnWithoutWatch(mod.getPrefs(), 'a vis ghoul knight'))
  const after = mod.snapshot()
  assert.deepEqual(after.state.rows.map((r) => r.key), ['a wan ghoul knight'])
  // JOS-87 again: a watch edit advances no log seq, so the module's own revision is the only thing
  // that keeps `useModule`'s `d.seq <= knownSeq` from swallowing the push that removes the row.
  assert.ok(after.seq > before.seq, 'an unwatch must advance the module revision')
  // …and the delta really is built, rather than only marked dirty.
  const flushed = mod.flushDelta()
  assert.ok(flushed)
  assert.equal(flushed.delta.rows.length, 1)
})

test('the mob is offered again the instant after, because unwatching drops only the watch', () => {
  const mod = new RespawnModule(watchingBoth())
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH_1])
  mod.onTick(AT_2358)
  assert.equal(mod.snapshot().state.recent.find((c) => c.key === 'a vis ghoul knight')?.watched, true)

  mod.setPrefs(respawnWithoutWatch(mod.getPrefs(), 'a vis ghoul knight'))
  const cand = mod.snapshot().state.recent.find((c) => c.key === 'a vis ghoul knight')
  assert.ok(cand, 'the death is still in the fold; only the preference went away')
  assert.equal(cand.watched, false, 'so Recently killed offers Watch again, symmetric with Unwatch')
  assert.equal(cand.kills, 1)
})

test('watching it again brings back the same clock with the same numbers', () => {
  // The promise the tooltip makes, and the reason a one-click unwatch over the game needs no
  // confirmation: the kills and the learned gap are the FOLD's, re-derived from the log, and the
  // watch list is the only thing that was ever a preference.
  const mod = new RespawnModule(watchingBoth())
  mod.reset()
  foldLines(mod, [GUK_ENTER, VIS_DEATH_1, VIS_DEATH_2])
  mod.onTick(AT_2358)
  const before = mod.snapshot().state.rows.find((r) => r.key === 'a vis ghoul knight')
  assert.ok(before)
  assert.equal(before.samples, 1)
  assert.equal(before.observedMs, 420_000, 'the two deaths are seven minutes apart')

  mod.setPrefs(respawnWithoutWatch(mod.getPrefs(), 'a vis ghoul knight'))
  assert.equal(mod.snapshot().state.rows.find((r) => r.key === 'a vis ghoul knight'), undefined)

  mod.setPrefs(watchingBoth())
  const after = mod.snapshot().state.rows.find((r) => r.key === 'a vis ghoul knight')
  assert.ok(after)
  assert.equal(after.baseTs, before.baseTs, 'the clock still counts from the death it always did')
  assert.equal(after.samples, before.samples)
  assert.equal(after.observedMs, before.observedMs)
  assert.equal(after.kills, before.kills)
  assert.equal(after.estimateMs, before.estimateMs)
})

test('an unwatched mob stops being marked seen, because watching is the admission rule', () => {
  // The row is gone, so the sighting that used to light it has nothing to light — and the guard
  // that makes that true is the same `watchOf` check the opt-in ruling put on the hot path.
  const mod = new RespawnModule(watchingBoth())
  mod.reset()
  const seq = foldLines(mod, [GUK_ENTER, VIS_DEATH_1])
  mod.setPrefs(respawnWithoutWatch(mod.getPrefs(), 'a vis ghoul knight'))
  foldLines(mod, ['[Sun Aug 02 23:56:00 2026] A vis ghoul knight hits YOU for 106 points of damage.'], seq)
  mod.onTick(AT_2358)
  assert.equal(mod.snapshot().state.rows.find((r) => r.key === 'a vis ghoul knight'), undefined)

  // And re-watching does NOT resurrect a sighting that was never recorded: the row comes back on
  // its death, in the state the log can restate, saying nothing it did not see.
  mod.setPrefs(watchingBoth())
  const row = mod.snapshot().state.rows.find((r) => r.key === 'a vis ghoul knight')
  assert.ok(row)
  assert.equal(row.seenTs, undefined)
  assert.equal(row.basis, 'death')
})
