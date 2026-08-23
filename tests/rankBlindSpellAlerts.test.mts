// JOS-259 — A SPELL ALERT FIRES FOR EVERY RANK OF THE SPELL.
//
// THE REPORT (feedback 01KZV6X5MVY3904VVBKQMATEMV, 0.23.0). A wizard's "resisted" alert for
// Elemental Maelstrom stopped firing. Nothing about the alert changed; what changed is that they
// unlocked rank II. Their FADE alert for the same spell kept working the whole time, which is the
// detail that names the mechanism:
//
//   [22:31:05] You begin casting Elemental Maelstrom II.                          ← ranked
//   [22:31:07] Cleric of Innoruuk resisted your Elemental Maelstrom II!           ← ranked
//   [22:45:__] Your Elemental Maelstrom spell has worn off of Cleric of Innoruuk. ← NOT ranked
//
// EQ Legends re-tiers the classic spells as roman-numeral ranks of one base name, and only SOME
// of the lines a spell prints carry the suffix (log/parseCombat.ts keeps the display form on
// `resist`; `castBegin` keeps it too; the wear-off family prints the bare name). A literal
// `where.spell` matcher compiled to whole-string equality (modules/alerts.ts `compileFieldMatch`),
// so one def could satisfy one half of its own spell's lines and never the other. The wizard's
// rank chip had pinned the unsuffixed name — the rank this character was casting when they clicked
// it — and the day the log started printing "II" the alert went silent with no error and no offer.
//
// THE OWNER'S RULING (2026-08-12): rank-blind matching, full stop. A spell alert just works with
// ALL ranks of the spell, and no upgrade offer is needed to keep an alert firing. The domain law
// behind it, verbatim: once you upgrade a spell it never downgrades, even on a loadout swap.
//
// THE FIX UNDER TEST: a LITERAL `where.spell` spec compiles with `spellLineKey(spec)` beside it,
// and `accepts` compares the rank-folded keys when the exact compare misses. It is a pure
// widening — a def pinned to a rank still fires on that rank — and it touches neither `/regex/`
// specs (a user-authored pattern is intent, not a spelling) nor any other `where` key.
//
// THE LINES ARE QUOTED, NEVER COMMITTED. The reporter's slice is a user's own game log; `.gitignore`
// says those bytes are read locally and never enter git. What is reproduced below is the handful of
// individual client notices this defect lives on — the same treatment tests/suggestedAlertsFire.mts
// gives JOS-84's reporter — with mob names left as the log spelled them, because they are mobs. No
// window, no state, no session.
//
// THE DEFS ARE NOT HAND-WRITTEN where the wizard authors them: the reporter's resisted alert comes
// out of the REAL path (buildSpellCatalog(loadSpellDb()) → suggestionsFor(entry, rank)) and into
// the REAL AlertsModule through the REAL parser.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { meleeSkill } from '../src/main/log/parseCombat'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import { ALERT_GROUPS, alertGroupDefs } from '../src/shared/alertGroups'
import {
  suggestionCoverageId,
  suggestionsFor
} from '../src/renderer/src/features/alerts/suggestions'
import type { AlertGroup } from '../src/shared/alertGroups'
import type { SpellRank } from '../src/shared/spellLines'
import type { AlertDef, FiredAlert, SpellCatalogEntry } from '../src/shared/types'

// Installed exactly as main installs it — the shared-sentence families below resolve against it,
// and the reporter's own def is built from the catalog it feeds. Node runs each test FILE in its
// own process, so this global injection cannot reach a sibling suite.
const db = loadSpellDb()
installSpellDb(db)
const catalog = buildSpellCatalog(db, new Map())

/** The reporter's own lines, verbatim from slice 01KZV6X5MVY3904VVBKQMATEMV. */
const SLICE = {
  cast: '[Tue Aug 11 22:31:05 2026] You begin casting Elemental Maelstrom II.',
  resistCleric: '[Tue Aug 11 22:31:07 2026] Cleric of Innoruuk resisted your Elemental Maelstrom II!',
  resistBanshee: '[Tue Aug 11 22:34:15 2026] A scorn banshee resisted your Elemental Maelstrom II!',
  fadeCleric:
    '[Tue Aug 11 22:39:12 2026] Your Elemental Maelstrom spell has worn off of Cleric of Innoruuk.'
}

