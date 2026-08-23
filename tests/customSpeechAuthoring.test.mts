// JOS-360 — A CUSTOM SPOKEN PHRASE IS STILL SOMETHING A USER WRITES, ON ANY ALERT.
//
// THE OWNER'S RULING (2026-08-14, hands-on testing, release-blocking): "we lost the ability to
// write custom spoken alerts. we must retain that. and we must be able to parse {target} and such
// in those custom alerts."
//
// WHAT BROKE, AND WHY IT TOOK TWO TICKETS TO DO IT. The alert ROW is where the owner configures an
// alert — his own ruling built AudioPicker for exactly that ("the voice vs sound should be
// integrated into this dropdown instead of having to drill into edit"), and its "Speak: custom…"
// entry is the one control in the app that writes a spoken phrase without opening the editor. That
// entry opened its phrase popover from the Select's `onChange`, and a MUI Select fires `onChange`
// only when the value CHANGES (SelectInput's `if (value !== newValue)` guard). So the entry was
// always dead for a def already sitting at `speech.mode:'custom'` — and until 2026-08-14 almost no
// def was: `landsOnOther` was the only suggestion template that shipped a phrase. JOS-347 and
// JOS-353 gave SIX more templates a default phrase (`{target}` fade/landing/break lines, the
// per-song resist line), so overnight the suggestions a user actually installs all arrive in
// custom mode — and the control that rewords them became a no-op on every one of them.
//
// WHAT THIS FILE PINS. The DOM half of the fix is an e2e claim by construction (a click on a MUI
// menu item is not a thing a node test can have an opinion about) and lives in
// tests/e2e/customPhraseSteps.mts. What is pinned HERE is everything around it, in the same
// end-to-end shape tests/alertTargetToken.test.mts uses — the real parser into the real
// AlertsModule and out through the real speech resolver:
//   A. THE STATE THAT MADE IT VISIBLE — every phrase-bearing template ships `mode:'custom'`, so
//      the row's custom entry is a RE-PICK rather than a change. This is the fact the fix is a
//      response to, and if it ever stops being true the fix is still right but the story changes.
//   B. THE ROUND TRIP — a phrase written through the row's own model, on a suggested def, reaches
//      the module's compile-time wanted set and speaks the mob's name (requirement 2).
//   C. NO CLOBBER — once a user has rewritten a suggestion's phrase, no other row edit puts the
//      template's default back (requirement 3).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import { speechTextFor } from '../src/shared/speechText'
import {
  OUTPUT_SPEECH,
  applyAudioChoice,
  audioChoiceOf,
  withOutput,
  withPhrase,
  withSoundId,
  withSpeechMode
} from '../src/renderer/src/features/alerts/audioChoice'
import { suggestionsFor } from '../src/renderer/src/features/alerts/suggestions'
import type { AlertDef, FiredAlert, SoundPack, SpellCatalogEntry } from '../src/shared/types'

const db = loadSpellDb()
installSpellDb(db)
const catalog = buildSpellCatalog(db, new Map())

