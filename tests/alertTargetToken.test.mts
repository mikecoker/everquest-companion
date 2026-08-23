// JOS-353 — `{target}` RESOLVES ITSELF: THE AFFECTED MOB, WITH NO REGEX TO WRITE.
//
// THE OWNER'S RULING (2026-08-14): Companion parses which mob a spell is affecting and exposes it
// as a variable usable in alert text — `haste {target}` — integrated with the capture-group work,
// and it MUST NOT require the user to write heavy regex or do custom intervention.
//
// THREE REPORTS, TWO SENTENCES. The fade side ("Soothe has worn off a Fire Giant", "Mez has
// dropped on a ghoul") and the landing side. Both are asserted below through the REAL parser into
// the REAL AlertsModule and out through the REAL speech resolver — the same end-to-end shape
// tests/suggestedAlertsFire.test.mts uses, because a token that resolves in a unit of its own and
// not in the module is not a feature.
//
// WHAT THIS FILE PINS, in the order the sections run:
//   A. THE AUDIT. Every event kind whose interface carries an entity-shaped field is either in
//      `TARGET_FIELD_BY_KIND` with the right field name, or on the documented refusal list. It
//      re-reads shared/logEvents.ts, so a NEW kind that grows a `target`/`mob`/`subject` cannot
//      join the union without a ruling here.
//   B. THE PLAIN EDITOR. A def with NO regex anywhere — an event kind and a `where.spell`, which
//      is exactly what the condition editor authors — speaks the mob's name.
//   C. THE SENTINELS. 'self' speaks as "you", 'pet' as "your pet", and an ABSENT buffFade target
//      is the self form (the parser's own meaning), not a hole.
//   D. THE BOUNDS. The pattern's own group wins; a def that never writes the token carries no
//      captures at all; a kind outside the table resolves to nothing; the value is sanitized.
//   E. THE WIZARD. The five suggestion templates that ship a `{target}` phrase say the right
//      sentence on the reporters' own lines.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import {
  AUTO_TOKEN_NAMES,
  TARGET_FIELD_BY_KIND,
  TARGET_FIELD_EXCLUDED_KINDS,
  autoTokenNamesFor,
  autoTokensWanted,
  resolveTarget
} from '../src/shared/alertTargets'
import { speechTextFor } from '../src/shared/speechText'
import { suggestionsFor } from '../src/renderer/src/features/alerts/suggestions'
import type { LogEvent } from '../src/shared/logEvents'
import type { AlertDef, FiredAlert, SpellCatalogEntry } from '../src/shared/types'

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

/** A hand-authored def in exactly the shape the condition editor saves (no regex anywhere). */
function plainDef(
  kind: string,
  where: Record<string, string>,
  phrase: string,
  id = 'test:target'
): AlertDef {
  return {
    id,
    name: 'target test',
    enabled: true,
    trigger: { type: 'event', kind, where } as AlertDef['trigger'],
    cooldownMs: 0,
    audio: 'speech',
    speech: { mode: 'custom', phrase }
  }
}

// ---------------------------------------------------------------------------------------------
// A. THE AUDIT — the closed table is closed over the WHOLE union, not over what was in it in
//    August 2026.
// ---------------------------------------------------------------------------------------------

/** Every `<kind> → [entity fields]` shared/logEvents.ts declares, read off the source. */
function entityFieldsByKind(): Map<string, string[]> {
  const src = readFileSync(fileURLToPath(new URL('../src/shared/logEvents.ts', import.meta.url)), 'utf8')
  const out = new Map<string, string[]>()
  const iface = /export interface (\w+) extends LogEventBase \{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = iface.exec(src))) {
    const body = m[2]
    const kind = /kind: '([^']+)'/.exec(body)?.[1]
    if (!kind) continue
    const fields = [...body.matchAll(/^ {2}(target|mob|subject)\??:/gm)].map((x) => x[1])
    if (fields.length > 0) out.set(kind, fields)
  }
  return out
}

