// WHAT THE RUNNING ENTRY SHOWS, AND HOW RECENTLY KILLED IS SEARCHED (JOS-194, prototype round 7).
//
// Its own file for the reason tests/respawnSeen.test.mts and tests/respawnUnwatch.test.mts are:
// tests/respawnTimers.test.mts is at the repo's 400-code-line factoring ceiling, and these are two
// self-contained rulings rather than more cases of the ones already pinned there.
//
// THE TWO RULINGS. The owner removed "Your watches" — the list at the bottom of the Timers tab —
// and moved both of the things it held (the removal and the custom-seconds box) onto the mob's
// RUNNING entry, which additionally has to show "any observation history we hold". So:
//
//   * `RespawnRow.gapsMs` publishes the death→death gaps this fold measured, newest first and
//     bounded, BESIDE the minimum it already published. It is the working behind rung 2, not a
//     second opinion about it — `observedMs` is still the minimum over EVERY gap.
//   * `RespawnRow.customMs` publishes rung 1, so the control that now lives on the row has something
//     to open with. Deliberately published rather than inferred from `estimateMs`. (Round 9 replaced
//     the seconds box with an edit icon and a modal; `customMs` is unchanged and is what that modal
//     reads, so these cases are still exactly the claim they were — see tests/respawnOverride.test.mts
//     for the round-9 half.)
//   * `filterRespawnCandidates` is the whole of the search: one pass, three fields, one rule, and
//     an empty query returning the SAME array (the `filterByQuery` contract from the Sky search —
//     JOS-206's learnings applied to the other list in this app that grows while you play).
//
// The gap ARITHMETIC below is hand-computed off the line list or off the committed fixture, before
// the module was asked — the golden-window law, same as its sibling files.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { RespawnModule } from '../src/main/modules/respawn'
import {
  DEFAULT_RESPAWN_PREFS,
  RESPAWN_MAX_GAPS,
  filterRespawnCandidates,
  respawnCandidateMatches,
  respawnGapsLabel,
  type RespawnCandidate,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSnap
} from '../src/shared/respawn'
import { readFixture } from './harness.mts'

/** The fixture's last event, hand-read off the raw text: Mon Aug 03 2026 00:33:26 UTC. */
const WL40_END = 1785717206000

/** Watch these mobs, with no numbers of your own — tracking is opt-in, so a test wanting rows asks. */
function watching(...keys: string[]): RespawnPrefs {
  return { watches: keys.map((key) => ({ key, display: key })) }
}

/** Fold a list of raw lines, then set the module's clock and read the snapshot. */
function fold(lines: readonly string[], prefs: RespawnPrefs, nowMs: number): RespawnSnap {
  const mod = new RespawnModule(prefs)
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(nowMs)
  return mod.snapshot().state
}

/** The same, over a committed fixture. */
function replay(fixture: string, prefs: RespawnPrefs, nowMs: number): RespawnSnap {
  return fold(readFixture(fixture), prefs, nowMs)
}

