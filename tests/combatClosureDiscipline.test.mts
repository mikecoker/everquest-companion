// SEGMENTATION DISCIPLINE (Task #65) — the three rules that decide when a stranger, a stale
// hold or a vanished mob may keep the owner's fight open. Synthetic lines in the real log's
// exact shapes, because each of these needs a controlled gap length no single real window
// happens to contain (the same reason combatMultiMobSegmentation.test.mts carries an S1–S4
// battery beside its W24 golden). The REAL-LOG proof of the same rules is
// tests/combatCharmOwnership.test.mts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { CC_HOLD_MS, FALLBACK_IDLE_MS, PRESENCE_GONE_MS } from '../src/main/combat/encounter'
import { INSTANCE_STALE_MS } from '../src/main/combat/world'
import type { SegmentSummary } from '../src/shared/combat'

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  // LIVE FROM THE START, because that is the only state anybody ever LOOKS at a meter in, and
  // since JOS-208 phase 4 it is also the only state the wall-clock closure sweep runs in: a
  // replay is not a moment in time, so `snapshot(now)` no longer finalizes a fight while the
  // historical fold is still reading (engine.ts). Every window below asks what the meter shows
  // after its span, which is a live question; the poll-lag arms model the live tick race and
  // still exercise it.
  eng.setLive()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

const fights = (eng: CombatEngine, lastTs: number): SegmentSummary[] =>
  eng
    .snapshot(lastTs + 300_000, {})
    .segments.filter((s) => s.kind === 'fight')
    .reverse()

// ============================================================================
// THE CC HOLD IS A VETO ON ONE PATH, NOT ON CLOSURE.
//
// CC_HOLD_MS (120s) deliberately exceeds FALLBACK_IDLE_MS (60s) so that an ACTIVELY refreshed
// mez holds a fight open across the mez-and-wait gap. But the hold used to short-circuit
// evalClosure() outright, so ONE unrefreshed hold defeated EVERY closure path — two full
// minutes of a fight that nothing was going to reopen. The shipped semantics: a hold vetoes
// the DEATH-CLOSE (the judgement it informs — "is this engaged instance still alive?") and
// the fallback runs regardless.
// ============================================================================

test('CC1: a lone unrefreshed mez cannot outlive the idle fallback', () => {
  assert.ok(CC_HOLD_MS > FALLBACK_IDLE_MS, 'the hold is longer than the fallback — that is the hazard')
  const lines = [
    '[Sun Jul 19 09:00:00 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 09:00:01 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 09:00:02 2026] You crush a cave goblin for 100 points of damage.',
    // …then total silence, and a fresh pull 70s later: past FALLBACK_IDLE_MS, well inside the
    // 120s hold the mez opened.
    '[Sun Jul 19 09:01:12 2026] You crush a wandering rat for 50 points of damage.',
    '[Sun Jul 19 09:01:13 2026] You crush a wandering rat for 50 points of damage.'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 2, 'the stale hold does not fuse two pulls a minute apart')
  assert.equal(fs[0].name, 'a cave goblin')
  assert.equal(fs[1].name, 'a wandering rat')
})

test('CC2: a REFRESHED mez still holds the fight open — the case CC_HOLD_MS exists for', () => {
  // Every application/refresh stamps lastActivityTs, so the fallback clock never runs out
  // while the enchanter is keeping the mob asleep. This is the behavior that must NOT regress.
  const lines = [
    '[Sun Jul 19 10:00:00 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 10:00:01 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 10:00:02 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 10:00:40 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 10:00:41 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 10:01:20 2026] You begin casting Mesmerization III.',
    '[Sun Jul 19 10:01:21 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 10:01:50 2026] You crush a cave goblin for 100 points of damage.'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 1, 'one mez-and-wait pull spanning 110 seconds')
  assert.equal(fs[0].total, 200)
})

test('CC3: a mez with NO own cast behind it is inert — it holds nothing and engages nothing', () => {
  // Identical to CC1 minus the `You begin casting` line: another enchanter's mez, which the
  // owner's client also prints. Pre-fix it opened an encounter on a mob the owner had never
  // touched and held it for two minutes.
  const lines = [
    '[Sun Jul 19 11:00:00 2026] a cave goblin has been mesmerized.',
    '[Sun Jul 19 11:00:01 2026] an elite dragoon has been mesmerized.'
  ]
  const { eng, lastTs } = replay(lines)
  const snap = eng.snapshot(lastTs + 1_000, {})
  assert.equal(snap.segments.filter((s) => s.kind === 'current').length, 0, 'no encounter opened')
  assert.equal(fights(eng, lastTs).length, 0, 'and none finalized')
})

// ============================================================================
// PER-INSTANCE STALENESS. WorldModel kept ONE live slot per name and retired it only on a
// death line, so a same-named mob killed off-screen (or despawned, or fled) pinned its slot
// live forever and every later pull of that name inherited its identity and its gen label.
// ============================================================================