test('JOS-353 A1: every entity-naming kind is ruled on — in the table or refused by name', () => {
  const declared = entityFieldsByKind()
  assert.ok(declared.size >= 18, `the regex must still find the interfaces (found ${String(declared.size)})`)
  for (const [kind, fields] of declared) {
    const spec = TARGET_FIELD_BY_KIND[kind as keyof typeof TARGET_FIELD_BY_KIND]
    const refusal = TARGET_FIELD_EXCLUDED_KINDS[kind as keyof typeof TARGET_FIELD_EXCLUDED_KINDS]
    assert.ok(
      (spec === undefined) !== (refusal === undefined),
      `${kind} carries ${fields.join('/')} and must be EITHER in TARGET_FIELD_BY_KIND or refused with a reason (never both, never neither)`
    )
    if (spec) {
      assert.ok(
        fields.includes(spec.field),
        `${kind}: the table reads .${spec.field}, but the interface declares ${fields.join('/')}`
      )
    }
  }
})

test('JOS-353 A2: the table names no kind the union does not have', () => {
  const declared = entityFieldsByKind()
  for (const kind of Object.keys(TARGET_FIELD_BY_KIND)) {
    assert.ok(declared.has(kind), `${kind} is in the table but declares no entity field any more`)
  }
  for (const kind of Object.keys(TARGET_FIELD_EXCLUDED_KINDS)) {
    assert.ok(declared.has(kind), `${kind} is refused but declares no entity field any more`)
  }
})

test('JOS-353 A3: the auto-token list is ONE name — the exemption is not a namespace', () => {
  // Control 4 of shared/alertCaptures.ts's threat model gives up exactly one declaration, and the
  // size of the list is the size of what was given up. A second entry is an owner-level decision,
  // so it fails here first.
  assert.deepEqual([...AUTO_TOKEN_NAMES], ['target'])
})

// ---------------------------------------------------------------------------------------------
// B. THE PLAIN EDITOR — the acceptance criterion, on the reporters' own sentences.
// ---------------------------------------------------------------------------------------------

test('JOS-353 B1: THE FADE SENTENCE — "Mez has dropped on a ghoul", from a def with no regex', () => {
  // `Your <hold> spell has worn off of <mob>.` is claimed by classifyWornOff and becomes
  // `cc {refresh:true, mob}` — the event spells its entity `mob`, and the user never has to know.
  const line = '[Thu Aug 14 09:00:00 2026] Your Mesmerization spell has worn off of a ghoul.'
  const def = plainDef('cc', { spell: 'Mesmerization', refresh: 'true' }, 'Mez has dropped on {target}')
  const fired = fire([def], [line])
  assert.equal(fired.length, 1, 'the break line must fire it')
  assert.deepEqual(fired[0].captures, { target: 'a ghoul' })
  assert.equal(speechTextFor(def, fired[0]), 'Mez has dropped on a ghoul', 'THE ACCEPTANCE CRITERION')
})

test('JOS-353 B2: THE LANDING SENTENCE — the debuff names the mob it landed on', () => {
  // The JOS-84 reporter's own line. `buffApply.target` is the mob; the alert is pinned to the
  // user's own spell through the candidate widening, and the spoken sentence names both.
  const line = '[Fri Aug 07 09:07:24 2026] Coercer T`vala slows down.'
  const def = plainDef('buffApply', { spell: 'Shiftless Deeds' }, 'Shiftless on {target}')
  const fired = fire([def], [line])
  assert.equal(fired.length, 1)
  assert.equal(speechTextFor(def, fired[0]), 'Shiftless on Coercer T`vala', 'the backtick name survives')
})

test('JOS-353 B3: `haste {target}` — the owner\'s own example, on a buff landing', () => {
  const line = '[Thu Aug 14 09:01:00 2026] Bonbonz feels much faster.'
  const ev = parseEvent(line, 0)
  assert.equal(ev?.kind, 'buffApply', 'the third-person haste landing is a typed event')
  if (ev?.kind !== 'buffApply') return
  assert.equal(ev.target, 'Bonbonz')
  // The message is shared by a whole haste family, so the def is pinned to one member and the
  // candidate widening admits the line — JOS-84's rule, unchanged, and the token rides on top.
  const def = plainDef('buffApply', { spell: ev.candidates[0].name }, 'haste {target}')
  const fired = fire([def], [line])
  assert.equal(fired.length, 1)
  assert.equal(speechTextFor(def, fired[0]), 'haste Bonbonz')
})

