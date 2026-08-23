// The REAL kill histories the raid-roster specs replay, built once so two files cannot drift into
// two ideas of what "the Aug 01 ladder run" is. NOT a *.test.mts — it is imported by the specs
// that need it (tests/bossLockouts.test.mts, tests/bossDefeatedFilter.test.mts), the same shape as
// tests/comboFixtures.mts.
//
// NOTHING HERE PARSES A TIMESTAMP AT IMPORT TIME, and that is load-bearing. Its readers pin the
// process timezone (`process.env.TZ = 'America/Los_Angeles'`) in their own module body, which runs
// AFTER every import has been evaluated — so a `parseEqTimestamp` constant living here would be
// read under whatever zone the machine happens to be in and would silently move the golden. The
// stamps stay in the files that pin the clock; this module hands back records and nothing else.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { parseEvent } from '../src/main/log/parser'
import { KillsModule } from '../src/main/modules/kills'
import { allStatuses, type TargetStatus } from '../src/renderer/src/features/bosses/bossStatus'
import type { RaidTarget } from '../src/shared/types'
import { readFixture } from './harness.mts'

/** The Plane of Hate boss the tier-attribution diagnosis is about. */
export const IRE: RaidTarget = {
  name: 'Lord of Ire',
  category: 'Plane of Hate',
  match: ['Lord of Ire']
}
/** Killed by a charmed pet, hence a slain-BY line: the article-insensitive match case. */
export const PRINCESS: RaidTarget = {
  name: 'Thunder Spirit Princess',
  category: 'Plane of Sky',
  match: ['Thunder Spirit Princess']
}
/** The two Plane of Hate rows the five-rung week uses, spelled as bosses.json spells them. */
export const MAESTRO: RaidTarget = {
  name: 'Maestro of Rancor',
  category: 'Plane of Hate',
  match: ['Maestro of Rancor'],
  zone: 'Plane of Hate'
}
export const SPITE: RaidTarget = {
  name: 'Master of Spite',
  category: 'Plane of Hate',
  match: ['Master of Spite'],
  zone: 'Plane of Hate'
}

/** Replay committed fixtures, oldest first, into ONE kills module and fold the roster over it. */
function replay(fixtures: string[], targets: RaidTarget[]): TargetStatus[] {
  const mod = new KillsModule()
  mod.reset()
  let seq = 0
  for (const name of fixtures) {
    for (const raw of readFixture(name)) {
      const ev = parseEvent(raw, seq++)
      if (ev) mod.onEvent(ev)
    }
  }
  return allStatuses(targets, mod.snapshot().state.mobs)
}

/**
 * A history straddling Tue Aug 04 2026 08:00 Pacific:
 *   Sat Aug 01 16:09:29  Lord of Ire, d4 (The Plane of Hate - Solo 4 (Refined)) — credited
 *   Mon Aug 03 23:02:44  Lord of Ire, OPEN WORLD (The Plane of Hate)            — credited
 *   ── the reset ──
 *   Tue Aug 04 22:55:08  a thunder spirit princess, OPEN WORLD (Plane of Sky)   — credited
 *   Wed Aug 05 00:33:45  a thunder spirit princess, killed by Pesmerga          — witnessed
 */
export function history(): TargetStatus[] {
  return replay(['bosstier-lord-of-ire.log', 'boss-credit-open-world.log'], [IRE, PRINCESS])
}

/**
 * The five-difficulty ladder run (Sat Aug 01: d0..d4 of Maestro of Rancor, one credited kill in
 * each instance) plus the open-world Master of Spite kills either side of the same reset.
 */
export function hateWeek(): TargetStatus[] {
  return replay(['bosstier-hate-ladder-aug01.log', 'boss-open-world-hate.log'], [MAESTRO, SPITE])
}

/** One roster row by name — the specs read these lists by boss, never by index. */
export function byName(list: TargetStatus[], name: string): TargetStatus {
  const found = list.find((s) => s.target.name === name)
  if (!found) throw new Error(`no roster row named ${name}`)
  return found
}
