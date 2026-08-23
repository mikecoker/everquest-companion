// JOS-347 — FOUR PER-SONG RESIST ALERTS MUST BE FOUR ALERTS, IN THE ROOM.
//
// THE REPORT (feedback 01KZZD3DF8V9XNFGQKGVB5562J, v0.27.0, no log attached), verbatim:
// "I have 4 alerts for all 4 Tuyens songs, each with a different voice line assigned to them.
// However, it seems like only the first alert is ever played, and it seems to play for any spell
// or song that I cast and gets resisted (and maybe even the ones my pet casts)."
//
// THE SUSPICION IN THE BRIEF WAS WRONG, AND THAT MATTERS ENOUGH TO PIN. The brief suspected the
// suggested-alert builder of emitting a resist trigger that does not discriminate by spell name.
// It does discriminate — A1 below proves it, through the real wizard and the real module: each
// def matches its own chant and nothing else, a plain nuke of yours fires none of them, and a
// PET's resist fires none of them either (`caster:'you'`). The four firings were always right.
//
// THE MECHANIC THAT MADE THEM INAUDIBLE IS BARD SONG REPETITION, and it is measured, not assumed.
// From the owner's own log (eqlog_Primitive_freeport.txt, Sun Jul 19 2026 — the owner played a
// bard that day, Symphonic Aura and all):
//
//   [Sun Jul 19 09:21:35 2026] A burst of strength surges through your body.
//   [Sun Jul 19 09:21:35 2026] Your feet move faster.
//   [Sun Jul 19 09:21:35 2026] A willowisp resisted your Denon's Disruptive Discord!
//   [Sun Jul 19 09:21:35 2026] The jig sends energy zinging through your body.
//   … the identical block again at :41, :47, :53, :59 …
//
// FOUR properties of that block, each of which this file depends on:
//   1. A song PULSES on a six-second tick and re-applies itself on every pulse.
//   2. A pulse prints NO cast line. 142 `resisted your Denon's Disruptive Discord!` lines in that
//      log against 5 `You begin singing` lines in the whole 141MB of it.
//   3. Every song a bard is running pulses in the SAME tick — the buff emotes and the detrimental
//      song's resist line share one timestamp. So a bard with four Tuyen chants up produces up to
//      four resist lines in one instant, not four spread over four seconds.
//   4. A resist line names the song in full, rank suffix intact, and the parser reads it
//      (`RESIST_YOURS_RE` is tested before the possessive-caster form precisely because song
//      names carry "'s").
//
// Property 3 is the defect's engine: the four lines arrive in one tail batch, become one alerts
// delta, and are played by ONE synchronous loop in the renderer — so the cross-alert audio window
// (audioThrottle.ts), which used to hold only a timestamp, handed the channel to whichever def
// was compiled first (creation order) and swallowed the other three. Every pulse. Forever.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import { suggestionsFor } from '../src/renderer/src/features/alerts/suggestions'
import {
  audioIdentity,
  coalesceAudio,
  type AudioWindow
} from '../src/renderer/src/features/alerts/audioThrottle'
import { speechPlan } from '../src/renderer/src/lib/speech'
import type { SpellRank } from '../src/shared/spellLines'
import type { AlertDef, FiredAlert, SpellCatalogEntry } from '../src/shared/types'

const db = loadSpellDb()
installSpellDb(db)
const catalog = buildSpellCatalog(db, new Map())

/** The reporter's four songs, in the order a bard's melody would list them. */
const CHANTS = [
  "Tuyen's Chant of Flame",
  "Tuyen's Chant of Frost",
  "Tuyen's Chant of Disease",
  "Tuyen's Chant of Poison"
] as const

function entryFor(name: string): SpellCatalogEntry {
  const e = catalog.entries.find((x) => x.key === name.toLowerCase())
  assert.ok(e, `spells.json must carry a catalog entry for "${name}"`)
  return e
}

/** The rank chip the wizard offers: the rank the log has actually seen you sing. */
function rank(name: string): SpellRank {
  return { name, rank: 5, suffixed: true, lastCastMs: Date.parse('2026-07-19T09:21:00Z') }
}

