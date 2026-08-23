// WHAT AN ALLY'S PET IS DECIDES HOW ITS BIND ENDS (JOS-270).
//
// THE REPORT (01KZVYMCAD72XFC36D73D8J2E8, 0.21.0): "Pet damage of part members is not associating
// to them, Gasarn is the pet of Zeksara but its not adding gasarns damage to he rparse". Gasarn is
// a group-mate's SUMMONED magician pet — 11,905 damage over 371 events in the slice, ~14 percent
// of the zone's true total, booked to nobody.
//
// The bind path for it already existed (the leader say, JOS-250 path 2) but wore the CHARM
// lifecycle, and the characterization replay measured what that costs: with the say injected,
// 8,496 of the 11,905 books and then the SOFT-HOSTILE rule kills the bind at 17:33:20 — because
// Gasarn hit `a wan ghoul knight`, which is the name of the REPORTER'S OWN charm pet. A pure name
// collision, 3,409 lost. The hold was charm-clocked at 16 minutes on top of that.
//
// TWO OWNER RULINGS, 2026-08-13, and this file exists to pin both:
//
//   1. **THE LIFECYCLE KEYS ON THE EVIDENCE, NOT ON WHICH LINE BOUND IT.** `/pet who leader` is
//      answered by a CHARM pet exactly as readily as by a summoned one, so `via: 'leader'` proves
//      nothing about the creature. `AllyBind.kind` is the discernment — charm evidence for the
//      PET (a broadcast has named it) outranks summon evidence for the OWNER (they were seen
//      casting a pet summon), and with neither the safer default is the charm lifecycle.
//   2. **THE HOLD SLIDES ON EVIDENCE.** The old rule was a wall clock from the bind to the
//      spell's LISTED duration, on the argument that a charm cannot outlive its spell. AAs and
//      focus effects say otherwise, and a clock that cuts a still-live charm loose
//      under-attributes exactly the way this ticket exists to stop. The window now measures
//      SILENCE: every line the bound name acts on re-bases it, and `sweep` reaps a pet that has
//      stopped appearing.
//
// EVERYTHING JOS-250 MEASURED IS UNTOUCHED and lives next door in allyCharmWindows.test.mts —
// the four real cut windows, the whole-log split (441 the owner's charms, 15 a third party's),
// and the soft-hostile break, which STAYS for everything charm-shaped.
//
// The state-machine half is driven through `AllyCharms` directly; the engine half replays a
// hand-assembled window through the real parser and engine (see its header for why it is
// hand-assembled and which line is injected).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import { AllyCharms, type AllyLeaderLine } from '../src/main/combat/allyCharms'
import { EMPTY_ROSTER } from '../src/shared/roster'
import type { SourceView } from '../src/shared/combat'

installSpellDb(loadSpellDb())
installCharacterName('Primitive')

const CAJOLING = 'Cajoling Whispers III'
/** A pet-summon spell the reporter's own log printed — `isPetSummonSpell` agrees (JOS-251's
 *  wiki-derived roster), which is what makes it the summon evidence throughout. */
const CONJURATION = 'Minor Conjuration: Fire'
/** Cajoling Whispers and Beguile are both listed at 16 minutes; DURATION_SLACK_MS adds one. */
const WINDOW_MS = 17 * 60_000

/** One `<Pet> says, 'My leader is <Owner>.'` as the model asks about it. Defaults are the Kober /
 *  Gonekn pair and NO charm evidence, so each test states only the field it is about. */
const leaderLine = (o: Partial<AllyLeaderLine> = {}): AllyLeaderLine => ({
  petKey: 'kober',
  pet: 'Kober',
  owner: 'Gonekn',
  ownerKey: 'gonekn',
  ts: 1_000,
  everCharmed: false,
  ...o
})

/** Replay through the REAL parser + engine. `members` loads a group roster, which this window
 *  needs: the reported pet's owner is a group-mate. */
