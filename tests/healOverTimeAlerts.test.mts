// JOS-318 — A HEAL OVER TIME IS ALERTABLE END TO END.
//
// TWO REPORTS, ONE SHAPE. A druid on 0.26.0 built a Flowering Heal alert from Add-from-Suggestion
// and it never fired (3JM1ZD). A shaman on 0.27.0 could not get Slugs Healing to fire at all while
// Tortoise Healing worked, and hand-editing the pattern to say "Slugs" changed nothing
// (01KZZXVW888E09C088QBRD5HCD). The measured causes, both against the committed DB:
//
//   * SLUGS HEALING's scrape states the literal stubs `You .` / `Someone .` and NO wear-off, so
//     `applyPlaceholderMessages` correctly blanked them and the spell was in no message table at
//     all. No landing and no wear-off event was ever emitted for it, which is why NOTHING the user
//     typed into a matcher could match — the events did not exist. `Tortoises Healing`, the rank
//     below it on the same shaman ladder (Snails 14 → Tortoises 28 → Slugs 42 → Sloths 50), is the
//     one rung the wiki filled in. That is the whole of "Tortoise works, Slugs does not".
//   * FLOWERING HEAL has a landing sentence and no wear-off. `wearsOff` needs the wear-off, `fade`
//     needs the pet/target line a self-cast HoT never prints, and `lands` is DETRIMENTAL-only by
//     construction — so the wizard had nothing to offer for the case the reporter was asking
//     about: the heal landing on THEM.
//
// THE FIX, in three parts, all exercised here through the REAL wizard path: the corrections overlay
// (src/main/data/spellCorrectionsHealing.ts, from the owner's own log), the `landsOnYou` template,
// and `healsOverTime` — which rests on the healing engine's own tick line and therefore on no
// message table at all.
//
// THE RANK HALF of the same ticket lives in tests/rankBlindSpellAlerts.test.mts (the E-series),
// beside the law it belongs to. This file is the HoT half.
//
// THE DEFS ARE NOT HAND-WRITTEN. Every trigger comes out of the real path —
// buildSpellCatalog(loadSpellDb()) → suggestionsFor(entry) — and goes into the real AlertsModule
// through the real parser, exactly as tests/suggestedAlertsFire.test.mts does it.
//
// THE LINES ARE THE REPORTER'S OWN, verbatim from the slice, quoted here and never committed (the
// AGENTS.md reporter-slice rule). `Ahyeon` is the groupmate the reporter is healing.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import { suggestionsFor } from '../src/renderer/src/features/alerts/suggestions'
import type { AlertDef, FiredAlert, SpellCatalogEntry } from '../src/shared/types'

// Installed exactly as main installs it. Node runs each test FILE in its own process, so this
// global injection cannot reach a sibling suite.
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

const SLUGS = {
  cast: '[Fri Aug 14 03:12:15 2026] You begin casting Slugs Healing VII.',
  landed: '[Fri Aug 14 03:12:16 2026] You being to feel healed by the slug.',
  wore: '[Fri Aug 14 03:12:19 2026] You feel the slug spirit depart.',
  tick: '[Fri Aug 14 03:14:25 2026] You healed Ahyeon over time for 247 hit points by Slugs Healing.',
  tickAgain:
    '[Fri Aug 14 03:14:31 2026] You healed Ahyeon over time for 247 hit points by Slugs Healing.',
  // The third-person landing. The owner's own log carries this shape 27 times (23 on player names,
  // 4 on `an abhorrent`); the reporter's slice shows the cast side of it.
  landedOnOther: '[Fri Aug 14 03:16:00 2026] Ahyeon is healed by the spirit of the slug.'
}

test('JOS-318 H1: THE ACCEPTANCE — the shaman`s own lines fire the suggested set', () => {
  // Every def out of the real wizard path, every line out of the reporter's slice. Before this
  // ticket the only chip the wizard offered for this spell was `fade`, and ZERO of these lines
  // could fire it.
  const defs = suggestionsFor(entryFor('slugs healing')).map((s) => s.def)
  const fired = fire(defs, [
    SLUGS.cast,
    SLUGS.landed,
    SLUGS.wore,
    SLUGS.tick,
    SLUGS.tickAgain,
    SLUGS.landedOnOther
  ])
  assert.deepEqual(new Set(fired.map((f) => f.alertId)), new Set([
    'suggest:slugs healing:landsOnYou',
    'suggest:slugs healing:wearsOff',
    'suggest:slugs healing:healsOverTime',
    'suggest:slugs healing:landsOnOther'
  ]))
  // ONE SOUND PER CAST, not one per tick: the second tick six seconds later is swallowed by the
  // template's own cooldown, which is the spell's stated duration rather than the 3 s default.
  assert.equal(fired.filter((f) => f.alertId.endsWith(':healsOverTime')).length, 1)
  const heals = suggestionsFor(entryFor('slugs healing')).find((s) => s.template === 'healsOverTime')
  assert.equal(heals?.def.cooldownMs, 24_000, 'the DB states 24 s for the line')
  // …and the third-person chip says WHO it landed on, which is the JOS-103 capture template working
  // on a sentence that only exists because of this ticket's correction.
  const named = fired.find((f) => f.alertId === 'suggest:slugs healing:landsOnOther')
  assert.deepEqual(named?.captures, { player: 'Ahyeon' })
})