test('JOS-353 B4: the editor OFFERS it — autoTokenNamesFor answers per trigger', () => {
  // Control (c) of shared/alertTargets.ts's header: the readable list the SpeechBlock hint prints,
  // and the only way a user discovers the token without reading this repo.
  assert.deepEqual(autoTokenNamesFor({ type: 'event', kind: 'buffApply' }), ['target'])
  assert.deepEqual(autoTokenNamesFor({ type: 'event', kind: 'cc' }), ['target'])
  assert.deepEqual(autoTokenNamesFor({ type: 'event', kind: 'uncharm' }), ['target'])
  // A family whose line names nobody offers nothing rather than a token that renders literally.
  assert.deepEqual(autoTokenNamesFor({ type: 'event', kind: 'level' }), [])
  assert.deepEqual(autoTokenNamesFor({ type: 'app', signal: 'bossDefeat' }), [])
  // A raw trigger fires on whatever kind the line parsed into, so it says "may fill in".
  assert.deepEqual(autoTokenNamesFor({ type: 'raw', regex: 'anything' }), ['target'])
  // A composite is reachable through ANY of its conditions — the `captureNamesIn` rule.
  assert.deepEqual(
    autoTokenNamesFor({
      type: 'any',
      conditions: [
        { type: 'event', kind: 'level' },
        { type: 'event', kind: 'buffExpired' }
      ]
    }),
    ['target']
  )
})

// ---------------------------------------------------------------------------------------------
// C. THE SENTINELS — the parser's vocabulary, read as English.
// ---------------------------------------------------------------------------------------------

test('JOS-353 C1: `self` speaks as "you", not as the word "self"', () => {
  const line = '[Sat Aug 01 18:39:10 2026] The spirit of the puma departs.'
  const ev = parseEvent(line, 0)
  assert.equal(ev?.kind, 'buffWearOff')
  if (ev?.kind !== 'buffWearOff') return
  assert.equal(ev.target, 'self', 'the wears-off emote prints to the HOLDER, so the parser says self')
  const def = plainDef('buffWearOff', { spell: 'Spirit of the Puma' }, 'Puma wore off {target}')
  const fired = fire([def], [line])
  assert.equal(fired.length, 1)
  assert.equal(speechTextFor(def, fired[0]), 'Puma wore off you')
})

test('JOS-353 C2: `pet` speaks as "your pet", and an ABSENT buffFade target IS the self form', () => {
  const petLine = "[Thu Aug 14 09:03:00 2026] Your pet's Swift Like the Wind spell has worn off."
  const selfLine = '[Thu Aug 14 09:03:10 2026] Your Swift Like the Wind spell has worn off.'
  const pet = parseEvent(petLine, 0)
  const self = parseEvent(selfLine, 1)
  assert.equal(pet?.kind, 'buffFade')
  assert.equal(self?.kind, 'buffFade')
  if (pet?.kind !== 'buffFade' || self?.kind !== 'buffFade') return
  assert.equal(pet.target, 'pet')
  assert.equal(self.target, undefined, 'the parser OMITS the field for the self form (parseCasts.ts)')

  const def = plainDef('buffFade', { spell: 'Swift Like the Wind' }, 'Swift faded on {target}')
  const fired = fire([def], [petLine, selfLine])
  assert.equal(fired.length, 2)
  assert.deepEqual(
    fired.map((f) => speechTextFor(def, f)),
    ['Swift faded on your pet', 'Swift faded on you']
  )
})

test('JOS-353 C3: a real name that LOOKS like a sentinel is a name', () => {
  // The sentinels are lowercase literals the parser writes itself; a name arrives with the game's
  // own casing. Matching them case-SENSITIVELY is what keeps a player named Self called Self.
  const named = (target: string): LogEvent => ({
    kind: 'buffExpired',
    seq: 1,
    ts: 0,
    raw: 'x',
    spell: 'Clarity',
    target
  })
  assert.equal(resolveTarget(named('Self')), 'Self')
  assert.equal(resolveTarget(named('self')), 'you')
  assert.equal(resolveTarget(named('a fire giant warrior')), 'a fire giant warrior')
})

