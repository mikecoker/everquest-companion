// ONE SPELL, ONE ROW — user report 01KZSRAYCHF4ZX1PEP4RSPPM07 (JOS-244), "combat parsing is
// tracking the damage component of dot separately".
//
// THE VERDICT IS ONE SPELL, AND THE SLICE SETTLES IT. A DoT that also lands an initial direct hit
// prints its two halves as two different sentences, and the game spells the spell DIFFERENTLY in
// each — the landing sentence DROPS the rank numeral the tick sentence keeps:
//     `You hit <mob> for 55 points of poison damage by Envenomed Bolt.`
//     `<mob> has taken 419 damage from your Envenomed Bolt VI.`
// On the reporter's 15-minute slice every `You begin casting Envenomed Bolt VI.` is followed
// within two seconds by exactly ONE landing line — 4 casts, 4 landings, 1:1 — and then by the
// six-second tick train. Same for `Plague VI` (2 casts, 2 landings, 22 ticks). Two shapes of one
// button press, not two effects. His meter therefore carried, for one spell:
//     dot   `Envenomed Bolt VI`  16,839 over 23 ticks
//     spell `Envenomed Bolt`        244 over  4 landings
// and the same for Plague (5,470 / 732). Measured by replaying the slice through the real parser
// and the real CombatEngine.
//
// THE FIX IS PRESENTATION AND THE ENGINE IS UNTOUCHED (law 8): `skillGroups.groupSpellComponents`
// merges the two flat rows into one, exactly as `groupSlay` merges the per-weapon Slay Undead
// rows, with the two components one click down inside the row's own expansion. No engine total,
// category rollup, or timeline lane moves — D4 is that gate, and D2 pins the pre-merge lanes so
// the collapse can never be mistaken for the split never having existed.
//
// A REPORTER'S SLICE NEVER BECOMES A FIXTURE (AGENTS.md), and this one needed none: the window
// below is SYNTHESIZED from hand-written lines whose SHAPES are quoted from the slice with the
// mobs swapped for one of the owner's own, so every number here is hand-tallied arithmetic that
// can be read straight off the source of this file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { flattenSkills, type SkillRow } from '../src/renderer/src/features/combat/dashboardData'
import { groupSpellComponents } from '../src/renderer/src/features/combat/skillGroups'
import { abilityExpandable } from '../src/renderer/src/features/combat/abilityStats'
import type { DamageCategory, SourceView } from '../src/shared/combat'

// ── the parser half: the two shapes, and what they disagree about ─────────────────────────

function dmg(text: string, seq = 0): { skill: string; dtype: string; amount: number } {
  const ev = parseEvent(`[Tue Aug 11 21:02:43 2026] ${text}`, seq)
  assert.ok(ev, `did not parse: ${text}`)
  if (ev.kind !== 'damage') throw new Error(`not a damage event: ${text}`)
  return { skill: ev.skill, dtype: ev.dtype, amount: ev.amount }
}

test('D1: the landing sentence and the tick sentence name the SAME spell differently', () => {
  const land = dmg('You hit a sand giant for 55 points of poison damage by Envenomed Bolt.')
  const tick = dmg('a sand giant has taken 419 damage from your Envenomed Bolt VI.')

  // The disagreement, stated: same spell, two spellings, two damage types.
  assert.equal(land.skill, 'Envenomed Bolt')
  assert.equal(tick.skill, 'Envenomed Bolt VI')
  assert.equal(land.dtype, 'spell')
  assert.equal(tick.dtype, 'dot')
  // ...which is a RANK TAIL and nothing else — the same divergence spellCanonKey exists for.
  assert.equal(tick.skill.replace(/ VI$/, ''), land.skill)

  // The disease twin from the same slice behaves identically, so this is the family and not one
  // spell's quirk.
  assert.equal(dmg('You hit a sand giant for 181 points of disease damage by Plague.').skill, 'Plague')
  assert.equal(dmg('a sand giant has taken 188 damage from your Plague VI.').skill, 'Plague VI')
})

// ── the engine half: a synthesized fight, replayed for real ───────────────────────────────

/**
 * One cast of Envenomed Bolt VI, its landing, and four ticks — shapes from the slice, mob
 * swapped, numbers chosen to be hand-checkable. The cast line is LOAD-BEARING and not decoration:
 * without it the landing has no own-cast record and JOS-167's detector would file it as a
 * cast-less firing under `Envenomed Bolt · proc`, which is a different lane on purpose.
 */
