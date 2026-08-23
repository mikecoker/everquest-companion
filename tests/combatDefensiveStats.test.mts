// DEFENSIVE STATS — golden windows for block / parry / dodge / riposte, and for the riposte
// counter-swing's damage inside the melee breakdown (JOS-354).
//
// Two user reports, one ticket:
//   01KZZ1X6B3A82XF1PQ238EPP82 — "Is it currently possible to see how often I'm blocking, dodging,
//                                parrying, or reposting?"
//   01KZYKJPMBZ6G93AM7B2KXN7C3 — "Can we get our riposte damage broken out inside our Melee damage?"
//
// METHODOLOGY (AGENTS.md golden-window law): two spans of the REAL log, already committed for
// other features, replayed through the REAL parser + CombatEngine. Every expectation below is
// annotated with the grep that re-derives it from the committed fixture by hand.
//
//   w49-round-triple-backstab.log — the DEFENCE window. 42 swings aimed at you were avoided (30 of
//        them the mobs' own whiff, 12 by one of your four skills) and 39 landed. It is also the
//        honest degenerate case for the offensive half: BOTH of your riposte counter-swings that
//        window were themselves avoided, so the damage is a truthful 0 rather than an absent row.
//   w44-poison-slow-per-mob.log   — the RIPOSTE DAMAGE window. Twelve annotated counter-swings, six
//        of them landed, 445 points between them.
//
// LAW 8'S TRIPWIRE IS THE POINT OF THE LAST TEST. Riposte damage is an INDEX over damage the melee
// lanes already booked — the same standing every proc lane has — so the window's outgoing total
// must be byte-identical to the frozen figure combatRoundStats.test.mts pins, and the riposte
// figure must sit INSIDE the source's swing damage rather than beside it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFixture } from './harness.mts'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { defenseHeadline, defenseRows, riposteLine } from '../src/renderer/src/features/combat/defenseRows'
import type { SegmentView, SourceView } from '../src/shared/combat'

function replay(fixture: string): SegmentView {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of readFixture(fixture)) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  // The ZONE aggregate, so nothing depends on which pull a line landed in.
  const seg = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).selected
  assert.ok(seg, `${fixture}: no zone aggregate`)
  return seg
}

function you(seg: SegmentView): SourceView {
  const e = seg.entities.find((s) => s.kind === 'you')
  assert.ok(e, 'no You row')
  return e
}

// ── the defence window ──────────────────────────────────────────────────────────────────

test('D1: the four defensive skills are counted off the incoming rows, exactly as the log printed them', () => {
  const { defense } = replay('w49-round-triple-backstab.log')

  // HAND-DERIVED, one grep:
  //   grep -oE 'tries to [a-z]+ (on )?YOU, but [^!]+!' w49-round-triple-backstab.log
  //     | sed -E 's/tries to [a-z]+ (on )?YOU, but //' | sort | uniq -c
  //   → 7 YOU block! · 2 YOU dodge! · 1 YOU parry! · 2 YOU riposte! · 30 misses!
  assert.deepEqual(defense.avoided, { miss: 30, dodge: 2, parry: 1, riposte: 2, block: 7, absorb: 0 })
  assert.equal(defense.avoidedTotal, 42)

  // …and the denominator is SWINGS AT YOU and nothing else:
  //   grep -cE '^\[[^]]+\] .+ YOU for [0-9]+ points? of damage\.' → 39 landed weapon swings.
  // A mob's nuke or damage-shield tick is not a swing and must not appear here.
  assert.equal(defense.hits, 39)
  assert.equal(defense.swings, 81, 'swings = landed + avoided, and nothing else')
  assert.equal(defense.avoidedPct, (42 / 81) * 100)

  // THE FOUR ACTIVE DEFENCES ARE SEPARATED FROM THE REST. The mob's own whiff is not a skill of
  // yours, and folding it in would take 52% avoided and read it as a 52% defence rate.
  assert.equal(defense.defended, 12)
  assert.equal(defense.defendedPct, (12 / 81) * 100)
  assert.notEqual(Math.round(defense.defendedPct), Math.round(defense.avoidedPct))

  // Every rate is over the SAME denominator — the renderer never re-divides.
  for (const k of ['miss', 'dodge', 'parry', 'riposte', 'block', 'absorb'] as const) {
    assert.equal(defense.rates[k], (defense.avoided[k] / defense.swings) * 100, k)
  }
})