// ---------------------------------------------------------------------------------------------
// D. THE BOUNDS — the four properties the threat model rests on.
// ---------------------------------------------------------------------------------------------

test('JOS-353 D1: a DECLARED group named `target` wins over the derived value', () => {
  // A declaration is what the def's author said they meant. The derived value fills a hole; it
  // never overwrites one.
  const def: AlertDef = {
    id: 'test:declared-target',
    name: 'declared',
    enabled: true,
    trigger: {
      type: 'raw',
      regex: "^\\[[^\\]]*\\] (?<target>[A-Za-z' `]{1,48}) growls with the spirit of the puma\\."
    },
    cooldownMs: 0,
    audio: 'speech',
    speech: { mode: 'custom', phrase: 'Puma on {target}' }
  }
  const line = '[Sat Aug 01 18:38:10 2026] Fail growls with the spirit of the puma.'
  // The line ALSO parses to a buffApply whose target is Fail, so the two agree here by luck —
  // assert the provenance instead: exactly one key, and it came from the pattern.
  const fired = fire([def], [line])
  assert.equal(fired.length, 1)
  assert.deepEqual(fired[0].captures, { target: 'Fail' })
  assert.equal(speechTextFor(def, fired[0]), 'Puma on Fail')
})

test('JOS-353 D2: a def that never writes the token carries NO captures — the delta is unchanged', () => {
  // The bound on the whole feature. Resolving a target for every firing would put a mob name on
  // every `module:delta` in the app; the wanted set is compiled from the def's OWN PHRASE instead.
  const line = '[Fri Aug 07 09:07:24 2026] Coercer T`vala slows down.'
  const silent: AlertDef = {
    id: 'test:no-token',
    name: 'no token',
    enabled: true,
    trigger: { type: 'event', kind: 'buffApply', where: { spell: 'Shiftless Deeds' } },
    cooldownMs: 0
  }
  assert.equal(fire([silent], [line])[0].captures, undefined)
  // …and neither does a custom phrase that says something else.
  const other = plainDef('buffApply', { spell: 'Shiftless Deeds' }, 'slowed', 'test:other-phrase')
  assert.equal(fire([other], [line])[0].captures, undefined)
  // `autoTokensWanted` is the compile-time reader, and it reads the PHRASE.
  assert.deepEqual(autoTokensWanted('Mez broke on {target}'), ['target'])
  assert.deepEqual(autoTokensWanted('Mez broke'), [])
  assert.deepEqual(autoTokensWanted(undefined), [])
})

test('JOS-353 D3: a kind outside the table resolves to nothing, so the token renders literally', () => {
  // A `raw` trigger fires on whatever the line parsed into. A chat family is not in the table and
  // cannot be — which is what keeps a stranger's typed words out of the one undeclared token.
  const def: AlertDef = {
    id: 'test:raw-chat',
    name: 'raw',
    enabled: true,
    trigger: { type: 'raw', regex: 'urgent' },
    cooldownMs: 0,
    audio: 'speech',
    speech: { mode: 'custom', phrase: 'heads up {target}' }
  }
  const fired = fire([def], ["[Thu Aug 14 09:04:00 2026] Bonbonz tells you, 'urgent, target is up'"])
  assert.equal(fired.length, 1, 'the raw pattern still matches the line')
  assert.equal(fired[0].captures, undefined, 'a tell names no entity this table will read')
  assert.equal(speechTextFor(def, fired[0]), 'heads up {target}', 'unresolved renders LITERALLY')
})

test('JOS-353 D4: the value crosses the same sanitizer every capture does', () => {
  // Control 1 of the threat model, enforced HERE rather than trusted to the caller: the resolver
  // is reachable from a test, from the module and from any future consumer.
  const hostile = (target: string): LogEvent => ({
    kind: 'buffApply',
    seq: 1,
    ts: 0,
    raw: 'x',
    spell: 'Clarity',
    target,
    illusion: false,
    durationMs: null,
    candidates: []
  })
  assert.equal(resolveTarget(hostile('a[31m ghoul')), 'a ghoul', 'ANSI leaves whole')
  assert.equal(resolveTarget(hostile('a‮ghoul')), 'aghoul', 'the BiDi-override class is deleted')
  assert.equal(resolveTarget(hostile('a\nghoul')), 'a ghoul', 'a newline collapses to one space')
  assert.equal(resolveTarget(hostile('x'.repeat(80)))?.length, 48, 'capped at MAX_CAPTURE_CHARS')
  assert.equal(resolveTarget(hostile('   ')), null, 'nothing survived ⇒ no capture ⇒ literal token')
})