function entryFor(key: string): SpellCatalogEntry {
  const e = catalog.entries.find((x) => x.key === key)
  assert.ok(e, `spells.json must carry a catalog entry for "${key}"`)
  return e
}

/**
 * The rank the wizard pins its chips to, shaped as the alerts snapshot supplies it.
 *
 * `suffixed:false, rank:1` IS THE REPORTER'S CASE and is not a simplification: a rank chip is
 * offered only for a rank actually seen cast, so before the unlock the only name their log had
 * ever printed was the bare "Elemental Maelstrom".
 */
function rank(name: string, ordinal = 1): SpellRank {
  return {
    name,
    rank: ordinal,
    suffixed: ordinal > 1,
    lastCastMs: Date.parse('2026-08-11T22:20:00Z')
  }
}

/** Feed raw log lines through the real parser into a module holding `defs`; return the fires. */
function fire(defs: AlertDef[], lines: string[]): FiredAlert[] {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return mod.flushDelta()?.delta.fired ?? []
}

/** A hand-written def — the shape the alert editor stores. `cooldownMs:0` so nothing is swallowed. */
function def(id: string, kind: string, where: Record<string, string>): AlertDef {
  return {
    id,
    name: id,
    enabled: true,
    trigger: { type: 'event', kind, where } as AlertDef['trigger'],
    sound: { packId: 'alan-rickman', soundId: 'task-error-task-error-01' },
    cooldownMs: 0
  }
}

/** One curated group by id, so a rename fails loudly here rather than skipping a check. */
function groupById(id: string): AlertGroup {
  const g = ALERT_GROUPS.find((x) => x.id === id)
  assert.ok(g, `alertGroups.ts must still carry the "${id}" group`)
  return g
}

// ── THE ACCEPTANCE FIXTURE ────────────────────────────────────────────────────────────────────

test('JOS-259 A1: the reporter\'s resisted alert fires on their rank-II resist lines', () => {
  const suggestion = suggestionsFor(entryFor('elemental maelstrom'), rank('Elemental Maelstrom'))
    .find((s) => s.template === 'resistRank')
  assert.ok(suggestion, 'the wizard must still offer a resisted chip for a detrimental spell')
  const resisted = suggestion.def
  // The def is UNCHANGED by this fix — pinned to the name the wizard had, as authored. `caster`
  // is what keeps a bystander's resist of the same spell out of your ears (Task #51).
  assert.deepEqual(resisted.trigger, {
    type: 'event',
    kind: 'resist',
    where: { caster: 'you', spell: 'Elemental Maelstrom' }
  })

  const fired = fire([resisted], [SLICE.resistCleric, SLICE.resistBanshee])
  assert.equal(fired.length, 2, 'both rank-II resists must fire the base-name def')
  assert.deepEqual(fired.map((f) => f.matchedText), [SLICE.resistCleric, SLICE.resistBanshee])
  // It SAYS what the log said. The def's spelling is the alert's business; the rank is the log's.
  assert.deepEqual(fired.map((f) => f.spell), ['Elemental Maelstrom II', 'Elemental Maelstrom II'])
})

test('JOS-259 A2: the fade path keeps working — same def, rank-less line', () => {
  // The `fade` template's exact trigger shape (suggestions.ts SUGGEST_TEMPLATES.fade), pinned to
  // the same base name. This is the half that never broke, and the half a widening could break.
  const fade = def('fade', 'buffFade', { spell: 'Elemental Maelstrom' })
  const fired = fire([fade], [SLICE.fadeCleric])
  assert.equal(fired.length, 1, 'the rank-less wear-off must still fire')
  assert.equal(fired[0].spell, 'Elemental Maelstrom')

  // And ONE def now owns both halves of the spell's own vocabulary — the whole ticket in one line.
  const both = fire(
    [def('resisted', 'resist', { caster: 'you', spell: 'Elemental Maelstrom' }), fade],
    [SLICE.cast, SLICE.resistCleric, SLICE.fadeCleric]
  )
  assert.deepEqual(both.map((f) => f.alertId), ['resisted', 'fade'])
})