test('D2: the panel rows always show the four skills, and only ever ADD an outcome that happened', () => {
  const { defense } = replay('w49-round-triple-backstab.log')
  const rows = defenseRows(defense)

  // The four the reporter asked about, plus the mob's own whiff because this window has 30 of
  // them. NOT the rune row: nothing absorbed a blow here, and a zero there would say nothing
  // about the player at all.
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.label), ['Block', 'Dodge', 'Riposte', 'Parry'])

  // STACK-RANKED BY COUNT (JOS-361, owner: "the misses should be at the top here"). The window's
  // hand-counted tallies are miss 30, block 7, dodge 2, riposte 2, parry 1 — so the mob's own
  // whiff leads and the rows descend from there.
  assert.deepEqual(rows.map((r) => r.count), [30, 7, 2, 2, 1])
  assert.deepEqual(rows.map((r) => r.label), ['Missed you', 'Block', 'Dodge', 'Riposte', 'Parry'])
  // …and the two rows TIED at 2 keep the order the reporter named them in, so the block cannot
  // shuffle between two equal rows from one snapshot tick to the next (the sort is stable).
  assert.deepEqual(rows.filter((r) => r.count === 2).map((r) => r.label), ['Dodge', 'Riposte'])

  // A window with NO active defence at all still draws all four, at zero — the JOS-113 rule
  // ("Dragon Punch expands to 0% crit") said of the defensive panel. Ranking did not change WHAT
  // draws: the four simply sort to the bottom, under the one outcome that happened.
  const none = {
    ...defense,
    avoided: { miss: 5, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 },
    rates: { miss: 100, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 }
  }
  assert.deepEqual(defenseRows(none).map((r) => r.label), ['Missed you', 'Block', 'Dodge', 'Parry', 'Riposte'])

  // The headline carries its own denominator (law 11's spirit).
  assert.equal(defenseHeadline(defense), '52% of 81 swings at you avoided · 15% by block/parry/dodge/riposte')
})

test('D3: riposte is TWO facts, and a window where every counter-swing whiffed says so', () => {
  const { defense } = replay('w49-round-triple-backstab.log')
  const r = defense.riposte

  // The DEFENSIVE half: `grep -c 'but YOU riposte!'` = 2.
  assert.equal(r.events, 2)
  // The OFFENSIVE half: `grep -E '^\[[^]]+\] You .*\(Riposte'` = 2 lines, and BOTH are avoided
  // swings (one absorbed by the mob's rune, one a plain miss). So: two counters, none landed,
  // zero damage — stated, never hidden.
  assert.equal(r.swings, 2)
  assert.equal(r.hits, 0)
  assert.equal(r.damage, 0)
  assert.equal(r.pctOfSwingDamage, 0)
  // …and the mobs' own counters at you, the other end of the same annotation:
  //   grep -E '\(Riposte\)' | grep -cE '(YOU for|to .*YOU, but)' = 11.
  assert.equal(r.taken, 11)

  assert.equal(
    riposteLine(defense),
    'Riposte: 2 swings turned aside · 2 counter-swings (0 landed) for 0 damage - already inside your melee total, 0.0% of it'
  )
})

// ── the riposte-damage window ───────────────────────────────────────────────────────────

test('D4: riposte damage is broken out of the melee lanes it is already inside', () => {
  const seg = replay('w44-poison-slow-per-mob.log')
  const e = you(seg)
  assert.ok(e.roundStats)

  // HAND-DERIVED: `grep -cE '^\[[^]]+\] You .*\(Riposte'` = 12 annotated counter-swings; six of
  // them are damage lines (16 + 148 + 44 + 108 + 82 + 47 = 445) and six are `but miss! (Riposte)`.
  assert.equal(e.roundStats.ripostesGiven, 12)
  assert.equal(e.roundStats.riposteLanded, 6)
  assert.equal(e.roundStats.riposteDamage, 445)

  // …and the same numbers as the segment's defensive view reads them.
  assert.equal(seg.defense.riposte.swings, 12)
  assert.equal(seg.defense.riposte.hits, 6)
  assert.equal(seg.defense.riposte.damage, 445)

  // THE SUBSET CLAIM, asserted rather than asserted-in-a-comment: the riposte damage is INSIDE the
  // source's weapon-swing damage (melee + slay), never beside it. A `(Riposte Critical)` counter
  // is in there too, which is why the denominator is both categories and not the melee lane alone.
  const swingDamage = e.categories
    .filter((c) => c.category === 'melee' || c.category === 'slay')
    .reduce((n, c) => n + c.total, 0)
  assert.ok(swingDamage > 0)
  assert.ok(e.roundStats.riposteDamage < swingDamage, 'riposte damage is a share of the swing damage')
  assert.equal(seg.defense.riposte.pctOfSwingDamage, (445 / swingDamage) * 100)
})

test('LAW 8: breaking riposte damage out moved no damage total — the window is byte-identical', () => {
  // The frozen figures tests/combatRoundStats.test.mts pins for this window. Riposte damage is an
  // INDEX over damage already counted, so if either of these moved, it was accumulated twice.
  const w49 = replay('w49-round-triple-backstab.log')
  assert.equal(w49.outTotal, 9554)
  assert.equal(w49.inTotal, 3434)
  for (const e of [...w49.entities, ...w49.incoming]) {
    assert.equal(e.categories.reduce((s, c) => s + c.total, 0), e.total, `${e.name}: category sum drifted`)
  }
  // And the defensive view is pure arithmetic over the same aggregate: hits + avoided IS swings,
  // with no third bucket anywhere for a line to hide in.
  assert.equal(w49.defense.hits + w49.defense.avoidedTotal, w49.defense.swings)
})