function replay(
  lines: string[],
  upTo = Number.POSITIVE_INFINITY,
  members: readonly string[] = []
): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setLive()
  eng.setPlayerName('Primitive')
  if (members.length > 0) {
    const keys = new Set(members.map((m) => m.toLowerCase()))
    const byKey = new Map(members.map((m) => [m.toLowerCase(), m]))
    eng.setRoster({
      view: () => ({ members: keys, admitted: keys, nameOf: (k: string) => byKey.get(k) }),
      snap: () => EMPTY_ROSTER
    })
  }
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.ts > upTo) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

const zone = (eng: CombatEngine, lastTs: number): { entities: SourceView[]; outTotal: number } => {
  const sel = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).selected!
  return { entities: sel.entities, outTotal: sel.outTotal }
}
const allyRows = (eng: CombatEngine, lastTs: number): SourceView[] =>
  zone(eng, lastTs).entities.filter((e) => e.kind === 'allyPet')

// ============================================================================
// RULING 1 — THE THREE RUNGS OF THE DISCERNMENT, at the model level.
// ============================================================================

test('CHARM EVIDENCE FOR THE PET keeps the charm lifecycle, whatever bound it', () => {
  // Rung 1. The zone has seen this name charmed, so it is a charmed mob and it wears all four
  // ends — even though a leader say is what named its owner.
  const m = new AllyCharms()
  const bind = m.bindByLeader(leaderLine({ everCharmed: true }))
  assert.equal(bind.via, 'leader', 'the leader say still made the bind')
  assert.equal(bind.kind, 'charm', '…and the evidence still calls it a charmed mob')
  // The 16-minute window, byte for byte what this method produced before JOS-270.
  assert.equal(bind.windowMs, WINDOW_MS)
  assert.equal(bind.holdUntil, 1_000 + WINDOW_MS)
  assert.deepEqual(m.sweep(1_000 + 16 * 60_000), [], 'inside its window')
  assert.equal(m.sweep(1_000 + WINDOW_MS).length, 1, 'and gone after a window of silence')

  // …and the SOFT-HOSTILE PROOF still ends it.
  const again = new AllyCharms()
  again.bindByLeader(leaderLine({ everCharmed: true }))
  assert.equal(again.softHostile('kober')?.charmer, 'Gonekn', 'the break fires')
  assert.ok(again.idle)
})

test('SUMMON EVIDENCE FOR THE OWNER drops the break rule and the clock', () => {
  // Rung 2. `Zeksara begins casting Minor Conjuration: Fire.` is a real line from the report's own
  // slice (17:19:18, twelve seconds before Gasarn's first), and `isPetSummonSpell` agrees.
  const m = new AllyCharms()
  m.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 0, allowed: true })
  const bind = m.bindByLeader(
    leaderLine({ petKey: 'gasarn', pet: 'Gasarn', owner: 'Zeksara', ownerKey: 'zeksara', ts: 13_000 })
  )
  assert.equal(bind.kind, 'summon')
  assert.equal(bind.holdUntil, Number.POSITIVE_INFINITY, 'a summoned pet has no spell to outlive')
  assert.deepEqual(m.sweep(13_000 + 24 * 60 * 60_000), [], 'and a day later it is still bound')
  assert.equal(m.softHostile('gasarn'), undefined, 'a summoned pet cannot break')
  assert.equal(m.creditable('gasarn')?.charmer, 'Zeksara', 'so it keeps earning')
})

test('with NEITHER signal the safer default is the CHARM lifecycle', () => {
  // Rung 3, and the asymmetry is the owner's own: wrongly keeping the break rule loses some of a
  // pet's damage; wrongly dropping it can credit a re-hostile mob to a player, which is worse.
  const m = new AllyCharms()
  assert.equal(m.bindByLeader(leaderLine()).kind, 'charm')
  assert.ok(m.softHostile('kober'), 'so the break still fires')
})

