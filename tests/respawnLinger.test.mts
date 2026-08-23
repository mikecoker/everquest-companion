// A WATCHED MOB ALWAYS HAS A ROW (JOS-194, owner ruling from prototype round 8).
//
// Its own file for the reason tests/respawnSeen.test.mts and tests/respawnWorking.test.mts are:
// tests/respawnTimers.test.mts is at the repo's 400-code-line ceiling and the answer to that is a
// split, not a widened threshold.
//
// WHAT PRODUCED THE RULING, from live play: the owner came back to the app HOURS after his kills,
// clicked Watch on a Recently-killed entry, watched the button flip to Unwatch — and nothing
// appeared under Running. The click was not lost and the delta was not swallowed: the row was BORN
// PAST THE LINGER. `rowFor` ran `respawnRowExpired` on every row it built, and a clock whose
// estimate elapsed more than RESPAWN_LINGER_MS ago (or, with no estimate at all, whose death is
// that old) was returned as `null` — so the one mob the user had just asked for was the one mob the
// module refused to publish. The first test below is that reproduction, and it also pins the half
// that was NOT broken: the watch write bumps the module revision exactly as round 2 requires.
//
// WHAT THE FIX IS. The sweep is gone from the fold: a watched mob that this fold has a death for
// ALWAYS publishes a row. What the linger still does is TIDY THE SEEN STATE — evidence older than
// the window stops claiming UP — and mark a long-elapsed clock STALE, which is a reading the
// surfaces print honestly ("due long ago" / "awaiting next death") and sort to the bottom, rather
// than an absence. The next death starts the normal cycle with nothing to undo.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule } from '../src/main/modules/respawn'
import {
  RESPAWN_AWAITING_LABEL,
  RESPAWN_LINGER_MS,
  RESPAWN_LONG_DUE_LABEL,
  orderRespawnRows,
  respawnClockLabel,
  respawnReading,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSnap
} from '../src/shared/respawn'
import { readFixture } from './harness.mts'

const HOURS = 3600_000

/** The fixture's last event, hand-read off the raw text: Mon Aug 03 2026 00:33:26 UTC. */
const WL40_END = 1785717206000

/** The four Befallen mobs of `wl40-farm-run.log`'s first half — all in the committed wiki floor. */
const BEFALLEN_FOUR = ['a teir`dal ranger', 'a teir`dal shadowknight', 'gynok moltor', 'korven nisere']

/** Replay a fixture through the module, then set its clock to `nowMs` and read the snapshot. */
function replay(fixture: string, prefs: RespawnPrefs, nowMs: number): RespawnSnap {
  const mod = new RespawnModule(prefs)
  mod.reset()
  let seq = 0
  for (const raw of readFixture(fixture)) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(nowMs)
  return mod.snapshot().state
}

/**
 * The app's ONE duration formatter, which lives in the renderer and is injected into the pure label
 * helpers. Spelled here for the same reason tests/respawnSeen.test.mts spells it: a node test cannot
 * import a renderer module, and the shapes it produces are pinned by the buffs format tests.
 */
