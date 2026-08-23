// JOS-238 — A RESOLVED WEAR-OFF SPEAKS THE SPELL'S NAME, NOT THE RANKED TEXT OF ONE CAST LINE.
//
// THE REPORT (owner, 2026-08-12, during release testing): the suggested `wearsOff` alert for
// Swift Like The Wind never fires. He clicked it out of the wizard, held the buff, watched it
// wear off, and heard nothing.
//
// THE MECHANISM, root-caused against his own bytes and reproduced verbatim below. His haste comes
// off a clicky, so the cast line is RANKED:
//
//   Your Golden Efreeti Boots (Exaltation) shimmers briefly.   ← the item fires
//   You begin casting Swift Like the Wind IV.                  ← the ONLY line that carries a rank
//   You feel much faster.                                      ← FOUR spells print this sentence
//   Your speed returns to normal.                              ← NINE spells print this one
//
// The landing is 4-way ambiguous, so it resolves through the CAST ANCHOR (modules/buffAnchors.ts →
// modules/buffLanding.ts). That resolution used to carry the ANCHOR'S RAW TEXT forward as the
// spell's identity — `Swift Like the Wind IV` became the ActiveBuff's name, the learner's display
// name, the row's name, and finally the derived `buffExpired.spell`. The suggested def pins the
// bare DB display name (`Swift Like The Wind`, which is what the catalog, the candidate lists and
// every other surface state), and `where.spell` is a case-insensitive EXACT compare, so the alert
// was being asked whether "Swift Like the Wind IV" equals "Swift Like The Wind". It never could.
// Every spell in the haste family shares both sentences, so this was true of all of them, at every
// rank above I.
//
// THE RULE THIS PINS: when an anchor resolves an ambiguous landing, the resolved IDENTITY is the
// DB CANDIDATE the anchor matched — instance, learner row, timer row and `buffExpired` alike. The
// rank is not thrown away; it moves to `castName`, which is DISPLAY ONLY and which the two timer
// surfaces render as a chip beside the name.
//
// WHY THE ANCHOR MATCHED AT ALL, which the fix leans on: `CastAnchors` files every cast under
// `spellKey` (= `spellCanonKey`: rank tail stripped, case folded) and `namedAnchorFor` looks each
// candidate up under the same key. So `Swift Like the Wind IV` and `Swift Like The Wind` were
// ALREADY known to be one spell line — the two strings differ only in how the log wrote them down,
// which is exactly why the DB's is the one worth keeping.
//
// THE LINES ARE SYNTHESIZED, not extracted: every sentence here is a shape the committed
// spells.json itself states (the two haste messages) or that the tree already carries verbatim
// (the clicky's `shimmers briefly.`, the `You begin casting <S>.` form), so nothing about the
// owner's log is committed. The ticket asks for exactly this.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { buildSpellCatalog, loadSpellDb } from '../src/main/data/spellDb'
import { BuffsModule } from '../src/main/modules/buffs'
import { BuffTimersModule } from '../src/main/modules/buffTimers'
import { AlertsModule } from '../src/main/modules/alerts'
import { suggestionsFor } from '../src/renderer/src/features/alerts/suggestions'
import { spellKey } from '../src/main/modules/buffsShapes'
import { buildTimerRows, rowRankLabel, timerNameKey } from '../src/shared/buffTimers'
import type { BuffTimerRow } from '../src/shared/buffTimers'
import type { LogEvent } from '../src/shared/logEvents'
import type { ActiveBuff, AlertDef, FiredAlert } from '../src/shared/types'

// The DB is installed exactly as main installs it — the whole defect lives in the DB-driven
// message families. Node runs each test FILE in its own process, so this cannot reach a sibling.
const db = loadSpellDb()
installSpellDb(db)
const catalog = buildSpellCatalog(db, new Map())

/** The def the WIZARD authors for this spell's "wears off you" chip — never hand-written here. */
function suggestedWearsOff(key: string): AlertDef {
  const entry = catalog.entries.find((e) => e.key === key)
  assert.ok(entry, `spells.json must carry a catalog entry for "${key}"`)
  const def = suggestionsFor(entry).find((s) => s.template === 'wearsOff')?.def
  assert.ok(def, `the wizard must offer a wears-off suggestion for "${key}"`)
  return def
}

interface Replay {
  active: ActiveBuff[]
  rows: BuffTimerRow[]
  stats: Record<string, { spell: string; n: number }>
  /** Every derived event the buffs module synthesized, in order. */
  derived: LogEvent[]
  /** What the given suggested defs fired on, primary AND derived events alike. */
  fired: FiredAlert[]
}

