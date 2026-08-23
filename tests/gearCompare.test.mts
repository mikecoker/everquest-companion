// THE GEAR TAB'S COMPARISON (JOS-338) — the slot join and every word the card says, pinned without
// a DOM.
//
// TWO HALVES, and they are pinned differently on purpose.
//
// 1. THE JOIN AND THE WORDS are pure (`src/renderer/src/features/gear/gearCompare.ts`, the
//    `gearOwnership.ts` precedent), so they are driven here against the REAL committed dump —
//    `tests/fixtures/Primitive_freeport-Inventory.txt`, the dev character's own 295-line
//    `/outputfile inventory`, the same witness `tests/plannerInventory.test.mts` reads. Nothing in
//    this half is hand-authored: the expectations below are lines out of that file, so a fixture
//    that is ever re-cut turns this red rather than the UI.
//
// 2. THE CARD'S SAFETY IS STRUCTURAL and is derived from the TREE, the way
//    `tests/tooltipCursor.test.mts` derives the Sky tab's (JOS-181). The gear rows sit under a
//    toolbar full of dropdowns, which is the exact shape of the JOS-127/JOS-143 defect, so what has
//    to be true is not "the card behaves" but "no call site can make it misbehave": one door, three
//    guarantees on that door, and no second popper anywhere in the feature. The BEHAVIOUR half is
//    measured in the browser by `tests/e2e/gearCompareSteps.mts`, which hit-tests the toolbar, the
//    wish heart and the name link with the card open.
//
// The guards live here rather than in tooltipCursor.test.mts deliberately: that file's own JOS-181
// block pins `KnownItemTooltip` by source regex, and this feature copies those mechanics rather
// than importing them (GearCompareCard.tsx's header states why). Two copies of a guarantee want two
// pins, each beside the copy it is about.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseInventoryDump } from '../src/main/outputs/inventoryParse'
import { equippedHosts, type PlannerInventoryHost } from '../src/shared/planner/inventorySlots'
// `ownershipKey` IS `itemTierKey` IS main's `itemKey` — the three are pinned together by
// tests/ownership.test.mts, and this one is the copy a node test can import without pulling the
// 8.6 MB corpus in behind it.
import { ownershipKey } from '../src/shared/planner/ownership'
import type { GearStats } from '../src/shared/planner/gear'
import {
  compareStats,
  compareText,
  dumpFreshnessText,
  equippedCells,
  equippedIndex,
  equippedState,
  hostText,
  statPairText
} from '../src/renderer/src/features/gear/gearCompare'

const ROOT = join(import.meta.dirname, '..')
const GEAR = join(ROOT, 'src', 'renderer', 'src', 'features', 'gear')

const REAL_DUMP = readFileSync(join(import.meta.dirname, 'fixtures', 'Primitive_freeport-Inventory.txt'), 'utf8')
/** The dump's hosts as MAIN serves them: `equippedHosts` plus the item key (ipc/planner.ts). */
const HOSTS: PlannerInventoryHost[] = equippedHosts(parseInventoryDump(REAL_DUMP)).map((h) => ({
  ...h,
  key: ownershipKey(h.name)
}))
const INDEX = equippedIndex(HOSTS)

// ---- the join, over the owner's real dump ------------------------------------------------

test('a one-slot item is compared against the one cell it would go in', () => {
  const cells = equippedCells(INDEX, ['PRIMARY'])
  assert.equal(cells.length, 1)
  assert.equal(cells[0].cell, 'PRIMARY')
  assert.equal(cells[0].label, 'PRIMARY')
  // `Primary  Thelvorn, Blade of Light +5` — line 15 of the committed dump.
  assert.equal(cells[0].host?.name, 'Thelvorn, Blade of Light')
  assert.equal(cells[0].host?.tier, 5)
  assert.equal(cells[0].host?.key, 'thelvorn, blade of light')
})