// ---------------------------------------------------------------------------------------------
// E. THE WIZARD — suggested alerts emit it (the third acceptance clause).
// ---------------------------------------------------------------------------------------------

test('JOS-353 E1: the five speaking templates say the right sentence on real lines', () => {
  const cases: readonly [string, string, string, string][] = [
    // [catalog key, template, log line, what it must SAY]
    [
      'shiftless deeds',
      'lands',
      '[Fri Aug 07 09:07:24 2026] Coercer T`vala slows down.',
      'Shiftless on Coercer T`vala'
    ],
    [
      "sionachie's dreams",
      'breaks',
      "[Sun Aug 09 13:43:23 2026] Your Sionachie's Dreams spell has worn off of an elemental crusader.",
      // "Sionachie's" — `spellShortName`'s documented leading-possessive weak case, a worse-sounding
      // default and not a wrong one. Pinned here so the phrase and that rule move together.
      "Sionachie's broke on an elemental crusader"
    ],
    [
      "solon's bewitching bravura",
      'charmBreaks',
      "[Wed Aug 05 22:28:56 2026] Your Solon's Bewitching Bravura spell has worn off of a fire giant warrior.",
      // Same weak case as the row above — "Solon's", not "Bravura".
      "Solon's charm broke on a fire giant warrior"
    ],
    [
      'clarity',
      'fade',
      '[Fri Aug 07 09:20:00 2026] Your Clarity spell has worn off of Bonbonz.',
      'Clarity faded on Bonbonz'
    ],
    [
      'spirit of the puma',
      'wearsOff',
      '[Sat Aug 01 18:39:10 2026] The spirit of the puma departs.',
      'Puma wore off you'
    ]
  ]
  for (const [key, template, line, expected] of cases) {
    const def = suggestionsFor(entryFor(key)).find((s) => s.template === template)?.def
    assert.ok(def, `the wizard must offer "${template}" for ${key}`)
    // 'speech' since JOS-362 retired the combined channel: these templates exist to SAY a
    // sentence, so the spoken half is the one that survived.
    assert.equal(def.audio, 'speech', `${template}: a template with a phrase speaks it`)
    const fired = fire([def], [line])
    assert.equal(fired.length, 1, `${template}: the line must fire it`)
    assert.equal(speechTextFor(def, fired[0]), expected, `${template} on ${key}`)
  }
})

test('JOS-353 E2: `landsOnOther` still speaks its DECLARED group, not the auto token', () => {
  // The one family with no typed event to read an entity off (that is why it is a `raw` trigger).
  // Its phrase stays `{player}` and its capture stays the pattern's — JOS-103, untouched.
  const def = suggestionsFor(entryFor('spirit of the puma')).find(
    (s) => s.template === 'landsOnOther'
  )?.def
  assert.ok(def)
  assert.deepEqual(def.speech, { mode: 'custom', phrase: 'Puma on {player}' })
  const fired = fire([def], ['[Sat Aug 01 18:38:10 2026] Fail growls with the spirit of the puma.'])
  assert.deepEqual(fired[0].captures, { player: 'Fail' }, 'no target key: the phrase never asked')
  assert.equal(speechTextFor(def, fired[0]), 'Puma on Fail')
})

test('JOS-353 E3: the two tautology templates ship no phrase', () => {
  // `landsOnYou` already says "on you" in its own trigger (`where.target:'self'`), and
  // `healsOverTime` asks whether your heal is working rather than whom it is on. A phrase on
  // either would be the app talking to hear itself.
  const heal = suggestionsFor(entryFor('slugs healing'))
  for (const t of ['landsOnYou', 'healsOverTime']) {
    const def = heal.find((s) => s.template === t)?.def
    if (!def) continue
    assert.equal(def.speech, undefined, `${t} must not ship a spoken phrase`)
    assert.equal(def.audio, undefined, `${t} stays a sound-only suggestion`)
  }
})