test('S5: a same-named mob that never logs a death does not pin its slot', () => {
  assert.equal(INSTANCE_STALE_MS, PRESENCE_GONE_MS, 'the world ages an instance out on the closure horizon')
  const lines = [
    // Pull 1: we hurt it, it walks away, and nothing ever says it died.
    '[Sun Jul 19 12:00:00 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 12:00:02 2026] You crush a rock golem for 100 points of damage.',
    // Pull 2, well past both the fallback and the staleness horizon: a DIFFERENT golem.
    '[Sun Jul 19 12:02:00 2026] You crush a rock golem for 60 points of damage.',
    '[Sun Jul 19 12:02:01 2026] You crush a rock golem for 60 points of damage.',
    '[Sun Jul 19 12:02:05 2026] You have slain a rock golem!'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 2, 'two pulls, separated by the idle fallback')
  // The label carries the spawn generation, so the second pull naming itself "(2)" IS the
  // assertion: the world model spawned a fresh entity instead of reviving the first golem.
  assert.equal(fs[0].name, 'a rock golem')
  assert.equal(fs[1].name, 'a rock golem (2)')
})

test('S6: a mob merely quiet INSIDE the horizon keeps its identity', () => {
  // The complement of S5, and the reason the horizon is a horizon: a 15s lull (under
  // PRESENCE_GONE_MS) is an ordinary miss streak, not a new mob.
  const lines = [
    '[Sun Jul 19 13:00:00 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 13:00:15 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 13:00:30 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 13:00:31 2026] You have slain a rock golem!'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 1)
  assert.equal(fs[0].name, 'a rock golem', 'one entity, no generation suffix')
  assert.equal(fs[0].total, 300)
})

test('S7: presence evidence (a whiff) keeps a slot fresh across the horizon', () => {
  // Misses never touch the damage timeline, but they ARE presence — and the world model's
  // lastSeenTs is refreshed by exactly the same evidence (EngineState.notePresence →
  // WorldModel.noteSeen), so a mob that only whiffs for 25s is still the same mob.
  const lines = [
    '[Sun Jul 19 14:00:00 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 14:00:08 2026] A rock golem tries to hit YOU, but misses!',
    '[Sun Jul 19 14:00:16 2026] A rock golem tries to hit YOU, but misses!',
    '[Sun Jul 19 14:00:24 2026] You try to crush a rock golem, but miss!',
    '[Sun Jul 19 14:00:30 2026] You crush a rock golem for 100 points of damage.',
    '[Sun Jul 19 14:00:31 2026] You have slain a rock golem!'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 1)
  assert.equal(fs[0].name, 'a rock golem', 'still generation 1 after 30s of mostly-whiffing')
  assert.equal(fs[0].total, 200)
})

// ============================================================================
// KNOWN PLAYERS ARE NEVER HOSTILES. The evidence is narrow by construction — see
// EngineState.knownPlayers for exactly why the scrubbed stream carries nothing better — but
// where it exists it is absolute.
// ============================================================================

test('P1: a group member who healed the owner can never become a target or an enemy healer', () => {
  const lines = [
    // THE evidence, and the only sound one: a heal LANDING ON THE OWNER names a friendly
    // player. (The mirror inference — `You healed <X>` ⇒ X is a player — is deliberately NOT
    // made; the owner heals his own pets by name, and reading that cost 50k of real pet
    // damage on a full replay. See routeHeal.)
    '[Sun Jul 19 15:00:00 2026] Grimtooth healed you for 500 hit points by Superior Healing.',
    '[Sun Jul 19 15:00:01 2026] a kodiak has been charmed.',
    "[Sun Jul 19 15:00:02 2026] A kodiak told you, 'Attacking Grimtooth Master.'",
    // The pet (bound by the ownership-definitive tell) swings at the group member. Booking
    // this would credit us the damage AND enter Grimtooth into `engaged` as a hostile.
    '[Sun Jul 19 15:00:03 2026] A kodiak crushes Grimtooth for 40 points of damage.',
    '[Sun Jul 19 15:00:05 2026] Grimtooth healed itself for 200 hit points by Superior Healing.',
    // The owner's own, real pull.
    '[Sun Jul 19 15:00:10 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 15:00:14 2026] You have slain a cave goblin!'
  ]
  const { eng, lastTs } = replay(lines)
  const sel = eng.snapshot(lastTs + 300_000, { selectedId: 'zone' }).selected!
  const names = [...sel.entities, ...sel.incoming].map((e) => e.name)
  assert.ok(!names.includes('Grimtooth'), 'a player is not a combat source of ours')
  assert.equal(sel.entities.find((e) => e.kind === 'pet'), undefined, 'and no pet damage was booked at him')
  assert.equal(sel.outTotal, 100, 'only the owner\'s own swing counts')
  assert.equal(sel.enemyHealTotal, 0, 'a player\'s self-heal is not enemy healing')
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 1, 'the pull closes on the goblin\'s death — Grimtooth never vetoed it')
  assert.equal(fs[0].name, 'a cave goblin')
})

test('P2: the same swing at an ordinary MOB is still the pet\'s damage', () => {
  // The control for P1: nothing about the pet path changed except the player exclusion.
  const lines = [
    '[Sun Jul 19 16:00:00 2026] a kodiak has been charmed.',
    "[Sun Jul 19 16:00:02 2026] A kodiak told you, 'Attacking a cave goblin Master.'",
    '[Sun Jul 19 16:00:03 2026] A kodiak crushes a cave goblin for 40 points of damage.',
    '[Sun Jul 19 16:00:06 2026] You have slain a cave goblin!'
  ]
  const { eng, lastTs } = replay(lines)
  const sel = eng.snapshot(lastTs + 300_000, { selectedId: 'zone' }).selected!
  const pet = sel.entities.find((e) => e.kind === 'pet')
  assert.ok(pet, 'the promoted charm pet attributes normally')
  assert.equal(pet!.total, 40)
})