test('an item that states TWO slots is compared against both, in the ITEM’s own order', () => {
  const cells = equippedCells(INDEX, ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(cells.map((c) => c.cell), ['PRIMARY', 'SECONDARY'])
  assert.equal(cells[0].host?.name, 'Thelvorn, Blade of Light')
  assert.equal(cells[1].host?.name, 'Whitened Treant Fists')
  // …and the other way round, because the order is the item's statement and not the board's.
  assert.deepEqual(
    equippedCells(INDEX, ['SECONDARY', 'PRIMARY']).map((c) => c.cell),
    ['SECONDARY', 'PRIMARY']
  )
})

test('a paired slot is TWO cells, and they hold the two different things you wear', () => {
  const ears = equippedCells(INDEX, ['EAR'])
  assert.deepEqual(ears.map((c) => c.cell), ['EAR', 'EAR2'])
  // The labels are `planSlotLabel`'s, so a card never draws "EAR" twice and calls it a comparison.
  assert.deepEqual(ears.map((c) => c.label), ['EAR 1', 'EAR 2'])
  // Both `Ear` rows of the dump, in the client's own file order (JOS-67's rule, inherited).
  assert.deepEqual(ears.map((c) => c.host?.name), [
    'Drop of Crystallized Flame',
    'Earring of Disease Reflection'
  ])
  const fingers = equippedCells(INDEX, ['FINGER'])
  assert.deepEqual(fingers.map((c) => c.host?.name), ["Djarn's Amethyst Ring", 'Ring of Pureblood'])
})

test('the cells are DEDUPED — a slot stated twice is still one comparison', () => {
  assert.deepEqual(equippedCells(INDEX, ['PRIMARY', 'PRIMARY']).map((c) => c.cell), ['PRIMARY'])
  assert.deepEqual(equippedCells(INDEX, ['EAR', 'EAR']).map((c) => c.cell), ['EAR', 'EAR2'])
})

test('a cell the dump says is EMPTY reads as nothing equipped, not as a missing answer', () => {
  // `Ammo  Empty` is a real line in the committed dump: the client prints every location it has.
  const ammo = equippedCells(INDEX, ['AMMO'])
  assert.equal(ammo.length, 1)
  assert.equal(ammo[0].host, null)
})

test('the two ANY cells are never compared, however much they are wearing', () => {
  // The owner's dump wears `Brigandine Tunic +1` and `Midnight Clad Straps +2` in the two `Any
  // Slot` places, and BOTH are chest items — so a card that included any-cells would put a
  // breastplate under a hovered ring. Decision 3 of gearCompare.ts.
  const chest = equippedCells(INDEX, ['CHEST'])
  assert.deepEqual(chest.map((c) => c.cell), ['CHEST'])
  assert.equal(chest[0].host?.name, 'Red Dragonscale Armor')
  const anyWorn = HOSTS.filter((h) => h.slot === 'ANY1' || h.slot === 'ANY2').map((h) => h.name)
  assert.deepEqual(anyWorn, ['Brigandine Tunic +1', 'Midnight Clad Straps +2'].map((n) => n.replace(/ \+\d+$/, '')))
})

test('with NO dump the cells still exist and every one of them is unanswered', () => {
  const empty = equippedCells(equippedIndex([]), ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(empty.map((c) => c.cell), ['PRIMARY', 'SECONDARY'])
  assert.deepEqual(empty.map((c) => c.host), [null, null])
})

test('the worn copy is read at the tier its NAME states, and at no banked fraction', () => {
  const thelvorn = INDEX.get('PRIMARY')
  assert.ok(thelvorn)
  assert.deepEqual(equippedState(thelvorn), { full: 5, fraction: 0 })
  assert.equal(hostText(thelvorn), 'Thelvorn, Blade of Light +5')
  // A name that stated no `+N` is BASE, never `+0` — the dump said nothing, so neither do we.
  const shoulders = INDEX.get('SHOULDERS')
  assert.ok(shoulders)
  assert.equal(shoulders.tier, undefined)
  assert.deepEqual(equippedState(shoulders), { full: 0, fraction: 0 })
  assert.equal(hostText(shoulders), 'Pauldrons of Power')
})

// ---- the numbers -------------------------------------------------------------------------

const CANDIDATE: GearStats = { AC: 20, HP: 55, HASTE: 41, DMG: 12 }
const WORN: GearStats = { AC: 32, HP: 55, DMG: 18, SV_FIRE: 10 }

test('a key BOTH sides state gets a delta, and one only one side states does not', () => {
  const rows = compareStats(CANDIDATE, WORN)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  assert.deepEqual(byKey.get('AC'), { key: 'AC', item: 20, equipped: 32, delta: -12 })
  assert.deepEqual(byKey.get('HASTE'), { key: 'HASTE', item: 41 })
  assert.deepEqual(byKey.get('SV_FIRE'), { key: 'SV_FIRE', equipped: 10 })
  assert.equal(byKey.get('HASTE')?.delta, undefined, 'an absent value is not zero (law 1)')
})

test('a key both sides state at the same value is left out — the card is about what CHANGES', () => {
  assert.equal(
    compareStats(CANDIDATE, WORN).some((r) => r.key === 'HP'),
    false
  )
})

test('…but with no equipped side every stated key survives, in the corpus’s own order', () => {
  const rows = compareStats(CANDIDATE, null)
  assert.deepEqual(rows.map((r) => r.key), ['AC', 'HP', 'HASTE', 'DMG'])
  assert.deepEqual(rows.map((r) => r.item), [20, 55, 41, 12])
  assert.equal(rows.every((r) => r.equipped === undefined && r.delta === undefined), true)
})

test('the words: a signed delta where there is one, and the word none where a page said nothing', () => {
  const rows = compareStats(CANDIDATE, WORN)
  const text = new Map(rows.map((r) => [r.key, compareText(r)]))
  assert.equal(text.get('AC'), 'AC 20 vs 32 (-12)')
  assert.equal(text.get('DMG'), 'DMG 12 vs 18 (-6)')
  assert.equal(text.get('HASTE'), 'HASTE 41% vs none', 'the percent spelling is the table’s own')
  assert.equal(text.get('SV_FIRE'), 'SV FIRE none vs 10', 'the underscore is a key’s spelling, not a word')
  // The other direction, so the sign is proved both ways rather than assumed.
  assert.equal(compareText({ key: 'AC', item: 40, equipped: 32, delta: 8 }), 'AC 40 vs 32 (+8)')
  assert.equal(statPairText('HASTE', 41), 'HASTE 41%')
  assert.equal(statPairText('AC', 20), 'AC 20')
})

test('the freshness line is JOS-253’s own words, and says which clock it is', () => {
  const now = Date.parse('2026-08-13T12:00:00Z')
  assert.equal(dumpFreshnessText(undefined, now), 'your inventory dump · not yet run')
  assert.equal(
    dumpFreshnessText(now - 3 * 24 * 3_600_000, now),
    'your inventory dump · updated 3d ago',
    'the age comes from outputAgeLabel — this card never formats a second copy of it'
  )
})

// ---- the card cannot eat a click (JOS-143 / JOS-181, derived from the tree) ---------------

const CARD = readFileSync(join(GEAR, 'GearCompareCard.tsx'), 'utf8')
const TABLE = readFileSync(join(GEAR, 'GearTable.tsx'), 'utf8')
/** JOS-344's second host: the Exaltations browser's donor rows, through the SAME door. */
const ROWS = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'features', 'planner', 'EffectRows.tsx'), 'utf8')