/**
 * Replay raw lines through the real parser, the real buffs + buffTimers modules AND the real
 * alerts module — with the derived `buffExpired` handed to alerts the way `modules/wiring.ts`
 * wires the bus in production. Nothing here is a stub: the acceptance is end to end or it is
 * not the acceptance.
 */
function replay(lines: string[], defs: AlertDef[] = []): Replay {
  const derived: LogEvent[] = []
  const alerts = new AlertsModule()
  alerts.setDefs(defs)
  alerts.reset()
  const buffs = new BuffsModule(db, undefined, (ev, live) => {
    derived.push(ev)
    alerts.onEvent(ev, live)
  })
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  buffs.reset()
  timers.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    buffs.onEvent(ev, true)
    timers.onEvent(ev, true)
    alerts.onEvent(ev, true)
  }
  const b = buffs.snapshot().state
  return {
    active: b.active,
    rows: buildTimerRows(b, timers.snapshot().state),
    stats: b.stats,
    derived,
    fired: alerts.flushDelta()?.delta.fired ?? []
  }
}

// ---------------------------------------------------------------------------------------------
// THE OWNER'S FOUR LINES.
// ---------------------------------------------------------------------------------------------

const CLICKY = '[Sat Aug 01 19:00:00 2026] Your Golden Efreeti Boots (Exaltation) shimmers briefly.'
const CAST_RANKED = '[Sat Aug 01 19:00:01 2026] You begin casting Swift Like the Wind IV.'
const LANDED = '[Sat Aug 01 19:00:05 2026] You feel much faster.'
const WORE_OFF = '[Sat Aug 01 19:20:00 2026] Your speed returns to normal.'
const HASTE = [CLICKY, CAST_RANKED, LANDED, WORE_OFF]

test('JOS-238 A1: the four-line replay yields buffExpired "Swift Like The Wind"', () => {
  const r = replay(HASTE)
  const expired = r.derived.filter((e) => e.kind === 'buffExpired')
  assert.equal(expired.length, 1, 'the wear-off resolves against the active set exactly once')
  assert.equal(expired[0].kind, 'buffExpired')
  if (expired[0].kind !== 'buffExpired') return
  // THE ACCEPTANCE CRITERION. It said `Swift Like the Wind IV` before this ticket.
  assert.equal(expired[0].spell, 'Swift Like The Wind', 'the DB candidate the anchor matched')
  assert.equal(expired[0].target, 'self')
})

test('JOS-238 A2: THE REPORT — the stored suggested def fires on the owner`s own sequence', () => {
  const def = suggestedWearsOff('swift like the wind')
  // The def is UNCHANGED by this fix; it pins the bare catalog name, as the wizard has always
  // authored it. What changed is that the model now speaks that name.
  assert.deepEqual(def.trigger, {
    type: 'any',
    conditions: [
      { type: 'event', kind: 'buffExpired', where: { spell: 'Swift Like The Wind' } },
      { type: 'event', kind: 'buffWearOff', where: { spell: 'Swift Like The Wind' } }
    ]
  })
  const fired = replay(HASTE, [def]).fired
  assert.equal(fired.length, 1, 'one wear-off, one alert (the composite`s duplicate is eaten by the cooldown)')
  assert.equal(fired[0].alertId, 'suggest:swift like the wind:wearsOff')
  assert.equal(fired[0].spell, 'Swift Like The Wind')
})

test('JOS-238 A3: the row is named for the spell and CHIPS the rank', () => {
  // Observed before the wear-off, so the bar is up: the identity question is about the row a user
  // is looking at, not only about the event it eventually emits.
  const r = replay([CLICKY, CAST_RANKED, LANDED])
  assert.equal(r.active.length, 1)
  assert.equal(r.active[0].spell, 'Swift Like The Wind', 'the instance`s identity is the DB name')
  assert.equal(r.active[0].castName, 'Swift Like the Wind IV', 'and the cast line`s text is kept')
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].name, 'Swift Like The Wind')
  assert.equal(r.rows[0].castName, 'Swift Like the Wind IV')
  // What both timer surfaces actually draw beside the name — the rank alone, not the whole string
  // back again (a chip reading `Swift Like the Wind IV` would just be the old defect, indented).
  assert.equal(rowRankLabel(r.rows[0].name, r.rows[0].castName), 'IV')
  // The row ID never carried the rank in the first place (it is built from `timerNameKey`), which
  // is why a rank UPGRADE mid-session has always been one row rather than two.
  assert.equal(r.rows[0].id, 'self|self|swift like the wind')
})