const WINDOW: string[] = [
  '[Tue Aug 11 21:02:40 2026] You have entered Lake of Ill Omen.',
  '[Tue Aug 11 21:02:42 2026] You begin casting Envenomed Bolt VI.',
  '[Tue Aug 11 21:02:43 2026] You hit a sand giant for 50 points of poison damage by Envenomed Bolt.',
  '[Tue Aug 11 21:02:47 2026] a sand giant has taken 400 damage from your Envenomed Bolt VI.',
  '[Tue Aug 11 21:02:53 2026] a sand giant has taken 400 damage from your Envenomed Bolt VI.',
  '[Tue Aug 11 21:02:59 2026] a sand giant has taken 1200 damage from your Envenomed Bolt VI. (Critical)',
  '[Tue Aug 11 21:03:05 2026] a sand giant has taken 200 damage from your Envenomed Bolt VI.',
  '[Tue Aug 11 21:03:07 2026] You slash a sand giant for 300 points of damage.'
]

/** Replay a window and hand back YOUR outgoing SourceView from the fight it produced. */
function youView(lines: string[]): SourceView {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  const at = lastTs + 600_000
  const seg = eng.snapshot(at, { maxSegments: 100 }).segments.find((s) => s.kind !== 'zone')
  assert.ok(seg, 'the window produced no fight segment')
  const view = eng.snapshot(at, { selectedId: seg.id }).selected
  assert.ok(view, 'the fight has no selected view')
  const you = view.entities.find((e) => e.id === 'you')
  assert.ok(you, 'you landed nothing in the window')
  return you
}

/** Every (category, skill) lane the ENGINE filed, flattened — i.e. the list before grouping. */
function engineLanes(you: SourceView): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of you.categories) for (const s of c.skills) out.set(`${c.category}|${s.name}`, s.total)
  return out
}

test('D2: THE REPORTED BUG — the engine really does file one spell as two lanes', () => {
  const lanes = engineLanes(youView(WINDOW))
  // This is the defect, reproduced: 2,200 points of one spell, split across two rows whose only
  // difference is which sentence the game printed. Asserted so the fix below cannot be mistaken
  // for the split never having existed.
  assert.equal(lanes.get('spell|Envenomed Bolt'), 50)
  assert.equal(lanes.get('dot|Envenomed Bolt VI'), 2200)
  assert.equal(lanes.get('melee|Melee'), 300)
  // The proc marker is ABSENT: the cast line was seen, so the landing is a cast, not a proc.
  assert.equal(lanes.has('spell|Envenomed Bolt · proc'), false)
})

test('D3: the meter shows ONE row for the spell, with both components inside it', () => {
  const you = youView(WINDOW)
  const rows = flattenSkills(you)

  assert.deepEqual(
    rows.map((r) => r.name),
    ['Envenomed Bolt VI', 'Melee'],
    'one bar for the spell, one for the weapon'
  )

  const bolt = rows[0]
  // The rank-bearing spelling wins the label — it is the one the user pressed.
  assert.equal(bolt.name, 'Envenomed Bolt VI')
  // The DoT is the larger half, so the row reads (and colors) as a DoT.
  assert.equal(bolt.category, 'dot')
  assert.equal(bolt.total, 2250, '50 direct + 2,200 over time')
  assert.equal(bolt.hits, 5, '1 landing + 4 ticks')
  assert.equal(bolt.crits, 1)
  assert.equal(bolt.max, 1200, 'the biggest single application, wherever it came from')
  assert.equal(bolt.min, 50, 'the smallest LANDED one — the direct component')

  // The split is one click down, and the row says so on its face.
  assert.equal(bolt.childKind, 'component')
  assert.deepEqual(
    bolt.children?.map((c) => [c.category, c.name, c.total]),
    [
      ['dot', 'Envenomed Bolt VI', 2200],
      ['spell', 'Envenomed Bolt', 50]
    ],
    'both components survive, named and categorized exactly as the engine filed them'
  )
  // ...and the click works. A DoT tick is normally inert (JOS-113); a GROUP never is, or
  // collapsing the bars would have hidden what they said.
  assert.equal(abilityExpandable(bolt, null), true)
})

test('D4: grouping conserves every point and every count', () => {
  const you = youView(WINDOW)
  const before = you.categories.flatMap((c) => c.skills)
  const rows = flattenSkills(you)
  const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0)
  assert.equal(sum(rows.map((r) => r.total)), sum(before.map((s) => s.total)))
  assert.equal(sum(rows.map((r) => r.hits)), sum(before.map((s) => s.hits)))
  assert.equal(sum(rows.map((r) => r.crits)), sum(before.map((s) => s.crits)))
  // The authoritative bar is the ENGINE's and it did not move: the source total still equals the
  // sum of its lanes, so nothing here can be double-counting.
  assert.equal(you.total, sum(before.map((s) => s.total)))
})