test('the gear rows reach a card through ONE door, and the table opens no other popper', () => {
  assert.match(TABLE, /<GearRowCompare\b/, 'the table mounts the wrapper')
  assert.equal((TABLE.match(/<GearRowCompare\b/g) ?? []).length, 1, 'exactly once')
  assert.ok(!/from '@mui\/material\/Tooltip'/.test(TABLE), 'never MUI’s Tooltip directly')
  assert.ok(!/from '.*lib\/Tooltip'/.test(TABLE), 'nor the shared wrapper — the door is the wrapper')
  assert.ok(!/<KnownItemTooltip[\s>]/.test(TABLE), 'nor the generic item card, which is interactive')
})

test('the donor rows reach the SAME door, and grow no card of their own (JOS-344)', () => {
  assert.match(ROWS, /<GearRowCompare\b/, 'the donor name mounts the wrapper')
  assert.equal((ROWS.match(/<GearRowCompare\b/g) ?? []).length, 1, 'exactly once')
  assert.ok(!/from '@mui\/material\/Tooltip'/.test(ROWS), 'never MUI’s Tooltip directly')
  assert.ok(!/<KnownItemTooltip[\s>]/.test(ROWS), 'nor the generic item card, which is interactive')
  // The row's OTHER tooltip is the `+N to extract` chip's caption, and it is the shared wrapper —
  // a caption is not a card. What must never appear is a second COMPARE card built by hand.
  assert.ok(!/<GearComparePair\b/.test(ROWS), 'the pair is only ever reached through the door')
})