test('JOS-238 A4: a ranked cast and a bare one file under ONE learning row', () => {
  // THE QUESTION THE TICKET ASKED OUT LOUD: if ranked and bare names produced separate learner
  // rows for one spell line, every JOS-212 cluster would be split down the middle and the
  // below-floor overrule (three agreeing cycles) could never be reached by a player who levelled
  // mid-session. They do not, and they never did — the learner is keyed on the rank-STRIPPED line
  // (buffsStats.ts `learnKey`, JOS-140 ruling 4) and only the DISPLAY name in that row moved.
  const bare = [
    '[Sat Aug 01 19:30:00 2026] You begin casting Swift Like The Wind.',
    '[Sat Aug 01 19:30:05 2026] You feel much faster.',
    '[Sat Aug 01 19:50:05 2026] Your speed returns to normal.'
  ]
  const r = replay([...HASTE, ...bare])
  const keys = Object.keys(r.stats).filter((k) => k.includes('swift'))
  assert.deepEqual(keys, ['swift like the wind'], 'one line, one row — never one per rank')
  assert.equal(r.stats['swift like the wind'].n, 2, 'both cycles pooled into it')
  // …and the row DISPLAYS the spell now, where it used to display whichever rank happened to mint
  // the first sample. That name is what the Buffs tab's stats table prints.
  assert.equal(r.stats['swift like the wind'].spell, 'Swift Like The Wind')
})

test('JOS-238 A5: the anchor and the candidate meet under the rank-stripped, case-folded key', () => {
  // The load-bearing pre-existing fact the fix rests on, pinned so a rename cannot quietly break
  // resolution and leave the alert silent again by a different route. `spellKey` is what
  // `CastAnchors` files and looks up by; `timerNameKey` is the shared/ mirror the row ids and
  // `rowRankLabel` use. They must agree about this pair or the two halves would disagree about
  // which spell a row is.
  assert.equal(spellKey('Swift Like the Wind IV'), 'swift like the wind')
  assert.equal(spellKey('Swift Like The Wind'), 'swift like the wind')
  assert.equal(timerNameKey('Swift Like the Wind IV'), timerNameKey('Swift Like The Wind'))
})

// ---------------------------------------------------------------------------------------------
// THE REGRESSION GUARD — a UNIQUE-message buff is untouched, byte for byte.
// ---------------------------------------------------------------------------------------------

test('JOS-238 A6: Clarity — a unique landing sentence is unchanged in every field', () => {
  // Clarity's `A cool breeze slips through your mind.` is ONE spell in the committed DB and its
  // wear-off names it outright, so it never went near the ambiguous-landing path and its alert
  // always fired. It is the control: if this moved, the fix reached further than the anchor.
  const def = suggestedWearsOff('clarity')
  const r = replay(
    [
      '[Sat Aug 01 19:00:01 2026] You begin casting Clarity.',
      '[Sat Aug 01 19:00:05 2026] A cool breeze slips through your mind.',
      '[Sat Aug 01 19:27:05 2026] The cool breeze fades.'
    ],
    [def]
  )
  const expired = r.derived.filter((e) => e.kind === 'buffExpired')
  assert.equal(expired.length, 1)
  if (expired[0].kind !== 'buffExpired') return
  assert.equal(expired[0].spell, 'Clarity')
  assert.equal(r.fired.length, 1, 'the Clarity wears-off alert still fires exactly once')
  assert.equal(r.fired[0].spell, 'Clarity')
})

test('JOS-238 A7: an unranked cast carries NO castName — the field states a difference or nothing', () => {
  // `Swift Like The Wind` cast at its base rank spells the DB name exactly, so there is no second
  // fact to record and no chip to draw. An optional that was always present would be noise on
  // every row in the window.
  const r = replay([
    '[Sat Aug 01 19:00:01 2026] You begin casting Swift Like The Wind.',
    '[Sat Aug 01 19:00:05 2026] You feel much faster.'
  ])
  assert.equal(r.active.length, 1)
  assert.equal(r.active[0].spell, 'Swift Like The Wind')
  assert.equal(r.active[0].castName, undefined, 'the cast line said nothing the name does not')
  assert.equal(r.rows[0].castName, undefined)
  assert.equal(rowRankLabel(r.rows[0].name, r.rows[0].castName), undefined, 'and so no chip')
})