test('the summon sighting must PRECEDE the say, and belongs to the owner who cast it', () => {
  // A cast after the say cannot explain a pet that is already talking…
  const late = new AllyCharms()
  late.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 20_000, allowed: true })
  assert.equal(late.bindByLeader(leaderLine({ owner: 'Zeksara', ownerKey: 'zeksara' })).kind, 'charm')

  // …and somebody ELSE's summon says nothing about this ally's pet: the signal is keyed by the
  // person, which is exactly why it is the weaker rung.
  const other = new AllyCharms()
  other.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 0, allowed: true })
  assert.equal(other.bindByLeader(leaderLine({ ts: 13_000 })).kind, 'charm', 'Gonekn summoned nothing')

  // The same two gates the rest of noteCast wears: a mob that "casts" is not a summoner.
  const mob = new AllyCharms()
  mob.noteCast({
    caster: 'A fire giant warrior', casterKey: 'a fire giant warrior', spell: CONJURATION, ts: 0, allowed: true
  })
  assert.equal(
    mob.bindByLeader(
      leaderLine({ owner: 'A fire giant warrior', ownerKey: 'a fire giant warrior', ts: 13_000 })
    ).kind,
    'charm'
  )
})

test('a charm broadcast over a live SUMMON bind puts the charm endings back', () => {
  // One direction only, and it is the safe one: the log has just said this name is a charmed mob,
  // so the break rule and the clock come back. Nothing can take them away again.
  const m = new AllyCharms()
  m.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 0, allowed: true })
  assert.equal(m.bindByLeader(leaderLine({ owner: 'Zeksara', ownerKey: 'zeksara', ts: 1_000 })).kind, 'summon')
  m.broadcast('kober', 'Kober', 2_000) // no arm is live: the verdict is 'none', the evidence is not
  const b = m.bindOf('kober')!
  assert.equal(b.kind, 'charm')
  assert.equal(b.holdUntil, 2_000 + WINDOW_MS)
  assert.ok(m.softHostile('kober'), 'and the break rule is back')
})

test('the summon sighting survives a zone, because the pet does', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 0, allowed: true })
  m.bindByLeader(leaderLine({ petKey: 'gasarn', pet: 'Gasarn', owner: 'Zeksara', ownerKey: 'zeksara', ts: 1_000 }))
  m.zone()
  assert.ok(m.idle, 'the BIND ends at the door — one of the three ends a summoned pet has')
  // …but the sighting does not, so the pet re-binds as a summon on the far side.
  assert.equal(
    m.bindByLeader(
      leaderLine({ petKey: 'gasarn', pet: 'Gasarn', owner: 'Zeksara', ownerKey: 'zeksara', ts: 99_000 })
    ).kind,
    'summon'
  )
  // A reset is a different character's session, and takes everything.
  m.reset()
  assert.equal(
    m.bindByLeader(
      leaderLine({ petKey: 'gasarn', pet: 'Gasarn', owner: 'Zeksara', ownerKey: 'zeksara', ts: 99_000 })
    ).kind,
    'charm'
  )
})

// ============================================================================
// RULING 2 — THE HOLD SLIDES ON EVIDENCE.
// ============================================================================

test('a charm pet that keeps fighting stays bound past THREE listed durations', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  const v = m.broadcast('an imp protector', 'an imp protector', 1_000)
  assert.equal(v.kind === 'bind' && v.bind.windowMs, WINDOW_MS, 'the window is the spell + slack')

  // One line a minute for fifty-one minutes — an AA-extended charm, which the DB cannot describe.
  for (let min = 1; min <= 51; min++) {
    const ts = 1_000 + min * 60_000
    m.noteActivity('an imp protector', ts)
    assert.deepEqual(m.sweep(ts), [], `still swinging at minute ${min}`)
  }
  assert.equal(m.creditable('an imp protector')?.charmer, 'Gordon', 'and still earning')
  // …and the moment it goes quiet the ordinary window starts running from its LAST line.
  const last = 1_000 + 51 * 60_000
  assert.deepEqual(m.sweep(last + WINDOW_MS - 1), [], 'one window of silence, not yet')
  assert.equal(m.sweep(last + WINDOW_MS).length, 1, 'and then reaped')
})