/** The def the RESIST chip authors for one chant — straight out of the real wizard path. */
function resistDef(chant: string): AlertDef {
  const s = suggestionsFor(entryFor(chant), rank(`${chant} V`)).find(
    (x) => x.template === 'resistRank'
  )
  assert.ok(s, `the wizard must offer a resist chip for ${chant}`)
  return s.def
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

/**
 * ONE SONG PULSE as the log prints it: one timestamp, every song re-applying, and this is the
 * mob that resisted all four. The shape is the owner's measured block with the reporter's chants
 * substituted for the one detrimental song the owner happened to be running.
 */
const PULSE = [
  '[Sun Jul 19 09:21:41 2026] A burst of strength surges through your body.',
  "[Sun Jul 19 09:21:41 2026] A willowisp resisted your Tuyen's Chant of Flame V!",
  "[Sun Jul 19 09:21:41 2026] A willowisp resisted your Tuyen's Chant of Frost V!",
  "[Sun Jul 19 09:21:41 2026] A willowisp resisted your Tuyen's Chant of Disease V!",
  "[Sun Jul 19 09:21:41 2026] A willowisp resisted your Tuyen's Chant of Poison V!",
  '[Sun Jul 19 09:21:41 2026] The jig sends energy zinging through your body.'
]

// ------------------------------------------------------------------ A1: the firings

test('JOS-347 A1: each per-song resist alert fires for its OWN song and nothing else', () => {
  const defs = CHANTS.map(resistDef)
  const fired = fire(defs, PULSE)
  assert.deepEqual(
    fired.map((f) => f.alertId),
    defs.map((d) => d.id),
    'four songs resisted, four alerts, one each'
  )
  assert.deepEqual(fired.map((f) => f.spell), [
    "Tuyen's Chant of Flame V",
    "Tuyen's Chant of Frost V",
    "Tuyen's Chant of Disease V",
    "Tuyen's Chant of Poison V"
  ])
  // One chant's def alone hears only its own chant, out of the same four-line pulse.
  const frostOnly = fire([resistDef("Tuyen's Chant of Frost")], PULSE)
  assert.deepEqual(frostOnly.map((f) => f.spell), ["Tuyen's Chant of Frost V"])
})

test('JOS-347 A2: neither your other spells nor your PET can set one of them off', () => {
  // The reporter's two hedges, answered separately. `caster:'you'` is what excludes the pet: the
  // parser reads `<target> resisted <caster>'s <Spell>!` into a named caster, and the song-name
  // apostrophe cannot smuggle it past that (RESIST_YOURS_RE is tested first).
  const defs = CHANTS.map(resistDef)
  const fired = fire(defs, [
    '[Sun Jul 19 09:21:47 2026] A willowisp resisted your Vampiric Embrace!',
    "[Sun Jul 19 09:21:47 2026] A willowisp resisted Giber's Lifespike!",
    "[Sun Jul 19 09:21:47 2026] A willowisp resisted Testone's Tuyen's Chant of Frost V!"
  ])
  assert.deepEqual(fired, [], 'not one of the four may fire on any of those')
})

test('JOS-347 A3: the pulse is the evidence — a resist line, no cast line, six seconds apart', () => {
  // Property 1/2/4 of the header, pinned against the parser so the diagnosis cannot rot.
  const a = parseEvent("[Sun Jul 19 09:21:35 2026] A willowisp resisted your Denon's Disruptive Discord!", 0)
  const b = parseEvent("[Sun Jul 19 09:21:41 2026] A willowisp resisted your Denon's Disruptive Discord!", 1)
  assert.equal(a?.kind, 'resist')
  assert.equal(b?.kind, 'resist')
  if (a?.kind !== 'resist' || b?.kind !== 'resist') return
  assert.equal(a.caster, 'you', 'the song-name apostrophe must not be read as a caster possessive')
  assert.equal(a.spell, "Denon's Disruptive Discord")
  assert.equal(b.ts - a.ts, 6000, 'a song pulse is a six-second tick')
})

// ------------------------------------------------------------------ A4: what is HEARD

/** Play a delta the way AlertPlayer does: one synchronous loop, one clock, one window. */
function audible(defs: AlertDef[], fired: FiredAlert[], now = 1_000): string[] {
  let win: AudioWindow | null = null
  const out: string[] = []
  for (const f of fired) {
    const def = defs.find((d) => d.id === f.alertId)
    assert.ok(def)
    const plan = speechPlan(def, f, false)
    const gate = coalesceAudio(def, now, win, { heard: audioIdentity(def, plan) })
    win = gate.window
    if (gate.play && plan.speak) out.push(plan.speak)
  }
  return out
}

test('JOS-347 A4: THE ACCEPTANCE — all four voice lines are heard, each naming its own song', () => {
  const defs = CHANTS.map(resistDef)
  assert.deepEqual(
    audible(defs, fire(defs, PULSE)),
    ['Flame resisted', 'Frost resisted', 'Disease resisted', 'Poison resisted'],
    'four songs resisted in one pulse must be four distinct lines, not the first one four times'
  )
})

test('JOS-347 A5: the chip ships a per-song voice line, so the user need not build one', () => {
  // The pre-fix defs were audio-identical by construction: one template, one pack sound, no
  // speech. That is what made three of the four inaudible even after the window learned to tell
  // them apart, and it is why the fix is in both files.
  const defs = CHANTS.map(resistDef)
  // 'speech', not the old combined channel — JOS-362 retired "Sound + voice", and the whole point
  // of this chip is the one word that tells the four chants apart.
  for (const d of defs) assert.equal(d.audio, 'speech')
  const phrases = defs.map((d) => (d.speech?.mode === 'custom' ? d.speech.phrase : null))
  assert.deepEqual(phrases, [
    'Flame resisted',
    'Frost resisted',
    'Disease resisted',
    'Poison resisted'
  ])
  assert.equal(new Set(phrases).size, 4, 'four chips, four things to hear')
  // And the sound is still the shared resist sound: the spoken half is what tells them apart.
  assert.equal(new Set(defs.map((d) => d.sound.soundId)).size, 1)
})

test('JOS-347 A6: a repeat of the SAME song inside one window is still one utterance', () => {
  // Being distinct buys one hearing, not an exemption from the throttle. Two resists of one chant
  // in the same instant (an AoE song on two mobs) says the line once.
  const defs = [resistDef("Tuyen's Chant of Frost")]
  const fired = fire(defs, [
    "[Sun Jul 19 09:21:41 2026] A willowisp resisted your Tuyen's Chant of Frost V!",
    "[Sun Jul 19 09:21:41 2026] A shadowknight resisted your Tuyen's Chant of Frost V!"
  ])
  assert.equal(fired.length, 1, "one def's own cooldown already covers the second target")
  assert.deepEqual(audible(defs, fired), ['Frost resisted'])
})