test('JOS-318 H2: the druid`s report — a beneficial landing has a chip now', () => {
  // `Flowering Heal` needed no correction: its landing sentence was in the DB the whole time and
  // parsed to a perfectly good `buffApply {target:'self'}`. What did not exist was a template that
  // authored a trigger for it, which is the entire report.
  const sugg = suggestionsFor(entryFor('flowering heal'))
  const lands = sugg.find((s) => s.template === 'landsOnYou')?.def
  assert.ok(lands, 'the wizard must offer a lands-on-you chip for a beneficial spell')
  assert.deepEqual(lands.trigger, {
    type: 'event',
    kind: 'buffApply',
    where: { spell: 'Flowering Heal', target: 'self' }
  })
  const fired = fire([lands], ['[Fri Aug 14 04:00:00 2026] You feel a heal flowering within you.'])
  assert.equal(fired.length, 1, 'the DB`s own cast-on-you sentence must fire it')
  assert.equal(fired[0].spell, 'Flowering Heal')

  // AND THE OTHER HALF OF THE REPORT: this spell states no wear-off, so `wearsOff` is not offered
  // and must not be — the flag is a claim the alert can fire. `healsOverTime` is what answers "tell
  // me it is working" for a HoT with no wear-off sentence.
  assert.equal(entryFor('flowering heal').templates.wearsOff, false)
  assert.equal(entryFor('flowering heal').templates.healsOverTime, true)
  const heals = sugg.find((s) => s.template === 'healsOverTime')?.def
  assert.ok(heals)
  assert.equal(
    fire([heals], [
      '[Fri Aug 14 04:00:06 2026] You healed Ahyeon over time for 60 hit points by Flowering Heal.'
    ]).length,
    1
  )
})

test('JOS-318 H3: `landsOnYou` is a SELF landing and stays disjoint from the other-side chips', () => {
  // `target:'self'` is part of the trigger, not decoration: a shaman who wants "my HoT landed on me"
  // and "my HoT landed on the tank" gets two sounds, and neither answers the other's line.
  const defs = suggestionsFor(entryFor('slugs healing'))
  const onYou = defs.find((s) => s.template === 'landsOnYou')
  assert.ok(onYou)
  assert.equal(fire([onYou.def], [SLUGS.landedOnOther]).length, 0, 'a groupmate`s landing is not yours')
  assert.equal(fire([onYou.def], [SLUGS.landed]).length, 1)
  // …and the flag is beneficial-only, so a debuff landing on a mob still belongs to `lands`.
  assert.equal(entryFor('shiftless deeds').templates.landsOnYou, false, 'detrimental — no self chip')
  assert.equal(entryFor('slugs healing').templates.lands, false, 'beneficial — no mob-landing chip')
})

test('JOS-318 H4: the rung nobody can correct is still alertable, and that is the point', () => {
  // `Sloths Healing` carries the same two stubs as Slugs did and NO log anywhere has printed a line
  // of it, so extrapolating `You being to feel healed by the sloth.` is the invented content word
  // the corrections evidence bar forbids (spellCorrectionsHealing.ts says so in prose). It gets a
  // firing alert anyway, because the tick line comes from the healing engine rather than the wiki.
  const e = entryFor('sloths healing')
  assert.equal(e.templates.landsOnYou, false, 'no landing sentence — no landing chip')
  assert.equal(e.templates.wearsOff, false)
  assert.equal(e.templates.landsOnOther, false)
  assert.equal(e.templates.healsOverTime, true, 'and this one needs no sentence at all')
  const heals = suggestionsFor(e).find((s) => s.template === 'healsOverTime')
  assert.ok(heals)
  const fired = fire([heals.def], [
    '[Fri Aug 14 05:00:00 2026] You healed Ahyeon over time for 300 hit points by Sloths Healing.'
  ])
  assert.equal(fired.length, 1)
  assert.equal(fired[0].spell, 'Sloths Healing')
})

/** The line the DB itself says will set off one template for one spell, or null if this suite forgot. */
function lineFor(e: SpellCatalogEntry, template: string): string | null {
  const s = db.byKey.get(e.key)
  const at = '[Fri Aug 14 06:00:00 2026] '
  if (template === 'landsOnYou') return `${at}${s?.msgCastOnYou}`
  if (template === 'wearsOff') return `${at}${s?.msgWearsOff}`
  if (template === 'landsOnOther') return `${at}Ahyeon ${(s?.msgCastOnOther ?? '').replace(/^Someone /, '')}`
  if (template === 'healsOverTime') return `${at}You healed Ahyeon over time for 60 hit points by ${e.name}.`
  if (template === 'fade') return `${at}Your ${e.name} spell has worn off of Ahyeon.`
  return null
}

test('JOS-318 H5: no chip is a lie — every template a HoT is offered fires on a real line', () => {
  // The law this ticket is an instance of (shared/alertGroups.ts, JOS-84, JOS-103): a flag is a
  // CLAIM the alert can fire. Walk the four rungs of the shaman ladder and assert the claim for
  // each template against the sentence the DB itself states for that spell — so a re-scrape that
  // changes a sentence fails here rather than in somebody's ears.
  for (const key of ['snails healing', 'tortoises healing', 'slugs healing', 'sloths healing']) {
    const e = entryFor(key)
    for (const sugg of suggestionsFor(e)) {
      const line = lineFor(e, sugg.template)
      assert.ok(line, `${key}/${sugg.template}: this suite must state the line it fires on`)
      assert.equal(fire([sugg.def], [line]).length, 1, `${key}: the ${sugg.template} chip must fire`)
    }
  }
})