function find(snap: RespawnSnap, key: string): RespawnRow | undefined {
  return snap.rows.find((r) => r.key === key)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKING BEHIND RUNG 2
// ─────────────────────────────────────────────────────────────────────────────

test('the row publishes the gaps it measured, newest first', () => {
  // Three qualifying gaps inside one stated stay: 5m, 8m, 4m in the order they happened. The row
  // leads with the freshest, and `observedMs` is still the SMALLEST of all three.
  const snap = fold(
    [
      '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
      '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!',
      '[Sun Aug 02 23:55:00 2026] You have slain a vis ghoul knight!',
      '[Mon Aug 03 00:03:00 2026] You have slain a vis ghoul knight!',
      '[Mon Aug 03 00:07:00 2026] You have slain a vis ghoul knight!'
    ],
    watching('a vis ghoul knight'),
    Date.parse('2026-08-03T00:08:00') || WL40_END
  )
  const r = snap.rows[0]
  assert.equal(r.samples, 3)
  assert.deepEqual(r.gapsMs, [240_000, 480_000, 300_000], 'newest first')
  assert.equal(r.observedMs, 240_000, 'still the minimum over every gap, not over the published few')
})

test('a gap the module refuses is refused by the working too', () => {
  // The two rules that keep the bound honest are the fold's, and the working must not quietly
  // reintroduce what they threw out: a pair spanning a zone line, and a pair inside 60 s (two mobs
  // in one pull). Neither is a sample, so neither is a printed gap.
  const snap = fold(
    [
      '[Sun Aug 02 23:45:41 2026] You have entered The Ruins of Old Guk.',
      '[Sun Aug 02 23:50:00 2026] You have slain a vis ghoul knight!',
      '[Sun Aug 02 23:50:30 2026] You have slain a vis ghoul knight!',
      '[Sun Aug 02 23:56:00 2026] You have entered The Ruins of Old Guk.',
      '[Mon Aug 03 00:01:00 2026] You have slain a vis ghoul knight!'
    ],
    watching('a vis ghoul knight'),
    Date.parse('2026-08-03T00:02:00') || WL40_END
  )
  const r = snap.rows[0]
  assert.equal(r.kills, 3)
  assert.equal(r.samples, 0)
  assert.equal(r.gapsMs, undefined, 'no samples means no working, not an empty list on the wire')
})

test('the working is BOUNDED, and the bound drops the oldest evidence', () => {
  // `a wan ghoul knight` measures eleven gaps over the committed fixture. A row under a countdown
  // is not a table, so six are published — the six most recent — while the estimate stays the
  // minimum over all eleven (60 s, the boundary case respawnTimers.test.mts pins).
  const wan = find(replay('wl40-farm-run.log', watching('a wan ghoul knight'), WL40_END), 'a wan ghoul knight')
  assert.ok(wan)
  assert.equal(wan.samples, 11)
  assert.equal(wan.gapsMs?.length, RESPAWN_MAX_GAPS)
  assert.equal(wan.observedMs, 60_000)
  // Every published gap clears the module's own floor — these are spawn cycles, not double pulls.
  for (const g of wan.gapsMs ?? []) assert.ok(g >= 60_000, `${String(g)} is under the gap floor`)
})

test('the gaps line says GAPS, and says nothing when there are none', () => {
  // The wording is load-bearing (law 1): this app has never watched a mob spawn, so a list of
  // death→death intervals may not be labelled as respawns observed. And a row with no samples
  // renders the line to nothing rather than to an empty label.
  const fmt = (ms: number | null | undefined): string => (ms == null ? '-' : `${String(Math.round(ms / 1000))}s`)
  const base: RespawnRow = {
    id: 'z::m',
    key: 'm',
    display: 'M',
    zone: 'Z',
    baseTs: 0,
    basis: 'death',
    source: 'observed',
    samples: 0,
    kills: 1
  }
  assert.equal(respawnGapsLabel(base, fmt), '')
  assert.equal(respawnGapsLabel({ ...base, gapsMs: [] }, fmt), '')
  const said = respawnGapsLabel({ ...base, gapsMs: [240_000, 480_000] }, fmt)
  assert.equal(said, 'gaps: 240s · 480s')
  assert.ok(!/respawn|spawn/i.test(said), said)
})

// ─────────────────────────────────────────────────────────────────────────────
// RUNG 1, NOW THAT THE BOX IS ON THE ROW
// ─────────────────────────────────────────────────────────────────────────────

test('the row carries the number its own seconds box edits', () => {
  // Rung 1 used to be reachable only from the retired list, so the row never needed to know it.
  // Now the box is ON the row, and `customMs` is what it opens with — published rather than
  // inferred from `estimateMs`, because a custom number and a wiki default that happen to agree are
  // different facts about where the number came from.
  const mod = new RespawnModule({ watches: [] })
  mod.reset()
  let seq = 0
  for (const raw of readFixture('wl40-farm-run.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  mod.onTick(WL40_END)
  mod.setPrefs(watching('a vis ghoul knight'))
  assert.equal(mod.snapshot().state.rows[0].customMs, undefined, 'no number of your own is the norm')

  mod.setPrefs({ watches: [{ key: 'a vis ghoul knight', display: 'a vis ghoul knight', customSec: 1000 }] })
  const r = mod.snapshot().state.rows[0]
  assert.equal(r.customMs, 1_000_000)
  assert.equal(r.source, 'custom')
  // …and the working is still there underneath it, which is the point of showing both: the box says
  // what you told the app, the gaps say what it saw.
  assert.equal(r.observedMs, 162_000)
  assert.ok((r.gapsMs?.length ?? 0) > 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// SEARCHING RECENTLY KILLED
// ─────────────────────────────────────────────────────────────────────────────

function cand(over: Partial<RespawnCandidate> = {}): RespawnCandidate {
  return {
    key: 'a frenzied ghoul',
    display: 'a frenzied ghoul',
    zone: 'The Ruins of Old Guk',
    lastTs: 1_000_000,
    kills: 2,
    watched: false,
    ...over
  }
}

test('the search matches the name, the zone and the wiki text - one rule, no per-field cases', () => {
  const c = cand({ wikiText: '16.0 min (PH)' })
  assert.equal(respawnCandidateMatches(c, 'ghoul'), true, 'the name')
  assert.equal(respawnCandidateMatches(c, 'old guk'), true, 'the zone')
  assert.equal(respawnCandidateMatches(c, 'ph'), true, "the wiki's verbatim words")
  assert.equal(respawnCandidateMatches(c, 'najena'), false)
  // The needle arrives already lowercased (`filterRespawnCandidates` folds it once per keystroke),
  // and an empty one matches everything - which is what "no search" has always meant.
  assert.equal(respawnCandidateMatches(c, ''), true)
  // A candidate the wiki says nothing about simply fails that field rather than throwing.
  assert.equal(respawnCandidateMatches(cand(), 'min'), false)
})

test('an empty query returns the SAME array, so the default path allocates nothing', () => {
  const items = [cand(), cand({ key: 'b', display: 'B', zone: 'Befallen' })]
  assert.equal(filterRespawnCandidates(items, ''), items)
  assert.equal(filterRespawnCandidates(items, '   '), items)
  // …and a real query is one pass, case-insensitive, over what the user typed with its edges cut.
  assert.deepEqual(
    filterRespawnCandidates(items, '  BEFALLEN ').map((c) => c.key),
    ['b']
  )
})

test('the search narrows what the fold really published, over real bytes', () => {
  // The list it filters is the module's own, so this drives it end to end rather than over a
  // hand-made array: one farm run offers dozens of names and typing five letters finds one family.
  const snap = replay('wl40-farm-run.log', DEFAULT_RESPAWN_PREFS, WL40_END)
  assert.ok(snap.recent.length > 5, 'the run offers plenty to search through')
  const ghouls = filterRespawnCandidates(snap.recent, 'ghoul')
  assert.ok(ghouls.length > 0)
  assert.ok(ghouls.length < snap.recent.length, 'and it actually narrowed')
  for (const c of ghouls) assert.ok(c.display.toLowerCase().includes('ghoul'), c.display)
  assert.deepEqual(filterRespawnCandidates(snap.recent, 'zzzz'), [])
})