function fmt(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '-'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${String(totalSec)}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${String(totalMin)}m ${String(totalSec % 60).padStart(2, '0')}s`
  return `${String(Math.floor(totalMin / 60))}h ${String(totalMin % 60).padStart(2, '0')}m`
}

/** A plain row to read against the clock — the same builder its sibling files use, kept local. */
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

/** Watch these mobs with no numbers of your own — the product's own admission rule. */
function watching(...keys: string[]): RespawnPrefs {
  return { watches: keys.map((key) => ({ key, display: key })) }
}

/**
 * THE OWNER'S EVENING, folded: a stated stay in one zone and ONE kill in it. Nothing is watched —
 * the mob is only a Recently-killed candidate, which is where the owner met it.
 */
function foldOneAncientKill(): { mod: RespawnModule; snap: RespawnSnap } {
  const mod = new RespawnModule({ watches: [] })
  mod.reset()
  let seq = 0
  for (const raw of [
    '[Sun Aug 02 18:00:00 2026] You have entered The Ruins of Old Guk.',
    '[Sun Aug 02 18:05:00 2026] You have slain a vis ghoul knight!'
  ]) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return { mod, snap: mod.snapshot().state }
}

test('watching a kill from hours ago produces a row, not silence', () => {
  const { mod, snap } = foldOneAncientKill()
  const cand = snap.recent.find((c) => c.key === 'a vis ghoul knight')
  assert.ok(cand, 'the kill is offered as a candidate — this half always worked')
  assert.equal(cand.watched, false)

  // FIVE HOURS LATER the owner opens the app and clicks Watch. The clock's base is that death, so
  // the row is born long past due; before round 8 the linger sweep dropped it on the way out and
  // the tab said "No clocks running" at a mob whose button had just flipped to Unwatch.
  const nowMs = cand.lastTs + 5 * HOURS
  mod.onTick(nowMs)
  const before = mod.snapshot().seq
  mod.setPrefs(watching('a vis ghoul knight'))
  const after = mod.snapshot()

  // THE OTHER HYPOTHESIS FIRST, pinned as a NEGATIVE and asserted BEFORE the row so the
  // reproduction says which mechanism it caught: the write path was never the problem. A watch edit
  // advances no log seq, so round 2's rule makes the module bump its own revision — it did, and the
  // delta the renderer received was simply empty of rows.
  assert.ok(after.seq > before, 'the watch edit advances the module revision (round 2 law)')

  assert.equal(after.state.rows.length, 1, 'a watched mob this fold has a death for ALWAYS has a row')
  assert.equal(after.state.rows[0].key, 'a vis ghoul knight')
  assert.equal(after.state.rows[0].kills, 1)

  // AND IT READS HONESTLY rather than reciting a number that grows forever. This mob is not in the
  // committed wiki floor and one kill teaches no gap, so there is no estimate to have elapsed —
  // what the row is actually waiting for is the next death, and that is what it says.
  const r = respawnReading(after.state.rows[0], nowMs)
  assert.equal(r.stale, true)
  assert.equal(r.seen, false)
  assert.equal(respawnClockLabel(after.state.rows[0], nowMs, fmt), RESPAWN_AWAITING_LABEL)
})

test('the next death starts the normal cycle, with nothing to undo', () => {
  // The other half of the ruling: a stale row is waiting for one thing, and when it arrives the row
  // is an ordinary countdown again. No re-watch, no re-typing, no state to clear.
  const mod = new RespawnModule(watching('a vis ghoul knight'))
  mod.reset()
  let seq = 0
  for (const raw of [
    '[Sun Aug 02 18:00:00 2026] You have entered The Ruins of Old Guk.',
    '[Sun Aug 02 18:05:00 2026] You have slain a vis ghoul knight!',
    '[Sun Aug 02 23:05:00 2026] You have slain a vis ghoul knight!'
  ]) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  const fresh = mod.snapshot().state.rows[0]
  const nowMs = fresh.baseTs + 60_000
  // The five-hour gap is a real same-stay sample, so the row is numbered by it — an upper bound, as
  // always — and it is counting down from the death that just landed.
  assert.equal(fresh.kills, 2)
  assert.equal(fresh.samples, 1)
  assert.equal(fresh.source, 'observed')
  const r = respawnReading(fresh, nowMs)
  assert.equal(r.stale, false)
  assert.equal(r.due, false)
  assert.equal(respawnClockLabel(fresh, nowMs, fmt), '4h 59m')
})

test('a long-elapsed estimate says it is long gone, and stops counting', () => {
  // The wiki-numbered case, which is the other thing the owner can be looking at: an estimate DID
  // elapse, hours back. "due 5h 12m ago" is a growing number about a mob this app knows nothing
  // about, so past the linger the row says the fact and drops the arithmetic.
  const base = row({ estimateMs: 600_000 })
  const justDue = 1_600_000 + 60_000
  assert.equal(respawnClockLabel(base, justDue, fmt), 'due 1m 00s ago', 'inside the window it still counts')
  const later = 1_600_000 + RESPAWN_LINGER_MS + 60_000
  assert.equal(respawnReading(base, later).stale, true)
  assert.equal(respawnClockLabel(base, later, fmt), RESPAWN_LONG_DUE_LABEL)
  // The estimate itself is untouched — the row still prints its rung and its duration beside this,
  // and `overdueMs` is still the truth for anything that wants it.
  assert.equal(respawnReading(base, later).overdueMs, RESPAWN_LINGER_MS + 60_000)
  // AND EVIDENCE STILL OUTRANKS IT: a sighting inside the window is the better answer, and the row
  // leads with the fact exactly as round 3 ruled.
  const seen = row({ estimateMs: 600_000, seenTs: later - 1_000, seenVia: 'combat' })
  assert.equal(respawnReading(seen, later).stale, false)
  assert.equal(respawnClockLabel(seen, later, fmt), 'UP')
})

test('a stale row sinks under every live clock, and is still there', () => {
  // The cost the ruling could have had, refused: a night of old kills ranks `remainingMs: 0` and
  // would have sat ON TOP of the clock running in front of you. Seen first, then the live clocks,
  // then the ones with no estimate, then the stale.
  const now = 10 * HOURS
  const seen = row({ id: 'seen', display: 'A', baseTs: now - 9 * HOURS, seenTs: now - 5_000 })
  const running = row({ id: 'running', display: 'B', baseTs: now - 60_000 })
  const bare = row({ id: 'bare', display: 'C', baseTs: now - 60_000, estimateMs: undefined, source: 'none' })
  const staleEstimate = row({ id: 'stale', display: 'D', baseTs: now - 8 * HOURS })
  const staleBare = row({ id: 'stale-bare', display: 'E', baseTs: now - 8 * HOURS, estimateMs: undefined })
  const order = orderRespawnRows([staleBare, staleEstimate, bare, running, seen], now).map((r) => r.id)
  assert.deepEqual(order, ['seen', 'running', 'bare', 'stale', 'stale-bare'])
})

test('a months-old replay opens holding every watch it has a death for', () => {
  // THE COLD START, over real bytes: the app folds the whole log at launch and the deaths in it are
  // old. tests/respawnTimers.test.mts asserted the OPPOSITE until round 8 — that the sweep emptied
  // the list — and the owner found out in live play what that meant. Everything watched here is a
  // mob the player asked for by name, and every one of them still has a row a week later.
  const prefs = watching(...BEFALLEN_FOUR, 'a vis ghoul knight', 'a wan ghoul knight')
  const fresh = replay('wl40-farm-run.log', prefs, WL40_END)
  assert.ok(fresh.rows.length > 0, 'watched, and alive at the end of the run')
  const long = replay('wl40-farm-run.log', prefs, WL40_END + 7 * 24 * 3600 * 1000)
  assert.equal(long.rows.length, fresh.rows.length, 'a week later the SAME watches still have rows')
  // The list stays bounded by the things that always bounded it — the watch list and the row cap —
  // and never by a clock quietly retiring a mob the user is still watching.
  assert.ok(long.rows.every((r) => prefs.watches.some((w) => w.key === r.key)))
  // …and every one of them reads as what it is: a week past due, with nothing claimed about it.
  const after = WL40_END + 7 * 24 * 3600 * 1000
  assert.ok(long.rows.every((r) => respawnReading(r, after).stale))
  // …and the candidates survive too, because "what have I killed here" is not a countdown.
  assert.ok(long.recent.length > 0)
})

test('unwatching still takes the row away — the ruling is about WATCHED mobs', () => {
  // The linger no longer removes anything, and that must not turn into "nothing removes anything".
  // The watch list is still the admission rule, at any age of death.
  const { mod, snap } = foldOneAncientKill()
  mod.onTick(snap.recent[0].lastTs + 5 * HOURS)
  mod.setPrefs(watching('a vis ghoul knight'))
  assert.equal(mod.snapshot().state.rows.length, 1)
  mod.setPrefs({ watches: [] })
  assert.equal(mod.snapshot().state.rows.length, 0, 'unwatched is unwatched, however old the kill')
  // …and the mob is offered again the instant after, which is where the owner met it.
  assert.equal(mod.snapshot().state.recent[0].watched, false)
})