test('JOS-259 A3: the evidence — one spell, two spellings, straight off the parser', () => {
  const resist = parseEvent(SLICE.resistCleric, 0)
  assert.equal(resist?.kind, 'resist')
  if (resist?.kind !== 'resist') return
  assert.equal(resist.spell, 'Elemental Maelstrom II', 'a resist line KEEPS the rank')
  assert.equal(resist.caster, 'you')
  assert.equal(resist.target, 'Cleric of Innoruuk')

  const cast = parseEvent(SLICE.cast, 1)
  assert.equal(cast?.kind === 'castBegin' && cast.spell, 'Elemental Maelstrom II')

  const fade = parseEvent(SLICE.fadeCleric, 2)
  assert.equal(fade?.kind, 'buffFade')
  if (fade?.kind !== 'buffFade') return
  assert.equal(fade.spell, 'Elemental Maelstrom', 'the wear-off line NEVER carries the rank')
})

// ── WHAT FOLDS, AND WHAT STAYS EXACT ──────────────────────────────────────────────────────────

test('JOS-259 B1: a rank-pinned def keeps firing on its rank, and now on the others', () => {
  const pinned = def('pinned', 'resist', { caster: 'you', spell: 'Elemental Maelstrom II' })
  // The narrower def still answers the line it was built from — the widening subsumes the old
  // equality, it does not replace it with something else.
  assert.equal(fire([pinned], [SLICE.resistCleric]).length, 1)
  // …and it no longer goes stale in either direction. Rank III is the level-up the reporter hit;
  // rank I is the loadout swap the owner's domain law says never happens, tested anyway because a
  // fold that only worked upwards would be a second rule to remember.
  const lines = [
    '[Tue Aug 11 22:40:00 2026] A scorn banshee resisted your Elemental Maelstrom III!',
    '[Tue Aug 11 22:41:00 2026] A scorn banshee resisted your Elemental Maelstrom!'
  ]
  assert.equal(fire([pinned], lines).length, 2, 'rank-blind means every rank, not just upwards')
})

test('JOS-259 B2: a /regex/ spec is user intent and is left exactly alone', () => {
  const narrow = def('narrow', 'resist', { caster: 'you', spell: '/^Elemental Maelstrom II$/' })
  const loose = def('loose', 'resist', { caster: 'you', spell: '/maelstrom/' })
  const three = '[Tue Aug 11 22:40:00 2026] A scorn banshee resisted your Elemental Maelstrom III!'

  assert.deepEqual(fire([narrow, loose], [SLICE.resistCleric]).map((f) => f.alertId), [
    'narrow',
    'loose'
  ])
  assert.deepEqual(
    fire([narrow, loose], [three]).map((f) => f.alertId),
    ['loose'],
    'someone who anchored their pattern to a rank asked a narrower question on purpose'
  )
})

test('JOS-259 B3: only the spell key folds — the other where entries still gate', () => {
  const mine = def('mine', 'resist', { caster: 'you', spell: 'Elemental Maelstrom' })
  // The same spell, resisted off somebody else's cast. `caster` is not a spell name and does not
  // fold; the def is still yours-only.
  const theirs = "[Tue Aug 11 22:42:00 2026] A scorn banshee resisted Nightbane's Elemental Maelstrom II!"
  const ev = parseEvent(theirs, 0)
  assert.equal(ev?.kind === 'resist' && ev.caster, 'Nightbane')
  assert.equal(fire([mine], [theirs]).length, 0, 'a bystander\'s resist is still not your alert')

  // A spec that is NOTHING BUT a rank folds to the empty string, and an empty key would accept
  // every spell in the game. It stays a literal instead.
  const romanOnly = def('roman', 'castBegin', { spell: 'II' })
  assert.equal(fire([romanOnly], [SLICE.cast]).length, 0, 'the fold must never become a wildcard')
})

// ── CONSISTENCY ACROSS EVERY KIND THAT NAMES A SPELL ──────────────────────────────────────────