// ── the rules, stated one at a time ───────────────────────────────────────────────────────

function row(name: string, category: DamageCategory, over: Partial<SkillRow> = {}): SkillRow {
  return { name, category, total: 0, pct: 0, hits: 0, crits: 0, max: 0, ...over }
}

const names = (rows: SkillRow[]): string[] => rows.map((r) => r.name)

test('D5: JOS-167 survives — a cast lane and its `· proc` twin stay TWO rows', () => {
  // The marker is a suffix no rank tail can sit behind, so the two key apart for free. This is
  // the one merge that would undo a feature the owner asked for.
  const out = groupSpellComponents([
    row('Envenomed Bolt', 'spell', { total: 300, hits: 3 }),
    row('Envenomed Bolt · proc', 'spell', { total: 900, hits: 9 })
  ])
  assert.deepEqual(names(out).sort(), ['Envenomed Bolt', 'Envenomed Bolt · proc'])
  assert.equal(out.every((r) => r.children === undefined), true)
})

test('D6: only spell and dot rows are eligible — a weapon lane is never folded into a spell', () => {
  // A melee lane is named after a VERB. If a spell ever shares that name, folding them would be a
  // lie about a lane rather than a merge of two descriptions of one cast.
  const out = groupSpellComponents([
    row('Bash', 'melee', { total: 1000, hits: 20 }),
    row('Bash', 'spell', { total: 500, hits: 5 }),
    row('Sand Storm', 'ds', { total: 200, hits: 10 }),
    row('Sand Storm', 'dot', { total: 400, hits: 4 })
  ])
  assert.equal(out.length, 4, 'nothing merged')
  assert.equal(out.every((r) => r.children === undefined), true)
})

test('D7: a lone row is left exactly as it is, and unrelated spells never touch', () => {
  const input = [
    row('Asystole', 'dot', { total: 1288, hits: 10 }),
    row('Drain Soul', 'spell', { total: 6713, hits: 9 })
  ]
  const out = groupSpellComponents(input)
  assert.deepEqual(out, input, 'no group means no copy and no reordering')
})

test('D8: the group takes the rank-bearing name and the larger half is its category', () => {
  // Direct-damage-heavy: the same merge, the other way up. The label still prefers the spelling
  // that carries the rank, because only one of the two shapes ever does.
  const out = groupSpellComponents([
    row('Ancient Wrath', 'spell', { total: 9000, hits: 6, crits: 2, max: 2000, min: 1200 }),
    row('Ancient Wrath III', 'dot', { total: 300, hits: 3, max: 110, min: 90 })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'Ancient Wrath III')
  assert.equal(out[0].category, 'spell', 'the bigger half colors the row')
  assert.equal(out[0].total, 9300)
  assert.equal(out[0].min, 90)
  assert.equal(out[0].max, 2000)
  assert.equal(out[0].pct, 100, 'the merged row re-bases the list it now tops')
})

test('D9: a resist-only lane merges without pulling the group minimum to zero', () => {
  // `Dooming Darkness` in the reporter's slice: a dot lane with damage, plus a resist-created
  // spell lane with none. Merging them is what finally puts the spell's resists on the spell's
  // row — and the group's `min` must still be the smallest LANDED tick, never the empty lane's 0.
  const out = groupSpellComponents([
    row('Dooming Darkness', 'dot', { total: 140, hits: 7, max: 25, min: 15 }),
    row('Dooming Darkness', 'spell', { total: 0, hits: 0, max: 0, min: 0, resists: 3 })
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].min, 15)
  assert.equal(out[0].resists, 3)
  assert.equal(out[0].total, 140)
})

test('D10: three shapes of one spell collapse just as two do, ranked inside', () => {
  const out = groupSpellComponents([
    row('Plague', 'spell', { total: 732, hits: 2 }),
    row('Plague VI', 'dot', { total: 5470, hits: 22 }),
    row('Plague V', 'dot', { total: 100, hits: 1 })
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].children?.map((c) => c.name), ['Plague VI', 'Plague', 'Plague V'])
  assert.equal(out[0].total, 6302)
  assert.equal(out[0].children?.[0].pct, 100, 'children re-base on the largest child, not the parent')
})