test('a SILENT bind is still reaped after one window — that is the clock\'s real job', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  assert.equal(m.broadcast('an imp protector', 'an imp protector', 1_000).kind, 'bind')
  assert.deepEqual(m.sweep(1_000 + WINDOW_MS - 1), [], 'inside its window')
  assert.equal(m.sweep(1_000 + WINDOW_MS).length, 1, 'and gone: this pet vanished')
  assert.ok(m.idle)
})

test('a slide never SHORTENS a hold, and a summon bind has none to shorten', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  const v = m.broadcast('an imp protector', 'an imp protector', 5_000)
  const held = v.kind === 'bind' ? v.bind.holdUntil : 0
  m.noteActivity('an imp protector', 1_000) // a line from before the bind cannot pull it in
  assert.equal(m.bindOf('an imp protector')?.holdUntil, held)

  m.noteCast({ caster: 'Zeksara', casterKey: 'zeksara', spell: CONJURATION, ts: 0, allowed: true })
  m.bindByLeader(leaderLine({ petKey: 'gasarn', pet: 'Gasarn', owner: 'Zeksara', ownerKey: 'zeksara', ts: 1_000 }))
  m.noteActivity('gasarn', 2_000)
  assert.equal(m.bindOf('gasarn')?.holdUntil, Number.POSITIVE_INFINITY, 'no clock, before or after')
})

test('AN AMBIGUOUS BIND STILL SLIDES — it books nothing, but it has not vanished', () => {
  // The twin is *why* the name is unreadable, so the name is demonstrably still acting. Reaping
  // it for silence would be false, and un-refusing it would be worse: both semantics hold at once.
  const m = new AllyCharms()
  m.noteCast({ caster: 'President', casterKey: 'president', spell: 'Cajoling Whispers V', ts: 0, allowed: true })
  m.broadcast('a rock golem', 'a rock golem', 1_000)
  assert.ok(m.markAmbiguous('a rock golem'))
  for (let min = 1; min <= 40; min++) m.noteActivity('a rock golem', 1_000 + min * 60_000)
  assert.deepEqual(m.sweep(1_000 + 40 * 60_000), [], 'not reaped — the name is still acting')
  assert.equal(m.creditable('a rock golem'), undefined, 'and STILL credits nothing')
  assert.equal(m.bindOf('a rock golem')?.ambiguous, true, 'ambiguity semantics are untouched')
})

test('the SOFT-HOSTILE PROOF outranks a slide made in the same second', () => {
  const m = new AllyCharms()
  m.noteCast({ caster: 'Gordon', casterKey: 'gordon', spell: CAJOLING, ts: 0, allowed: true })
  m.broadcast('an imp protector', 'an imp protector', 1_000)
  m.noteActivity('an imp protector', 500_000)
  assert.ok(m.bindOf('an imp protector')!.holdUntil > 500_000, 'freshly slid')
  assert.equal(m.softHostile('an imp protector')?.charmer, 'Gordon', 'and broken anyway')
  assert.ok(m.idle, 'the break is a terminator, not a clock')
})