test('JOS-259 C1: every spell-naming kind answers to one def, ranked line or not', () => {
  // The mirror image of the reporter's case, and the reason this has to be one rule rather than a
  // resist patch: the CAST line is the ranked one and the BREAK line is bare, so a def pinned to
  // the rank the wizard saw you cast could never hear its own hold end.
  const mez = def('mez', 'cc', { spell: 'Mesmerization III', refresh: 'true' })
  const charm = def('charm', 'uncharm', { spell: 'Allure VI' })
  const cast = def('cast', 'castBegin', { spell: 'Mesmerization' })
  const lines = [
    '[Tue Aug 11 22:50:00 2026] You begin casting Mesmerization IV.',
    '[Tue Aug 11 22:50:30 2026] Your Mesmerization spell has worn off of a froglok ton knight.',
    '[Tue Aug 11 22:50:40 2026] Your Allure spell has worn off of a froglok ton knight.'
  ]
  assert.deepEqual(fire([mez, charm, cast], lines).map((f) => f.alertId), ['cast', 'mez', 'charm'])
})

test('JOS-259 C2: the candidate list folds too, and the fire says the name it matched', () => {
  // A shared-message family (JOS-84): the sentence names no spell, `spell` is a best-effort
  // alphabetical pick and `candidates` carries the truth — all of them rank-less DB names. A def
  // pinned to a RANK of one of them must still be admitted through that list, or the two widenings
  // would each work only where the other was not needed.
  const slow = def('slow', 'buffApply', { spell: 'Shiftless Deeds V' })
  const landed = '[Tue Aug 11 22:55:00 2026] a froglok ton knight slows down.'
  const ev = parseEvent(landed, 0)
  assert.equal(ev?.kind, 'buffApply')
  if (ev?.kind !== 'buffApply') return
  assert.notEqual(ev.spell, 'Shiftless Deeds', 'the best-effort pick is not the user\'s spell')
  assert.ok(ev.candidates?.some((c) => c.name === 'Shiftless Deeds'))

  const fired = fire([slow], [landed])
  assert.equal(fired.length, 1, 'a rank-pinned def must still reach the candidate list')
  assert.equal(
    fired[0].spell,
    'Shiftless Deeds',
    'the fire names the candidate that satisfied the matcher, not the alphabetical pick'
  )
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// JOS-276 — AND THE DAMAGE LANE FOLDS TOO.
//
// THE OWNER'S LAW, verbatim (2026-08-13): "we should not use spell ranks for anything in the alert
// system - it should be compatible with any rank." JOS-259 above folded every `where.spell`
// matcher and left ONE lane out on purpose — `damage.skill`, which is a spell name for dtype
// 'spell'/'dot' and a melee verb or a damage-shield element otherwise. That carve-out is now gone:
// `foldsRank` (modules/alerts.ts) admits `damage.skill` at compile time and `foldReaches` gates it
// per event on the dtype, so the two spell dtypes fold and the other two are untouched.
//
// THE LINES BELOW ARE THE OWNER'S OWN LOG, verbatim from eqlog_Primitive_freeport.txt (read-only
// sweep, 2026-08-13, 1,627,039 lines) — not constructed, because the whole question is which
// spellings the game ACTUALLY prints in this lane. What the sweep found:
//   * `… points of <class> damage by Harm Touch.`               488 lines — the rank-LESS nuke.
//   * `… points of <class> damage by Harm Touch III|IV|VI|IX.`   23 lines — the SAME spell, ranked.
//   * `… has taken N damage from Harm Touch IX by <sk>.`          3 lines — ranked, dot lane.
//   * `… has taken N damage from Chords of Dissonance[ I|III|IV|V] by <bard>.` — one bard song,
//     five spellings, four casters, all in the dot lane.
// One spell printing two spellings in one lane is the whole defect, restated in the lane JOS-259
// could not reach: a damage alert on `Harm Touch` heard 488 of 511 of its own lines.
//
// AND THE OTHER TWO DTYPES ARE INERT, MEASURED (D3): melee `skill` is not a log string at all but
// one of ten constants out of `meleeSkill`, and the whole log spells exactly three damage-shield
// elements — flames (17,780), thorns (7,861), frost (152). None can carry a roman-numeral tail.
// The gate is still written on the dtype rather than on that measurement, because the DS element
// IS free text off the line and nothing in the parser bounds it.

/** Verbatim damage-lane lines from eqlog_Primitive_freeport.txt. */
const DMG = {
  /** dtype 'spell', RANK-LESS — a shadowknight's Harm Touch, 488 such lines. */
  htPlain: '[Sun Jul 19 08:39:33 2026] Giber hit a hardened skeleton for 162 points of magic damage by Harm Touch.',
  /** dtype 'spell', RANKED — the same spell, a caster who has the rank. */
  htRanked:
    '[Fri Jul 31 21:08:07 2026] Zobek hit a stone spider for 881 points of unresistable damage by Harm Touch IX.',
  /** dtype 'dot', RANKED — the tick two seconds later, same spell, same fight. */
  htTick: '[Fri Jul 31 21:08:09 2026] A stone spider has taken 397 damage from Harm Touch IX by Zobek.',
  /**
   * dtype 'dot', RANK-LESS, and the four ranked spellings of the same bard song — the first
   * occurrence of each, so they are in the order the log printed them. THE ORDER IS LOAD-BEARING:
   * `cooldownMs:0` means "no window", not "no clock", and an event whose ts is BEFORE the last
   * fire is inside every window (`onCooldown` compares `ts - last < cd`). Feeding a fixture out of
   * chronological order silently swallows fires, which is a property of the module and not of
   * this ticket — the log never goes backwards.
   */
  chordsPlain:
    '[Sun Jul 19 15:30:38 2026] A Teir`Dal ranger has taken 18 damage from Chords of Dissonance by Testone.',
  chordsIV:
    '[Tue Jul 28 21:28:14 2026] A fungus drone has taken 11 damage from Chords of Dissonance IV by Wemby.',
  chordsV: '[Wed Jul 29 00:46:26 2026] A greater ice bones has taken 17 damage from Chords of Dissonance V by Sanluen.',
  chordsI: '[Wed Jul 29 13:49:49 2026] A zol ghoul knight has taken 26 damage from Chords of Dissonance I by Xaladin.',
  chordsIII:
    '[Sat Aug 01 18:40:19 2026] An ice goblin veteran has taken 43 damage from Chords of Dissonance III by Voxl.',
  /** dtype 'melee' — `skill` here is `meleeSkill('kick')`, a table constant. */
  kick: '[Sun Jul 19 10:02:40 2026] You kick a Teir`Dal shadowknight for 3 points of damage.',
  /** dtype 'ds' — `skill` is the element the line spelled. */
  flames: '[Sun Jul 19 20:08:25 2026] A magician pet is burned by YOUR flames for 5 points of non-melee damage.',
  thorns: '[Thu Aug 06 19:23:21 2026] A sturdy skeleton is pierced by YOUR thorns for 5 points of non-melee damage.',
  /** Not a damage line — the skill-up stream, which spells `skill` on a DIFFERENT kind. */
  kickUp: '[Tue Jul 28 15:34:13 2026] You have become better at Kick! (100)'
}

test('JOS-276 D1: a damage alert on the base name fires on BOTH line shapes', () => {
  // THE ACCEPTANCE. One def, the base name, no rank anywhere in it.
  const ht = def('harm-touch', 'damage', { skill: 'Harm Touch' })
  const fired = fire([ht], [DMG.htPlain, DMG.htRanked, DMG.htTick])
  assert.deepEqual(
    fired.map((f) => f.matchedText),
    [DMG.htPlain, DMG.htRanked, DMG.htTick],
    'the rank-less direct hit, the ranked direct hit and the ranked dot tick are one alert'
  )
  // And it SAYS what the log said, rank intact — the same rule `matchedSpellName` follows for the
  // spell key: the def's spelling is the alert's business, the rank is the log's.
  assert.deepEqual(fired.map((f) => f.spell), ['Harm Touch', 'Harm Touch IX', 'Harm Touch IX'])
})

test('JOS-276 D2: one dot-lane def owns every rank the song is cast at', () => {
  const lines = [DMG.chordsPlain, DMG.chordsIV, DMG.chordsV, DMG.chordsI, DMG.chordsIII]
  // Five spellings off four different bards. Pinned to the base name…
  assert.equal(fire([def('chords', 'damage', { skill: 'Chords of Dissonance' })], lines).length, 5)
  // …and pinned to a RANK, which is the direction that used to work and must keep working: a def
  // built from the one rank you happened to see is not an alert about that rank alone.
  assert.equal(fire([def('chords', 'damage', { skill: 'Chords of Dissonance IV' })], lines).length, 5)
})

test('JOS-276 D3: melee and damage-shield lanes are untouched — the measurement, pinned', () => {
  // The melee lane's `skill` is a TABLE CONSTANT (parseCombat.ts `meleeSkill`), never log text,
  // and the DS lane's three elements are nouns. Neither can carry a rank tail, so the fold has
  // nothing to widen — assert it over what the parser actually produced.
  const rankTail = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/i
  for (const verb of ['backstab', 'bash', 'kick', 'cleave', 'smite', 'shoot', 'strike', 'frenzy', 'flurry', 'slash']) {
    assert.ok(!rankTail.test(meleeSkill(verb)), `meleeSkill('${verb}') must carry no rank tail`)
  }
  for (const line of [DMG.kick, DMG.flames, DMG.thorns]) {
    const ev = parseEvent(line, 0)
    assert.equal(ev?.kind, 'damage')
    if (ev?.kind !== 'damage') return
    assert.ok(!rankTail.test(ev.skill), `${ev.dtype} skill "${ev.skill}" must carry no rank tail`)
  }
  // A def written against those lanes still matches exactly what it always matched…
  assert.equal(fire([def('kick', 'damage', { skill: 'Kick' })], [DMG.kick]).length, 1)
  assert.equal(fire([def('ds', 'damage', { skill: 'flames' })], [DMG.flames, DMG.thorns]).length, 1)
  // …and the fold does NOT reach them: a rank-suffixed spec folds to `kick`/`flames`, which under
  // an ungated widening would have matched. `foldReaches` is what refuses, on the dtype.
  assert.equal(fire([def('kick2', 'damage', { skill: 'Kick II' })], [DMG.kick]).length, 0)
  assert.equal(fire([def('ds2', 'damage', { skill: 'flames II' })], [DMG.flames]).length, 0)
})

test('JOS-276 D4: `skill` on a non-damage kind does not fold', () => {
  // The skill-up stream spells `skill` too. The fold is scoped to (`damage`, `skill`) at COMPILE
  // time (`foldsRank` reads the trigger's kind), so this def compiles with no line key at all.
  assert.equal(fire([def('up', 'skillUp', { skill: 'Kick' })], [DMG.kickUp]).length, 1)
  assert.equal(fire([def('up2', 'skillUp', { skill: 'Kick II' })], [DMG.kickUp]).length, 0)
})

test('JOS-276 D5: a /regex/ skill spec is still user intent', () => {
  // The same refusal B2 makes for the spell key. Someone who anchored a damage pattern to a rank
  // asked a narrower question, and this file is not in the business of rewriting it.
  const narrow = def('narrow', 'damage', { skill: '/^Harm Touch IX$/' })
  assert.equal(fire([narrow], [DMG.htRanked]).length, 1)
  assert.equal(fire([narrow], [DMG.htPlain]).length, 0)
  // And a skill spec that is nothing but a roman numeral must not become a wildcard.
  assert.equal(fire([def('roman', 'damage', { skill: 'IX' })], [DMG.htRanked, DMG.kick]).length, 0)
})

test('JOS-276 D6: the curated slow rosters tolerate a rank the log can print', () => {
  // THE SWEEP'S OTHER FINDING. The two slow group defs are APP-authored `/^(…)$/` rosters, so
  // JOS-259's "regexes are user intent" exemption does not cover them — the `$` anchor is ours,
  // and it made those defs rank-sensitive. `Your <X> spell has worn off of <mob>.` is rank-less in
  // 3,382 of 3,383 whole-log occurrences; the 3,383rd is this real line, which proves the shape:
  const rankedWearOff = '[Wed Aug 05 17:18:06 2026] Your Rune IV spell has worn off of a gust of wind.'
  const fade = parseEvent(rankedWearOff, 0)
  assert.equal(fade?.kind === 'buffFade' && fade.spell, 'Rune IV', 'a wear-off CAN carry a rank')

  const mob = alertGroupDefs(groupById('slow')).map((d) => ({ ...d, cooldownMs: 0 }))
  const lines = [
    // The rank-less line the group was verified on (alertGroups.test.mts G1) — unchanged.
    '[Tue Jul 28 13:04:53 2026] Your Shiftless Deeds spell has worn off of King Tranix.',
    // …and the same slow, printed the way Rune IV was.
    '[Tue Jul 28 13:05:53 2026] Your Shiftless Deeds IV spell has worn off of King Tranix.'
  ]
  assert.deepEqual(
    fire(mob, lines).map((f) => f.alertId),
    ['group:slow:mob', 'group:slow:mob'],
    'a ranked slow wear-off must not fall through the roster'
  )
})

test('JOS-276 D7: the wizard dedupes rank chips by LINE, not by rank', () => {
  // Since JOS-259 a def pinned to `Mesmerization III` fires on every Mesmerization cast line, so
  // the "Mesmerization IV casts" chip beside it is offering a second alert on the same lines.
  // `suggestionCoverageId` is the fold that makes the chip read as already created.
  const iii = 'suggest:mesmerization:castRank:mesmerization-iii'
  const iv = 'suggest:mesmerization:castRank:mesmerization-iv'
  assert.equal(suggestionCoverageId(iii), suggestionCoverageId(iv))
  // The add-alongside clone (`detectRankUpgrades`) folds to the same key.
  assert.equal(suggestionCoverageId(`${iii}::rank:mesmerization-iv`), suggestionCoverageId(iii))
  // The two rank templates are separate alerts about separate lines and must NOT collapse…
  assert.notEqual(
    suggestionCoverageId(iv),
    suggestionCoverageId('suggest:mesmerization:resistRank:mesmerization-iv')
  )
  // …neither do two different spell lines…
  assert.notEqual(suggestionCoverageId(iv), suggestionCoverageId('suggest:allure:castRank:allure-vi'))
  // …and every other suggestion id is returned byte-identical.
  for (const id of ['suggest:mesmerization:fade', 'suggest:illusion:fade', 'group:slow:mob', 'alert:poison-slow-landed']) {
    assert.equal(suggestionCoverageId(id), id)
  }
})

// ── JOS-318 — THE SAME LAW, ON THE SECOND REPORTER'S LINES ────────────────────────────────────
//
// Report 01KZZXVW888E09C088QBRD5HCD (v0.27.0, a shaman): "Slugs healing audio trigger not working.
// Tortoise Healing works, but even when manually changing the spell name regex to Slugs, the audio
// trigger doesn't go off." The owner's 2026-08-14 ruling asked for two things — that alerts be
// immune to spell upgrade ranks, and that temporary/HoT spells work end to end — so the rank half
// is pinned HERE, beside the law it belongs to, and the HoT half in tests/suggestedAlertsFire.
//
// THE RANK WAS NOT THE CAUSE, and that is worth a test rather than a sentence: the reporter's cast
// line carries `VII` while every other line of the same spell carries the bare name, which is
// exactly the JOS-259 shape, and the fold above already handled it. What was actually broken was
// the DB — the scrape stubs `You .` / `Someone .`, corrected in spellCorrectionsList.ts — so these
// assertions are the ones that would have shown a diagnosis of "it must be the rank" to be wrong.
//
// The lines are quoted from the reporter's slice, never committed, per the rule at the top.

const SLUGS = {
  cast: '[Fri Aug 14 03:12:15 2026] You begin casting Slugs Healing VII.',
  landed: '[Fri Aug 14 03:12:16 2026] You being to feel healed by the slug.',
  wore: '[Fri Aug 14 03:12:19 2026] You feel the slug spirit depart.',
  tick: '[Fri Aug 14 03:14:25 2026] You healed Ahyeon over time for 247 hit points by Slugs Healing.',
  otherCast: '[Fri Aug 14 03:31:17 2026] Tekno begins casting Slugs Healing VII.'
}

test('JOS-318 E1: ONE unranked def answers every line the reporter`s spell prints', () => {
  // Four kinds, two spellings of the same spell, one trigger each pinned to the BARE name — which
  // is what the wizard authors and what a user types. The cast line is the only one carrying `VII`,
  // and it is the one the rank fold is for.
  const fired = fire(
    [
      def('slugs:cast', 'castBegin', { spell: 'Slugs Healing' }),
      def('slugs:landed', 'buffApply', { spell: 'Slugs Healing' }),
      def('slugs:wore', 'buffWearOff', { spell: 'Slugs Healing' }),
      def('slugs:tick', 'heal', { spell: 'Slugs Healing' })
    ],
    [SLUGS.cast, SLUGS.landed, SLUGS.wore, SLUGS.tick]
  )
  assert.deepEqual(
    fired.map((f) => f.alertId),
    ['slugs:cast', 'slugs:landed', 'slugs:wore', 'slugs:tick']
  )
  // …and the fire REPORTS the display name the line carried, rank intact where there was one.
  assert.deepEqual(fired.map((f) => f.spell), [
    'Slugs Healing VII',
    'Slugs Healing',
    'Slugs Healing',
    'Slugs Healing'
  ])
})

test('JOS-318 E2: and a def pinned to the RANK answers the rank-less lines too', () => {
  // The other direction, which is the widening JOS-259 shipped: a user who typed what their cast
  // line says still hears the tick and the wear-off, which say something else.
  const fired = fire(
    [
      def('slugs:vii-tick', 'heal', { spell: 'Slugs Healing VII' }),
      def('slugs:vii-wore', 'buffWearOff', { spell: 'Slugs Healing VII' })
    ],
    [SLUGS.tick, SLUGS.wore]
  )
  assert.deepEqual(fired.map((f) => f.alertId).sort(), ['slugs:vii-tick', 'slugs:vii-wore'])
})

test('JOS-318 E3: the evidence — which of the reporter`s lines carry the rank at all', () => {
  // Pinned so the diagnosis cannot rot. The cast lines keep the suffix; the landing, the wear-off
  // and the heal tick print the bare name, and the tick prints it because the HEALING ENGINE names
  // the spell rather than a message table — which is the whole reason the `healsOverTime` template
  // is rank-proof by construction.
  // `spell` is the field every one of these kinds names it (alertsFields.ts SPELL_FIELD_BY_KIND),
  // so one dynamic read keeps this a table rather than four narrowings.
  const kindAndSpell = (line: string, seq: number): [string | undefined, unknown] => {
    const ev = parseEvent(line, seq)
    return [ev?.kind, (ev as unknown as Record<string, unknown> | null)?.spell]
  }
  assert.deepEqual(kindAndSpell(SLUGS.cast, 0), ['castBegin', 'Slugs Healing VII'])
  assert.deepEqual(kindAndSpell(SLUGS.otherCast, 1), ['otherCastBegin', 'Slugs Healing VII'])
  // No suffix on any of these three — they are the lines an alert can always match.
  assert.deepEqual(kindAndSpell(SLUGS.tick, 2), ['heal', 'Slugs Healing'])
  assert.deepEqual(kindAndSpell(SLUGS.wore, 3), ['buffWearOff', 'Slugs Healing'])
  assert.deepEqual(kindAndSpell(SLUGS.landed, 4), ['buffApply', 'Slugs Healing'])
  const tick = parseEvent(SLUGS.tick, 5)
  assert.equal(tick?.kind === 'heal' ? tick.overTime : null, true, 'and it is a HoT tick')
})

test('JOS-318 E4: the hand-edited REGEX the reporter tried works now, and says why it did not', () => {
  // "even when manually changing the spell name regex to Slugs, the audio trigger doesn't go off."
  // A `/regex/` spec is left alone by the rank fold on purpose (B2 above) and never needed it: it
  // matches the ranked and unranked spellings alike. It could not fire because there was no EVENT —
  // the DB stated no landing or wear-off sentence for the spell at all, so nothing was ever emitted
  // for any matcher to test. With the correction in place the same pattern fires on all four lines.
  const fired = fire(
    [
      def('slugs:re-cast', 'castBegin', { spell: '/Slugs/' }),
      def('slugs:re-landed', 'buffApply', { spell: '/Slugs/' }),
      def('slugs:re-wore', 'buffWearOff', { spell: '/Slugs/' }),
      def('slugs:re-tick', 'heal', { spell: '/Slugs/' })
    ],
    [SLUGS.cast, SLUGS.landed, SLUGS.wore, SLUGS.tick]
  )
  assert.equal(fired.length, 4, 'one per line — the pattern was never the problem')
})
