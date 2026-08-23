// THE MOB KILLS JOIN (JOS-350) — reading a mob's kill record BY NAME, from any surface.
//
// THE DEFECT, from report 01KZYCCTR9B0WZCDWHGJ3D99AE: the Mobs tab showed the right total kills
// for a mob while the combat-fed surface showed 0 for the same mob. Two causes, both about the
// KEY, and both pinned below:
//
//   1. The kills module WRITES under `idKey(<the slain line's spelling>)` — trim + lowercase and
//      nothing else. The combat-fed surfaces name a mob with `WorldModel.label()`'s output, which
//      appends a spawn GENERATION — "an elemental capturer (14)". No kill record is ever keyed
//      that way (the suffix appears in NO log line — world-model law 2), so every lookup with a
//      live target's name missed, and `Kills 0` is what a miss renders.
//   2. The three apostrophe glyphs. The log writes ``Innoruuk`s Chosen`` with a backtick; the
//      committed catalog — which is what the Mobs tab searches and what its rows look up WITH —
//      writes it with `'`. Two spellings of one mob were two records that could never meet.
//
// The fix is one fold on BOTH sides: `killIndex` re-keys the snapshot by `mobKey`, `killsFor`
// reads it with the same key. So these cases build the map through the REAL writer (`recordKill`,
// keyed by the REAL `idKey`, off names spelled the way the log spells them) and then ask for it
// the way each surface asks.
//
// Pure units — no UI, no Electron. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordKill } from '../src/main/log/reducers'
import { idKey } from '../src/main/log/parseCommon'
import { mobKey as mainMobKey } from '../src/main/mobLookupParse'
import { mobKey } from '../src/shared/mobKey'
import { TIER_OPEN_WORLD, killIndex, killsFor } from '../src/shared/kills'
import type { KillMap } from '../src/shared/types'

const T = 1_754_000_000_000

/** Fold one kill exactly as `main/modules/kills.ts` does: `idKey` of the slain line's spelling. */
function kill(kills: KillMap, name: string, ts: number, tier = TIER_OPEN_WORLD): void {
  recordKill(kills, { key: idKey(name), display: name, tier, ts, credited: true })
}

test('mobKey is the ONE canonical mob key, wherever it is imported from', () => {
  // The function moved from src/main/mobLookupParse.ts to src/shared so the renderer can join
  // with it. Same identity, not a copy — a second implementation is how two surfaces disagree.
  assert.equal(mainMobKey, mobKey)
})

test('the spawn-generation suffix does not hide a mob s kills', () => {
  const kills: KillMap = {}
  // Three kills, spelled the way the LOG spells them: no suffix, ever.
  kill(kills, 'an elemental capturer', T)
  kill(kills, 'An elemental capturer', T + 60_000)
  kill(kills, 'an elemental capturer', T + 120_000)
  // The writer already folds case, so the raw map has one entry and it is NOT suffix-keyed.
  assert.deepEqual(Object.keys(kills), ['an elemental capturer'])

  const index = killIndex(kills)

  // The Mobs tab's spelling — the catalog row — was never the broken one.
  assert.equal(killsFor(index, 'An elemental capturer')?.count, 3)
  // The combat-fed spelling: `CurrentTarget.name` carries WorldModel's generation counter. THIS
  // is the report: it used to miss, and a miss renders `Kills 0`.
  assert.equal(killsFor(index, 'an elemental capturer (14)')?.count, 3)
  assert.equal(killsFor(index, 'An elemental capturer (2)')?.count, 3)

  // A parenthesized WORD is part of a name, not a copy number — the strip is digits only.
  assert.equal(killsFor(index, 'an elemental capturer (Awakened)'), undefined)
})

test('two apostrophe spellings of one mob are one kill record', () => {
  const kills: KillMap = {}
  // The log's backtick spelling…
  kill(kills, 'Innoruuk`s Chosen', T)
  kill(kills, 'Innoruuk`s Chosen', T + 60_000)
  // …and, for a mob whose lines have been seen both ways, the typographic one.
  kill(kills, 'Innoruuk’s Chosen', T + 120_000)
  assert.equal(Object.keys(kills).length, 2, 'the WRITER records what the log said — two keys')

  const index = killIndex(kills)
  assert.equal(Object.keys(index).length, 1, 'the JOIN folds them into one record')

  // Asked for with the CATALOG's straight apostrophe — the Mobs tab's spelling.
  const found = killsFor(index, "Innoruuk's Chosen")
  assert.equal(found?.count, 3, 'every kill counts once, whichever glyph carried it')
  // The merge is a real fold of the per-tier runs, not a last-wins overwrite.
  assert.equal(found?.tiers[TIER_OPEN_WORLD]?.count, 3)
  assert.equal(found?.tiers[TIER_OPEN_WORLD]?.credited, 3)
  assert.equal(found?.firstTs, T, 'the span brackets the FIRST spelling s first kill')
  assert.equal(found?.lastTs, T + 120_000)
  // Display stays RAW and first-seen (law 2) — the fold renames nobody.
  assert.equal(found?.display, 'Innoruuk`s Chosen')
})

test('the join keeps the leading article, and reports an absence as an absence', () => {
  const kills: KillMap = {}
  kill(kills, 'a giant rat', T)
  const index = killIndex(kills)

  assert.equal(killsFor(index, 'a giant rat')?.count, 1)
  // Article-insensitive matching is a BOSS rule (bossStatus.lowerKillMap), not this one: "a giant
  // rat" and "giant rat" are different wiki pages and the log always prints the article.
  assert.equal(killsFor(index, 'giant rat'), undefined)
  // A mob you have never killed has NO record — the page's `Kills 0` is then the truth rather
  // than a missed join, which is the whole distinction this ticket was about.
  assert.equal(killsFor(index, 'a hill giant'), undefined)
})

test('killIndex over an empty map is empty, and every tier survives the re-key', () => {
  assert.deepEqual(killIndex({}), {})

  const kills: KillMap = {}
  kill(kills, 'a sand giant', T, 0)
  kill(kills, 'a sand giant', T + 1000, 4)
  kill(kills, 'A sand giant', T + 2000, TIER_OPEN_WORLD)
  // Asked for the way the live target names it — the read that used to miss.
  const found = killsFor(killIndex(kills), 'a sand giant (3)')
  assert.equal(found?.count, 3)
  assert.equal(found?.bestTier, 4, 'the derived scalars are re-derived, never carried across')
  assert.equal(Object.keys(found?.tiers ?? {}).length, 3)
})