// ============================================================================
// THE SAME TWO PATHS, THROUGH THE REAL PARSER AND THE REAL ENGINE.
//
// A REPORTER'S SLICE NEVER BECOMES A FIXTURE (AGENTS.md, `.gitignore .triage/`), and this defect
// exists only in someone else's log — so the window below is HAND-ASSEMBLED from the line SHAPES
// report 01KZVYMCAD72XFC36D73D8J2E8 prints, cited here, never copied wholesale. Every sentence in
// it is one the slice actually contains:
//
//   `You begin casting Beguile IV.` / `a wan ghoul knight has been charmed.`   17:18:19, 17:18:21
//        — the REPORTER's own charm pet, and the source of the whole defect: the zone's mob
//          population shares that name.
//   `Zeksara begins casting Minor Conjuration: Fire.`                          17:19:18
//        — the group-mate's summon, twelve seconds before her pet's first line.
//   `Gasarn says, 'My leader is Zeksara.'`                                     INJECTED
//        — the one sentence the slice does NOT contain (a bystander cannot make somebody else's
//          pet speak) and the one the fix is about. Same precedent as petClaimWindows and
//          mobLifetapPlayer: the missing line is injected, and said so.
//   `Gasarn hit a wan ghoul knight for 39 points of magic damage by Tishan's Clash.`  17:33:20
//        — the collision, in shape: the exact line that killed the bind on main.
//
// THE FULL-SLICE REPLAY IS THE TICKET'S: 9,166 lines with the say injected book all 11,905 of
// Gasarn's damage to `Pet (Gasarn) - Zeksara` with no mid-fight unbind (8,496 before this
// change), and the zone total reaches the true 85,485. What is pinned here is the mechanism, on
// a window this repo may commit.
// ============================================================================

const t = (clock: string, line: string): string => `[Wed Aug 12 ${clock} 2026] ${line}`

/** The reporter's own charm pet, whose NAME the zone's mobs also carry. */
const OWN_CHARM = [
  t('17:16:00', 'You have entered The Ruins of Old Guk.'),
  t('17:18:19', 'You begin casting Beguile IV.'),
  t('17:18:21', 'a wan ghoul knight has been charmed.')
]

const SUMMON_WINDOW = [
  ...OWN_CHARM,
  t('17:19:18', 'Zeksara begins casting Minor Conjuration: Fire.'),
  t('17:19:31', "Gasarn says, 'My leader is Zeksara.'"),
  t('17:20:00', 'Gasarn slashes a shin ghoul knight for 100 points of damage.'),
  t('17:30:00', "Gasarn hit a wan ghoul knight for 39 points of magic damage by Tishan's Clash."),
  t('17:40:00', 'Gasarn slashes a shin ghoul knight for 200 points of damage.')
]

test('JOS-270 ACCEPTANCE: the ally SUMMONED pet books every point, with no mid-fight unbind', () => {
  const { eng, lastTs } = replay(SUMMON_WINDOW, undefined, ['Zeksara'])
  const rows = allyRows(eng, lastTs)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'allypet:zeksara:gasarn')
  assert.equal(rows[0].name, 'Pet (Gasarn) - Zeksara')
  // ALL THREE LINES: the collision that broke the bind on main, and the one twenty minutes past
  // the charm clock that would have been swept.
  assert.equal(rows[0].total, 339)
  assert.equal(rows[0].hits, 3)
  assert.deepEqual(eng.allyPetNames(), ['Gasarn'], 'still bound at the end of the window')
  // …and it says which lifecycle it chose, because a lifecycle nobody can see is one nobody can
  // report a bug about.
  const lines = eng.snapshot(lastTs + 120_000, {}).recent.filter((l) => l.cat === 'charm')
  assert.ok(lines.some((l) => /Gasarn named Zeksara its leader \(summoned pet\)/.test(l.text)))
  assert.equal(lines.filter((l) => /charm broke/.test(l.text)).length, 0, 'nothing broke')
  assert.equal(zone(eng, lastTs).outTotal, 339, 'the ally pet is the only thing fighting')
  // AND THE COLLISION WAS REAL. At 17:30:00 `a wan ghoul knight` IS your charm pet, so
  // `allyFriendly` said yes and the soft-hostile rule is exactly what fired on main. It is the
  // lifecycle that declines to act on it, not a friendly set that changed.
  const at = replay(SUMMON_WINDOW, Date.parse('Wed Aug 12 17:30:00 2026'), ['Zeksara'])
  assert.deepEqual(at.eng.petDisplayNames(), ['a wan ghoul knight'], 'your own pet, at that instant')
  assert.deepEqual(at.eng.allyPetNames(), ['Gasarn'], 'and the ally pet survived the same second')
  assert.equal(allyRows(at.eng, at.lastTs)[0].total, 139, 'the collision line is credited too')
})