function entryFor(key: string): SpellCatalogEntry {
  const e = catalog.entries.find((x) => x.key === key)
  assert.ok(e, `spells.json must carry a catalog entry for "${key}"`)
  return e
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

/** The `fade` suggestion for Clarity — a def that ships a `{target}` phrase (JOS-353). */
function suggestedFade(): AlertDef {
  const def = suggestionsFor(entryFor('clarity')).find((s) => s.template === 'fade')?.def
  assert.ok(def, 'the wizard must still offer a "fade" suggestion for Clarity')
  return def
}

/** The line that fires it, and the mob it names. EQ's own sentence. */
const FADE_LINE = '[Fri Aug 07 09:20:00 2026] Your Clarity spell has worn off of Bonbonz.'

/** One installed pack, for the output select's pack branch. Only the id is read here. */
const A_PACK: SoundPack = { id: 'alan-rickman', name: 'Alan Rickman', sounds: {} } as SoundPack

// ---------------------------------------------------------------------------------------------
// A. THE STATE THAT MADE THE DEAD CONTROL VISIBLE.
// ---------------------------------------------------------------------------------------------

test('JOS-360 A1: every phrase-bearing suggestion arrives ALREADY in custom mode', () => {
  // This is the whole reason a latent dead entry became "we lost the ability to write custom
  // spoken alerts": the row's "Speak: custom…" is a RE-PICK on each of these, and a re-pick fires
  // no `onChange`. The fix moved the popover onto the MenuItem's `onClick`, which MUI calls
  // unconditionally — but the claim that these defs are in custom mode belongs in a test, because
  // it is the premise.
  const speaking = suggestionsFor(entryFor('clarity')).filter((s) => s.def.speech !== undefined)
  assert.ok(speaking.length > 0, 'JOS-353 gave the fade/wearsOff templates a spoken phrase')
  for (const s of speaking) {
    // These templates used to arrive on the combined 'sound + voice' channel, which is why the
    // owner's own walk started by switching the row's output to voice before the say picker even
    // appeared. JOS-362 retired that channel and they now arrive SPOKEN — the say picker is on the
    // row from the first look, and the re-pick this file is about is one click in.
    assert.equal(s.def.audio, 'speech', `${s.template}: a template with a phrase speaks it`)
    assert.equal(s.def.speech?.mode, 'custom', `${s.template}: a shipped phrase is a custom phrase`)
    assert.equal(
      audioChoiceOf(s.def).mode,
      'custom',
      `${s.template}: the ROW reads it as custom too — so its custom entry is the selected value`
    )
  }
})

// ---------------------------------------------------------------------------------------------
// B. THE ROUND TRIP — the user's own words, through the row's model, into the spoken sentence.
// ---------------------------------------------------------------------------------------------

test('JOS-360 B1: a phrase written on the row speaks the mob’s name — parser → module → speech', () => {
  // The exact sequence the row performs: read the def's state, commit a typed phrase, write it
  // back onto the def. `{target}` is hand-typed, with no capture group anywhere in the trigger.
  const suggested = suggestedFade()
  const mine = applyAudioChoice(suggested, withPhrase(audioChoiceOf(suggested), 'Clarity is gone from {target}'))

  assert.equal(mine.speech?.mode, 'custom')
  assert.equal(mine.speech?.phrase, 'Clarity is gone from {target}', 'the user’s words, not the template’s')

  const fired = fire([mine], [FADE_LINE])
  assert.equal(fired.length, 1, 'the def still fires on its own line')
  // THE COMPILE-TIME SEAM the ticket named: the wanted set is computed from the def's OWN phrase
  // (modules/alerts.ts `compileAlert` → `autoTokensWanted`), so a phrase authored anywhere but the
  // wizard has to reach it. If the row's write did not land on `speech.phrase`, this is empty.
  assert.deepEqual(fired[0].captures, { target: 'Bonbonz' }, 'the token was WANTED, so it was carried')
  assert.equal(speechTextFor(mine, fired[0]), 'Clarity is gone from Bonbonz')
})

test('JOS-360 B2: a phrase with no token still carries no capture — the bound is unchanged', () => {
  // The other half of the same seam, and the reason it is a gate rather than an always-on read: a
  // user who rewords a suggestion into a sentence without `{target}` must get a byte-identical
  // delta to a def that never spoke at all (shared/alertTargets.ts's last paragraph).
  const suggested = suggestedFade()
  const plain = applyAudioChoice(suggested, withPhrase(audioChoiceOf(suggested), 'clarity gone'))
  const fired = fire([plain], [FADE_LINE])
  assert.equal(fired.length, 1)
  assert.equal(fired[0].captures, undefined)
  assert.equal(speechTextFor(plain, fired[0]), 'clarity gone')
})

test('JOS-360 B3: clearing the phrase is a statement, not a broken alert', () => {
  // `withPhrase('')` reverts to the mode that describes what will actually be spoken (audioChoice
  // .ts's own rule) — now reachable, because the popover can be REOPENED on a custom def at all.
  const suggested = suggestedFade()
  const cleared = applyAudioChoice(suggested, withPhrase(audioChoiceOf(suggested), '   '))
  assert.equal(cleared.speech, undefined, 'nothing configured ⇒ the key is omitted, as it always was')
  const fired = fire([cleared], [FADE_LINE])
  assert.equal(speechTextFor(cleared, fired[0]), suggested.name, 'it speaks its NAME, never nothing')
})

// ---------------------------------------------------------------------------------------------
// C. NO CLOBBER — the template's default is an opening offer, never a correction.
// ---------------------------------------------------------------------------------------------

test('JOS-360 C1: no row edit puts the template’s default phrase back', () => {
  const suggested = suggestedFade()
  const template = suggested.speech?.phrase
  assert.ok(template, 'the fade template ships a default phrase (JOS-353)')

  const mine = applyAudioChoice(suggested, withPhrase(audioChoiceOf(suggested), 'MY WORDS about {target}'))

  // Every other write the row can make, applied one after another to the user's def. None of them
  // is about the phrase, and none of them may touch it — `speechFieldsOf` rebuilds the block from
  // the CHOICE, so a field it forgot to carry would silently revert to the def's shipped value.
  const edits: readonly [string, (d: AlertDef) => AlertDef][] = [
    ['switch the output to a pack', (d) => applyAudioChoice(d, withOutput(audioChoiceOf(d), A_PACK.id, [A_PACK]))],
    ['switch the output to voice', (d) => applyAudioChoice(d, withOutput(audioChoiceOf(d), OUTPUT_SPEECH, [A_PACK]))],
    ['pick another sound', (d) => applyAudioChoice(d, withSoundId(audioChoiceOf(d), 'task-error-task-error-08'))],
    ['say the alert name instead', (d) => applyAudioChoice(d, withSpeechMode(audioChoiceOf(d), 'alertName'))],
    ['…and go back to the custom phrase', (d) => applyAudioChoice(d, withSpeechMode(audioChoiceOf(d), 'custom'))]
  ]
  let def = mine
  for (const [what, edit] of edits) {
    def = edit(def)
    assert.notEqual(def.speech?.phrase, template, `${what}: the template’s default must not return`)
  }
  assert.equal(def.speech?.mode, 'custom', 'and the round trip lands back on the user’s own mode')
  assert.equal(def.speech?.phrase, 'MY WORDS about {target}')

  // …and it still SAYS it, after all of that.
  const fired = fire([def], [FADE_LINE])
  assert.equal(speechTextFor(def, fired[0]), 'MY WORDS about Bonbonz')
})

test('JOS-362 (was JOS-360 C2): a phrase rewrite DROPS a stored per-alert voice', () => {
  // INVERTED ON PURPOSE. This test used to say the row carried the editor's voice override through
  // untouched — right while an alert could own a voice, and the owner has since retired the whole
  // dimension: "our settings shouldn't store which voice per alert, only the preferences should
  // (within Voice (spoken))". A def carrying one is what made an alert keep speaking in the voice
  // it was authored under. What survives from the old claim is the part that still matters: the
  // user's WORDS are untouched by any of this.
  const suggested = suggestedFade()
  const withVoice: AlertDef = { ...suggested, speech: { ...suggested.speech, mode: 'custom', voiceId: 'urn:voice:david' } }
  const mine = applyAudioChoice(withVoice, withPhrase(audioChoiceOf(withVoice), 'gone from {target}'))
  assert.equal(mine.speech?.voiceId, undefined, 'the next write of this alert omits the dead key')
  assert.equal(mine.speech?.phrase, 'gone from {target}')
  assert.equal(withVoice.speech?.voiceId, 'urn:voice:david', 'and reading it changed nothing on disk')
})