test('the door still MEANS all three things it was introduced to mean', () => {
  // 1. IT CANNOT OPEN UPWARD, AND IT CANNOT OPEN OFF SCREEN (JOS-344, rewriting JOS-338's spelling
  //    of this guarantee — read GearCompareCard.tsx's measurement block before touching either
  //    axis). For a BOTTOM-based placement popper's `mainAxis` is the HORIZONTAL one, so these
  //    three lines together say: clamped sideways, never moved vertically, never flipped.
  assert.match(CARD, /placement="bottom-start"/)
  assert.match(CARD, /name: 'flip', enabled: false/)
  assert.match(CARD, /mainAxis: true, altAxis: false/)
  // …and the anchor's right edge — the thing that put JOS-338's card 3px inside the window — is
  // read by nothing. `right-start` off a full-width row IS the bug; it may not come back.
  assert.ok(!/placement="right-start"/.test(CARD), 'the row’s right edge is never the anchor again')
  // 2. it holds no pointer events — stated, not inherited from MUI's disableInteractive default.
  assert.match(CARD, /pointerEvents: 'none'/)
  assert.match(CARD, /disableInteractive/)
  // 3. it is gone before the control the user aimed at opens its own list.
  assert.match(CARD, /addEventListener\('pointerdown', onClose, true\)/)
  // …and the JOS-293 leave discipline, which is what keeps a dense table from flickering cards.
  assert.match(CARD, /enterDelay=\{\d+\}/)
  assert.match(CARD, /leaveDelay=\{\d+\}/)
})

test('the comparison is TWO cards, side by side, item first (JOS-344)', () => {
  // The owner's ruling as a fact about the tree: one row, never wrapping, item card then equipped
  // card. The x-order is MEASURED in tests/e2e/gearCompareSteps.mts; what is pinned here is that
  // nothing can reorder them without editing this line.
  const pair = /<div data-testid="gear-compare-pair"[\s\S]*?<\/div>/.exec(CARD)?.[0] ?? ''
  assert.ok(pair !== '', 'the pair exists')
  const item = pair.indexOf('<GearCompareCard')
  const equipped = pair.indexOf('<EquippedCompareCard')
  assert.ok(item >= 0 && equipped > item, `item card must come first — got ${item} / ${equipped}`)
  assert.match(CARD, /flexDirection: 'row'/)
  assert.match(CARD, /flexWrap: 'nowrap'/)
  // A pair wider than the window cannot be clamped onto it, so the pair states its own ceiling.
  assert.match(CARD, /maxWidth: 'calc\(100vw - \d+px\)'/)
  // THE FRESHNESS LINE STAYS, and it stays on the card whose claim it dates.
  const equippedCard = CARD.slice(CARD.indexOf('function EquippedCompareCard'))
  assert.match(equippedCard, /data-testid="gear-compare-freshness"/)
  assert.match(equippedCard, /dumpFreshnessText\(data\.exportedAt\)/)
})

test('nothing ELSE in features/gear mounts a popper — least of all the dropdown toolbar', () => {
  // The derived JOS-143 rule, applied inside this feature: `GearFilterBar` is five dropdowns and a
  // slider, and a card anchored anywhere in it would open over its own option lists.
  const offenders = ['GearFilterBar.tsx', 'GearPickers.tsx', 'GearView.tsx', 'UpgradeSlider.tsx'].filter((name) => {
    const src = readFileSync(join(GEAR, name), 'utf8')
    return /from '.*lib\/Tooltip'/.test(src) || /<Tooltip[\s>]/.test(src) || /<KnownItemTooltip[\s>]/.test(src)
  })
  assert.deepEqual(offenders, [], `a hover card can open over the gear toolbar in: ${offenders.join(', ')}`)
})