test('JOS-270: the same window with a CHARM pet keeps the break rule', () => {
  // THE DISCERNMENT, stated as a pair with the test above: the only difference between the two
  // windows is what Zeksara CAST and whether the zone ever heard her pet's name in a broadcast.
  // `via` is `'leader'` in both — which is exactly why it cannot be the discriminant.
  const CHARM_WINDOW = [
    ...OWN_CHARM,
    t('17:19:18', 'Zeksara begins casting Beguile IV.'),
    t('17:19:20', 'a shin ghoul knight has been charmed.'),
    t('17:19:31', "a shin ghoul knight says, 'My leader is Zeksara.'"),
    t('17:20:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.'),
    // the same collision shape — and for a CHARMED mob this is the soft-hostile proof, unchanged
    t('17:30:00', 'A shin ghoul knight hits a wan ghoul knight for 39 points of damage.'),
    t('17:40:00', 'A shin ghoul knight slashes a froglok tad for 200 points of damage.')
  ]
  const { eng, lastTs } = replay(CHARM_WINDOW, undefined, ['Zeksara'])
  const rows = allyRows(eng, lastTs)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'allypet:zeksara:a shin ghoul knight')
  assert.equal(rows[0].total, 100, 'the break stops the credit, and nothing is retro-uncredited')
  assert.deepEqual(eng.allyPetNames(), [], 'the charm broke and stayed broken')
  const lines = eng.snapshot(lastTs + 120_000, {}).recent.filter((l) => l.cat === 'charm')
  assert.ok(lines.some((l) => /its leader \(charmed\)/.test(l.text)), 'the evidence called it charmed')
  assert.ok(lines.some((l) => /charm broke/.test(l.text)), 'and the soft-hostile proof still fires')
})

test('JOS-270: an ally CHARM pet that keeps fighting keeps its row, through the real engine', () => {
  // The sliding hold, wired end to end. Beguile IV is listed at 16 minutes (+1 slack), and this
  // window runs 55 — an AA- or focus-extended charm, which the spell DB has no way to describe.
  const LONG = [
    t('17:16:00', 'You have entered The Ruins of Old Guk.'),
    t('17:19:18', 'Zeksara begins casting Beguile IV.'),
    t('17:19:20', 'a shin ghoul knight has been charmed.'),
    t('17:29:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.'),
    t('17:39:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.'),
    t('17:49:00', 'A shin ghoul knight tries to slash a froglok tad, but misses!'),
    t('17:59:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.'),
    t('18:09:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.'),
    t('18:14:00', 'A shin ghoul knight slashes a froglok tad for 100 points of damage.')
  ]
  const { eng, lastTs } = replay(LONG, undefined, ['Zeksara'])
  assert.deepEqual(eng.allyPetNames(), ['a shin ghoul knight'], 'bound 55 minutes in')
  const rows = allyRows(eng, lastTs)
  assert.equal(rows[0].total, 500, 'every line booked, including the four past the listed duration')
  assert.equal(rows[0].misses, 1, 'and a MISS slides the hold too — it is an appearance')

  // Now let it go quiet: one window after its last line the reaper takes it, as it always did.
  const quiet = eng.snapshot(Date.parse('Wed Aug 12 18:14:00 2026') + WINDOW_MS + 1, {})
  assert.deepEqual(eng.allyPetNames(), [], 'a pet that stopped appearing is gone')
  assert.ok(
    quiet.recent.some((l) => l.cat === 'charm' && /has run its full duration/.test(l.text)),
    'and the reaping is said out loud'
  )
})
