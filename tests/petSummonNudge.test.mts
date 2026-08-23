// GOLDEN WINDOW — THE NUDGE FOR A PET THE METER CANNOT SEE (JOS-258).
//
// THE REPORT (01KZV95MT7TRYTPSGS5EXFGNK3, app 0.23.0): the reporter swapped Monk/Shaman/Enchanter
// for Monk/Shaman/Magician and their pet's damage vanished from the meter. The characterization
// found nothing to repair — the combat engine has no class gating and is handed no loadout signal
// at all. A CHARMED pet binds off its own broadcast (366 of 366 measured); a SUMMONED pet binds
// only through the three player-action routes in petClaims.ts, and a magician's pet that
// auto-assists without ever being ordered matches none of them, so its damage is dropped at
// routing.ts. That is JOS-49's ACCEPTED blind spot, arriving in somebody's real session.
//
// THE OWNER'S RULING (2026-08-12) was option (a): do not reopen JOS-49 — auto-adopting the first
// unknown attacker after a summon is precisely the detector that ruling cut — and instead say ONE
// sentence, in the meter overlay, for a while after a summon that nothing binds. Verbatim: not
// overly wordy; on the content background of the meter; appears only for a time after summoning
// and then TIMES OUT; staleness or repetition is wrong.
//
// SO THIS FILE PINS A TIMEOUT, and the two committed pet fixtures happen to hold both halves of it
// on real bytes:
//
//   p1-unbound-pet.log   Thu Jul 30 16:30:13 `You begin casting Yegoreff's Animation.`
//                        …and in the twenty minutes it covers, ZERO tells, ZERO leader answers and
//                        ZERO pet-only buff landings. This is the reported case exactly, and the
//                        replay still ends with `petDisplayNames() === []`.
//   p2-pet-arc-bound.log Thu Aug 06 12:35:43 a summon, bound 449 s later by a tell (the nudge is
//                        drawn and times out unheeded), and 12:44:45 a SECOND summon bound SIX
//                        SECONDS later (the nudge is never drawn at all). Six seconds is the number
//                        the grace window exists for, measured rather than picked.
//
// AND IT PINS THE RULING JOS-49 MADE, which this feature must not quietly reverse: while the nudge
// is on screen the unbound pet's damage is still DROPPED. The nudge coaches; it never adopts.
//
// LIVE, NOT REPLAYED. The nudge is armed only when `st.hydrating` is false, so every replay here
// feeds `live: true` — a summon from four hours ago is not news, and the flag is the only honest
// way to tell those apart.
//
// Fixture-guarded: `read` returns [] when a file is absent and its tests skip.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import {
  NUDGE_GRACE_MS,
  NUDGE_QUIET_MS,
  NUDGE_SHOW_MS,
  PET_SUMMON_SPELLS,
  isPetSummonSpell
} from '../src/main/combat/petNudge'

installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string[] => {
  const p = join(HERE, 'fixtures', name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const P1 = read('p1-unbound-pet.log')
const P2 = read('p2-pet-arc-bound.log')
const skipP1 = P1.length === 0 ? 'fixture not present' : false
const skipP2 = P2.length === 0 ? 'fixture not present' : false

/** The full window the nudge occupies, measured from the summon cast. */
const WINDOW_MS = NUDGE_GRACE_MS + NUDGE_SHOW_MS

interface Replay {
  eng: CombatEngine
  /** ts of every `You begin casting <a pet summon>.` the replay folded, in order. */
  summons: number[]
  lastTs: number
}

/**
 * Fold `lines` LIVE, optionally stopping at `untilTs` — which is how a fixture test observes a
 * moment INSIDE the log rather than only its end. The engine's own clock is the log's, so a
 * snapshot taken at a stated instant is the screen as it stood at that instant.
 */
function replay(lines: string[], untilTs = Number.POSITIVE_INFINITY): Replay {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const summons: number[] = []
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (ev.ts > untilTs) break
    if (ev.kind === 'castBegin' && isPetSummonSpell(ev.spell)) summons.push(ev.ts)
    eng.ingestEvent(ev, true)
    lastTs = Math.max(lastTs, ev.ts)
  }
  return { eng, summons, lastTs }
}

const nudgeAt = (r: Replay, now: number): ReturnType<CombatEngine['snapshot']>['petNudge'] =>
  r.eng.snapshot(now, {}).petNudge

// ── 1. THE ROSTER ──────────────────────────────────────────────────────────────────────────

test('the summon family is read off the effect lines, and it is what these logs cast', () => {
  // Derived, never listed (JOS-251's overlay). The spot checks are the spells the two committed
  // fixtures actually contain plus one of each class ladder that the `spellType` column misses.
  assert.equal(PET_SUMMON_SPELLS.size, 99, 'player-castable canonical names')
  for (const s of ["Yegoreff's Animation", "Kintaz's Animation", 'Minor Summoning: Water', 'Haunting Corpse', 'Vocarate: Fire', 'Monster Summoning III'])
    assert.equal(isPetSummonSpell(s), true, `${s} summons a pet`)
  // …and the near neighbours that must NOT arm a nudge. `Summon Companion` teleports the pet you
  // already have; `Burnout` is the pet-only BUFF JOS-188 binds with; `Tiny Companion` shrinks one.
  for (const s of ['Summon Companion', 'Burnout', 'Tiny Companion', 'Greater Healing', 'Charm'])
    assert.equal(isPetSummonSpell(s), false, `${s} must not arm a nudge`)
})

// ── 2. THE REPORTED CASE, ON REAL BYTES ────────────────────────────────────────────────────

test('P1: the fixture carries the summon it says it does, and binds nothing', { skip: skipP1 }, () => {
  const has = (re: RegExp): number => P1.filter((l) => re.test(l)).length
  assert.equal(has(/\] You begin casting Yegoreff's Animation\.$/), 1)
  assert.equal(has(/told you, '.*Master\.'$/), 0, 'no tell in twenty minutes')
  assert.equal(has(/says, 'My leader is /), 0, 'no /pet who leader answer')
  const r = replay(P1)
  assert.deepEqual(r.eng.petDisplayNames(), [], 'the reported case: nothing binds')
  assert.equal(r.summons.length, 1)
})

test('P1: the nudge waits out the grace, draws, and then takes itself off', { skip: skipP1 }, () => {
  // ASCENDING ON PURPOSE: the sweep is monotonic (a snapshot at T retires an arm whose window
  // closed before T), which is the same contract sweepCharm/sweepAlly hold. Reading the clock
  // backwards is not a state this engine has.
  const r = replay(P1)
  const t = r.summons[0]
  assert.equal(nudgeAt(r, t), undefined, 'nothing at the instant of the cast')
  assert.equal(nudgeAt(r, t + NUDGE_GRACE_MS - 1), undefined, 'nothing while a bind could still arrive')
  assert.deepEqual(nudgeAt(r, t + NUDGE_GRACE_MS), { summonedTs: t, expiresTs: t + WINDOW_MS }, 'drawn')
  assert.ok(nudgeAt(r, t + WINDOW_MS - 1), 'still up one millisecond before its deadline')
  assert.equal(nudgeAt(r, t + WINDOW_MS), undefined, 'and gone at it')
  assert.equal(nudgeAt(r, t + WINDOW_MS + 3_600_000), undefined, 'an hour later it is still gone')
})

// ── 3. THE OTHER HALF: A BIND THAT ARRIVES IN TIME IS NEVER ARGUED WITH ─────────────────────

test('P2: the fixture holds both arcs - one summon bound in 449 s, one in 6', { skip: skipP2 }, () => {
  const r = replay(P2)
  assert.deepEqual(r.summons.length, 2, 'two summons')
  assert.equal(r.summons[1] - r.summons[0], 542_000, 'nine minutes apart')
  // The evidence for the grace window, quoted from the log: the second pet names itself six
  // seconds after the cast that made it.
  const tell = P2.find((l) => /Gonekn told you, '.*Master\.'$/.test(l))
  assert.ok(tell, 'the second arc ends in a tell')
  assert.deepEqual(r.eng.petDisplayNames(), ['Gonekn'], 'and that tell is what the meter runs on')
})

test('P2: the FIRST summon goes 449 s unbound, so the nudge is drawn', { skip: skipP2 }, () => {
  const r = replay(P2, Date.parse('Thu Aug 06 2026 12:36:00'))
  const t = r.summons[0]
  assert.deepEqual(r.eng.petDisplayNames(), [], 'nothing has named the pet yet')
  assert.ok(nudgeAt(r, t + NUDGE_GRACE_MS), 'the meter says the sentence')
})

test('P2: the SECOND summon binds inside the grace, so the nudge is never drawn at all', { skip: skipP2 }, () => {
  // THE MEASUREMENT THE GRACE WINDOW IS FOR. `Kintaz's Animation` at 12:44:45, `Gonekn told you,
  // 'Attacking a greater kobold Master.'` at 12:44:51. A nudge drawn at the cast would have been
  // yanked six seconds later, which teaches nobody anything and is exactly the flicker the ruling
  // calls staleness. Sampled once a second across the whole window rather than at a chosen
  // instant, because "never drawn" is a claim about every instant.
  const r = replay(P2, Date.parse('Thu Aug 06 2026 12:44:55'))
  const t = r.summons[1]
  assert.deepEqual(r.eng.petDisplayNames(), ['Gonekn'], 'bound by the tell')
  for (let dt = 0; dt <= WINDOW_MS; dt += 1_000)
    assert.equal(nudgeAt(r, t + dt), undefined, `nothing at +${dt / 1000}s`)
})

// ── 4. THE MECHANICS, IN THE LOG SHAPES THE FIXTURES USE ───────────────────────────────────

const DAY = 'Sun Jul 19'
const at = (t: string): number => Date.parse(`${DAY} 2026 ${t}`)
const CAST = (t: string, spell: string): string => `[${DAY} ${t} 2026] You begin casting ${spell}.`
const FIZZLE = (t: string, spell: string): string => `[${DAY} ${t} 2026] Your ${spell} spell fizzles!`
const TELL = (t: string, name: string): string => `[${DAY} ${t} 2026] ${name} told you, 'Attacking an ogre guard Master.'`
const SWING = (t: string, name: string, n: number): string =>
  `[${DAY} ${t} 2026] ${name} pierces an ogre guard for ${n} points of damage.`
const SUMMON = 'Cavorting Bones'

test('a chain of summons is ONE question - the nudge neither stacks nor slides', () => {
  // Chain-summoning (a fizzle-ridden recast, or a magician cycling elementals) prints several
  // casts in seconds. One slot means the nudge is anchored to the FIRST of them and expires on
  // that cast's clock, so a player who casts six times does not get a nudge six windows long.
  const r = replay([CAST('21:00:00', SUMMON), CAST('21:00:03', SUMMON), CAST('21:00:07', SUMMON)])
  const t = at('21:00:00')
  assert.deepEqual(nudgeAt(r, t + NUDGE_GRACE_MS), { summonedTs: t, expiresTs: t + WINDOW_MS })
  assert.equal(nudgeAt(r, t + WINDOW_MS), undefined, 'the last cast did not extend it')
})

test('a summon that fizzles summons nothing, and says nothing', () => {
  const r = replay([CAST('21:00:00', SUMMON), FIZZLE('21:00:04', SUMMON)])
  assert.equal(nudgeAt(r, at('21:00:00') + NUDGE_GRACE_MS), undefined)
})

test('a bind INSIDE the grace means the sentence never existed', () => {
  const r = replay([CAST('21:00:00', SUMMON), TELL('21:00:06', 'Vabantik')])
  assert.deepEqual(r.eng.petDisplayNames(), ['Vabantik'])
  assert.equal(nudgeAt(r, at('21:00:00') + NUDGE_GRACE_MS), undefined)
})

test('a bind while it is UP dismisses it early - a bound pet needs no coaching', () => {
  const r = replay([CAST('21:00:00', SUMMON), TELL('21:00:30', 'Vabantik')])
  const t = at('21:00:00')
  assert.equal(nudgeAt(r, t + 29_000), undefined, 'the tell at +30s already folded in')
  // Re-read from a replay stopped before the tell, to see it up first.
  const before = replay([CAST('21:00:00', SUMMON), TELL('21:00:30', 'Vabantik')], at('21:00:20'))
  assert.ok(nudgeAt(before, t + 20_000), 'up before the tell')
})

test('all three binding routes dismiss it, because all three are one transition', () => {
  // petClaims.ts bindPetClaim is the single seam (AGENTS.md law 4 is a scar from having two), so
  // this is really an assertion that nothing here grew a fourth path of its own.
  const leader = (t: string, name: string): string => `[${DAY} ${t} 2026] ${name} says, 'My leader is Primitive.'`
  const gleam = (t: string, name: string): string => `[${DAY} ${t} 2026] ${name}'s eyes gleam with madness.`
  const t = at('21:00:00')
  for (const line of [TELL('21:00:06', 'Vabantik'), leader('21:00:06', 'Vabantik')])
    assert.equal(nudgeAt(replay([CAST('21:00:00', SUMMON), line]), t + NUDGE_GRACE_MS), undefined, line)
  // The pet-only buff route (JOS-188) needs its own armed cast, so it is spelled out in full.
  const buff = replay([CAST('21:00:00', SUMMON), CAST('21:00:02', 'Intensify Death'), gleam('21:00:07', 'Vabantik')])
  assert.deepEqual(buff.eng.petDisplayNames(), ['Vabantik'])
  assert.equal(nudgeAt(buff, t + NUDGE_GRACE_MS), undefined)
})

test('once it has been shown and ignored it goes quiet - this is the no-nagging clause', () => {
  // A player who summons repeatedly without ever ordering the pet has read the sentence and made a
  // choice. Repeating it every summon is the "repetition is wrong" half of the ruling.
  const first = at('21:00:00')
  const soon = replay([CAST('21:00:00', SUMMON), CAST('21:02:00', SUMMON)])
  assert.equal(nudgeAt(soon, at('21:02:00') + NUDGE_GRACE_MS), undefined, 'two minutes later: nothing')
  // …and it is a quiet PERIOD, not a one-shot: a summon well after it may speak again, because by
  // then it is a different pet in a different stretch of play.
  const later = replay([CAST('21:00:00', SUMMON), CAST('21:07:00', SUMMON)])
  const t2 = at('21:07:00')
  assert.ok(t2 - (first + WINDOW_MS) > NUDGE_QUIET_MS, 'the quiet period really has elapsed')
  assert.deepEqual(nudgeAt(later, t2 + NUDGE_GRACE_MS), { summonedTs: t2, expiresTs: t2 + WINDOW_MS })
})

test('a bind is not an ignore - the pet you ordered does not buy silence for the next one', () => {
  // The quiet period is charged only against a nudge the player SAW and did not act on. Ordering
  // the pet is acting on it, so a genuinely new unbound pet a minute later is a new question.
  const r = replay([CAST('21:00:00', SUMMON), TELL('21:00:20', 'Vabantik'), CAST('21:01:00', SUMMON)])
  assert.ok(nudgeAt(r, at('21:01:00') + NUDGE_GRACE_MS), 'the successor gets its own sentence')
})

test('a HISTORICAL fold arms nothing - a summon from hours ago is not news', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of [CAST('21:00:00', SUMMON)]) {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
  assert.equal(eng.snapshot(at('21:00:00') + NUDGE_GRACE_MS, {}).petNudge, undefined)
  assert.equal(eng.snapshot(at('21:00:00') + NUDGE_GRACE_MS, {}).hydrating, true, 'and the whole surface is quiet anyway')
})

// ── 5. THE RULING IT MUST NOT REVERSE ──────────────────────────────────────────────────────

test('the nudge COACHES, it does not adopt - the unbound pet is still nobody`s', () => {
  // JOS-49, restated as arithmetic. The owner cut the detector that would adopt the first unknown
  // attacker after a summon, and building a hint next to that gap must not quietly rebuild it: an
  // unbound pet's damage is dropped while the sentence is on screen, exactly as it was before.
  const r = replay([CAST('21:00:00', SUMMON), SWING('21:00:20', 'Vabantik', 40), SWING('21:00:25', 'Vabantik', 55)])
  const t = at('21:00:00')
  assert.ok(nudgeAt(r, t + 30_000), 'the sentence is up')
  assert.deepEqual(r.eng.petDisplayNames(), [], 'and the pet is still unbound')
  const snap = r.eng.snapshot(t + 30_000, { selectedId: 'zone' })
  assert.deepEqual(
    (snap.selected?.entities ?? []).filter((e) => e.kind === 'pet'),
    [],
    'no pet row - 95 points still dropped at routing, which is the accepted blind spot'
  )
})

test('the nudge is absent in the state the meter is in almost always', () => {
  // "No persistent banner" is structural: absence is the value, and every ordinary fight has it.
  const r = replay([SWING('21:00:00', 'Vabantik', 40), CAST('21:00:05', 'Greater Healing')])
  for (const dt of [0, 10_000, 60_000, 600_000]) assert.equal(nudgeAt(r, at('21:00:00') + dt), undefined)
})
