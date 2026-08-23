// WHAT IS MY BEST SPELL RIGHT NOW — the per-level efficiency ranking behind the Leveling tab's
// right-hand readout (JOS-445, owner ask 2026-08-22).
//
// "New at this level" answers what a level GAVE you. This answers the question a player actually has
// in front of a spell bar: of everything I already own, which one should I be casting? Same corpus,
// same joins, one different rule — and that rule is the whole of this file:
//
//   THE FIGURES ARE READ AT THE LEVEL BEING VIEWED, NOT AT THE LEVEL THE SPELL WAS GAINED.
//
// `UnlockSpell.metrics` is a snapshot at the gain level, which is the right number for an unlock
// card and the wrong one here: the wiki states `Garrison's Mighty Mana Shock` as
// `Decrease Hitpoints by 272 (L18) to 333 (L34)`, so a wizard reading his L18 nuke at 35 is holding
// 333 damage, not 272, and a table that ranked him on 272 would sell him the wrong spell. So the
// unlock dataset carries the LINES as well as the snapshot (`UnlockSpell.hpLines` / `clientHp`,
// JOS-445) and this file re-evaluates them through the same `spellMetricsAt` main used.
//
// THE CORPUS IS THE UNLOCK FOLD'S, DELIBERATELY. Rows are every spell any class in the loadout has
// gained AT OR BELOW the viewed level, taken from the same `(class, level)` pairs `unlocksAtLevel`
// reads (`shared/spellLevels.ts` parsed them once, main-side). Re-deriving class placement from the
// wiki's `classes` prose would be a second parser for a sentence this repo already parses, and the
// two would drift the first time a correction landed on one of them.
//
// WHAT IT INHERITS WITHOUT RE-DECIDING:
//   * the ERA FOLD — `UnlockSpell.outOfEra` is `true` or absent, and a positive verdict goes to the
//     side's `outOfEra` list for the caller to put behind a disclosure. Silence is not a verdict
//     (law 1): a spell the sidecar never answered for is shown plainly, exactly as UnlockList does.
//   * the LOADOUT RULES — `comboClassSet` is the queried set, an unresolved slot only widens it, and
//     an unknown loadout answers empty rather than ranking the whole game.
//   * the CAVEATS — these are base figures with no crits, focus, AA or resist in them
//     (spellMetrics.ts's header states them). The per-second figures ARE recast-aware sustained
//     ones (JOS-444): `UnlockSpell.recastMs` rides the wire resolved, so a re-evaluation here
//     divides by the same casting cycle main's own snapshot did. The panel says `directional`
//     once, like its neighbour.
//
// AND AN ABSENT FIGURE IS NEVER A ZERO. A spell with no healing line has no `hps`, which is not the
// same claim as `hps 0`; it is absent from the healing side entirely, and a null column value sorts
// LAST in both directions rather than being read as the worst answer.
//
// ── FOUR TABLES, NOT TWO (JOS-448, owner ask 2026-08-22) ───────────────────────────────────────
//
// "a section for dots / section for dd / section for heal / section for hot". The split is a
// PARTITION OF EACH SIDE ON A FLAG THE METRICS ALREADY STATE — `dot` for damage that arrives per
// tick, `hot` for healing that does, both written by `spellMetricsAt` and neither re-derived here.
// Nothing about the ranking changes: a table is still `{shown, outOfEra}` sorted on one column, and
// the two damage tables rank on `dps` while the two healing ones rank on `hps`.
//
// It is a real question rather than a filter for tidiness. A DoT's `dps` is its whole total spread
// over the duration it runs for, so it competes with a nuke on a measure neither spell is played on:
// you cast the nuke again and you do not re-cast the DoT until it drops. Ranking them apart lets
// each list be read the way it is actually used.
//
// A SPELL WITH BOTH A DAMAGE AND A HEALING SIDE IS IN TWO OF THE FOUR, exactly as it was in both
// sections before — one damage table and one healing table, never two of the same colour. A lifetap
// is damage-only before it ever reaches this file (`spellMetricsAt` owns that rule).
//
// ── AND EVERY ROW IS READ AT ITS MOTE RANK (JOS-447, owner ask 2026-08-23) ─────────────────────
//
// "in the table its showing 333 damage rather than the upgraded damage. to decide whether im going
// to use a different spell, i want to compare upgraded damage to the max i have of a different
// spell. then it would be nice to simulate upgrade of a separate spell to understand."
//
// So a row's figures are taken at `max(observed rank, simulated rank)`. The OBSERVED half is
// JOS-446's map, joined by spell LINE (`observedRankRow` strips the numeral, which is the only join
// that works against a catalog that spells ~1,800 of its ~1,900 lines without one). The SIMULATED
// half is the panel's slider, and MAX is what keeps the two honest together: a slider at IV must not
// pull a spell the log has watched you cast at VIII back down to IV.
//
// The arithmetic itself is not here and is not the item engine's either - `shared/spellScale.ts`
// holds it, fitted to the owner's own log, and its header carries the measurement and the two
// places the numbers this file prints will read LOW for a levelled spell.
//
// Pure, node-tested (tests/bestSpells.test.mts), RELATIVE value imports — the mobSearch precedent.

import type { ClassAbbr } from './classCombo'
import { comboClassSet, type ComboClasses, type LevelUnlockData, type UnlockSpell } from './levelUnlocks'
import { spellMetricsAt, type SpellMetrics } from './spellMetrics'
import { observedRankRow, type ObservedSpellRanksSnap } from './spellRanks'
import { effectiveSpellRank, normalizeSpellRank } from './spellScale'

/** Which of the seven numbers a table is ranked on. */
export type BestSpellColumn =
  | 'dps'
  | 'damage'
  | 'damagePerMana'
  | 'hps'
  | 'heal'
  | 'healPerMana'
  | 'mana'

/** The four answers the owner asked for, in the order he named them (JOS-448). */
export type BestSpellTab = 'dd' | 'dot' | 'heal' | 'hot'

/** The tabs, in draw order. The one vocabulary: sorts, columns and `bestSpellsAt` all key on it. */
export const TAB_ORDER: readonly BestSpellTab[] = ['dd', 'dot', 'heal', 'hot']

/** Tab labels, single-sourced so a test can pin the words. Game spellings, no em dashes. */
export const TAB_LABEL: Record<BestSpellTab, string> = {
  dd: 'DD',
  dot: 'DoT',
  heal: 'Heal',
  hot: 'HoT'
}

/** Which SIDE of the metrics a tab reads. Two tabs per side, split on the over-time flag. */
export const TAB_SIDE: Record<BestSpellTab, 'damage' | 'heal'> = {
  dd: 'damage',
  dot: 'damage',
  heal: 'heal',
  hot: 'heal'
}

/**
 * THE COLUMNS EACH TAB DRAWS, and why there are two lists rather than one seven-wide table.
 *
 * The readout lives in the Leveling tab's RIGHT column, which is a third of the row at `lg` and has
 * a 260px floor at the app's own minimum width. Seven numeric columns there is ~30px each, which is
 * not a table anybody can read. Every one of the seven is still present and still sortable — split
 * across the two SIDES, each holding the four that mean something for it. `mana` appears in both
 * because "what does this cost" is the same question either way.
 *
 * The four tabs are two per side, so the column set is the SIDE's: DD and DoT draw the damage four,
 * Heal and HoT the healing four. Splitting the columns further per tab would make the DoT table a
 * different shape from the DD table for no gain, and the tabs are already the thing that separates
 * them.
 *
 * The RANK column is the side's headline (`dps` / `hps`) and is the default sort, which is the
 * owner's ask read literally: best damage spells by dps, best healing by hps.
 */
export const SIDE_COLUMNS: Record<'damage' | 'heal', readonly BestSpellColumn[]> = {
  damage: ['dps', 'damage', 'mana', 'damagePerMana'],
  heal: ['hps', 'heal', 'mana', 'healPerMana']
}

/** The columns one tab draws: its side's, unchanged by the over-time split. */
export function tabColumns(tab: BestSpellTab): readonly BestSpellColumn[] {
  return SIDE_COLUMNS[TAB_SIDE[tab]]
}

/** The column a tab opens on. */
export const TAB_RANK_COLUMN: Record<BestSpellTab, BestSpellColumn> = {
  dd: 'dps',
  dot: 'dps',
  heal: 'hps',
  hot: 'hps'
}

/** Header text, single-sourced so a test can pin the words. No em dashes anywhere near a player. */
export const COLUMN_LABEL: Record<BestSpellColumn, string> = {
  dps: 'dps',
  damage: 'dmg',
  damagePerMana: 'dmg/mana',
  hps: 'hps',
  heal: 'heal',
  healPerMana: 'heal/mana',
  mana: 'mana'
}

/** The longer sentence behind a header, for the tooltip. Stated once, beside the label. */
export const COLUMN_TITLE: Record<BestSpellColumn, string> = {
  dps: 'sustained damage per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  damage: 'total base damage at this level, every tick included',
  damagePerMana: 'total damage divided by the mana it costs',
  hps: 'sustained healing per second over one casting cycle: the cast plus the longer of the duration and the re-use timer',
  heal: 'total base healing at this level, every tick included',
  healPerMana: 'total healing divided by the mana it costs',
  mana: 'what the spell costs to cast'
}

/** One ranked spell. `metrics` is read AT THE VIEWED LEVEL - the whole point of the file. */
export interface BestSpellRow {
  name: string
  /** The LOWEST level a class in the loadout gained it at - when it became yours. */
  gainedAt: number
  /** The loadout classes that have it at or below the viewed level, sorted. */
  classes: ClassAbbr[]
  /** The catalog's mana cost, or null when the page states none. Never 0 as a stand-in. */
  mana: number | null
  metrics: SpellMetrics
  /** The wiki badges this spell's page out of era. `false` is a real answer here; absent is not. */
  outOfEra: boolean
  /**
   * The mote rank `metrics` was evaluated at, 0..10 - `max(observed, simulated)` (JOS-447). 0 is the
   * base spell, and it is what every row reads before anybody touches the slider.
   */
  rank: number
  /** The rank the LOG has actually seen this line at, when it has seen one above base. 0 otherwise. */
  observedRank: number
}

/**
 * THE QUESTION THE READOUT IS BEING ASKED, beyond the level: how to sort each of the four tables,
 * and what to assume about mote ranks.
 *
 * One object rather than three parameters because the repo's factoring rule caps a function at
 * four and `bestSpellsAt` already spends three on the data, the loadout and the level. They belong
 * together anyway: all three are the READER's question, where the first three arguments are the
 * world. Only `sorts` is required; a view with no rank fields is the base reading this file gave
 * before JOS-447 existed, byte for byte.
 */
export interface BestSpellsView {
  sorts: Record<BestSpellTab, BestSpellSort>
  /** JOS-446's observed-rank map, joined by spell line key. Null before hydration, which is base. */
  observed?: ObservedSpellRanksSnap | null
  /**
   * The panel's simulate slider, 0..10. Every row is lifted to AT LEAST this rank; a row already
   * above it keeps its own (`effectiveSpellRank`), which is the owner's ask read literally.
   */
  simulate?: number
}

/** One tab's table, split the way `UnlockList` splits a level list. */
export interface BestSpellsTable {
  /** in-era and unknown, already sorted - what the table draws. */
  shown: BestSpellRow[]
  /** positively out of era, same sort - what the disclosure holds. */
  outOfEra: BestSpellRow[]
}

/** Which column a side is ranked on, and which way. */
export interface BestSpellSort {
  column: BestSpellColumn
  /** Descending is "best first" for six of the seven; `mana` is the one a reader may flip. */
  desc: boolean
}

/** The whole readout for one level and one loadout. */
export interface BestSpells {
  level: number
  /** the set the ranking ran over (may be empty) */
  classes: ClassAbbr[]
  /** true when the loadout was only narrowed: the rows are an UPPER BOUND, like every other join */
  ambiguous: boolean
  /** One table per tab, always all four - an empty tab is an honest answer, never a missing one. */
  tabs: Record<BestSpellTab, BestSpellsTable>
}

const emptyTables = (): Record<BestSpellTab, BestSpellsTable> => ({
  dd: { shown: [], outOfEra: [] },
  dot: { shown: [], outOfEra: [] },
  heal: { shown: [], outOfEra: [] },
  hot: { shown: [], outOfEra: [] }
})

/** The default sort for a tab: its own rank column, best first. */
export function defaultSort(tab: BestSpellTab): BestSpellSort {
  return { column: TAB_RANK_COLUMN[tab], desc: true }
}

/** All four defaults at once - the state a freshly mounted panel opens with. */
export function defaultSorts(): Record<BestSpellTab, BestSpellSort> {
  return { dd: defaultSort('dd'), dot: defaultSort('dot'), heal: defaultSort('heal'), hot: defaultSort('hot') }
}

/**
 * ONE ROW'S VALUE IN ONE COLUMN, or null when the spell states no such figure.
 *
 * Null and zero are different claims and the sort keeps them different (see `compareRows`): a heal
 * with no mana cost is not a heal that costs nothing to a ranking that would then crown it.
 */
export function columnValue(row: BestSpellRow, column: BestSpellColumn): number | null {
  if (column === 'mana') return row.mana
  return row.metrics[column] ?? null
}

/**
 * THE FIGURES FOR ONE CATALOG SPELL AT AN ARBITRARY LEVEL.
 *
 * It calls the SAME `spellMetricsAt` main called, with the SAME two sources in the same order (the
 * wiki's hitpoint lines, then the client's slots as a fallback), which is what makes a row here and
 * an unlock row at the gain level the same arithmetic rather than two derivations that agree today.
 * A spell whose lines never crossed the wire simply has no figures and no row.
 */
export function spellMetricsForLevel(
  spell: UnlockSpell,
  level: number,
  rank = 0
): SpellMetrics | undefined {
  const input = {
    effects: spell.hpLines,
    mana: spell.mana,
    castTimeMs: spell.castTimeMs,
    // Already RESOLVED main-side (page over client, a stated 0 blocking the fallback) — see
    // `writeFigures`. Passing it as the input field means `withRecast` never re-asks the client.
    recastMs: spell.recastMs,
    durationMs: spell.durationMs,
    targetType: spell.targetType,
    // The mote rank rides the same input for the same reason: `spellMetricsAt` resolves it once and
    // both of its folds scale by that one number (JOS-447).
    rank
  }
  return spellMetricsAt(input, level, spell.clientHp)
}

/**
 * The loadout classes that have this spell at or below `level`, and the level it first became
 * theirs. Null when nobody in the loadout owns it yet - the row does not exist at this level.
 */
function ownedBy(
  spell: UnlockSpell,
  want: ReadonlySet<string>,
  level: number
): { classes: ClassAbbr[]; gainedAt: number } | null {
  const lowest = new Map<ClassAbbr, number>()
  for (const p of spell.at) {
    if (p.level > level || !want.has(p.cls)) continue
    const seen = lowest.get(p.cls)
    if (seen === undefined || p.level < seen) lowest.set(p.cls, p.level)
  }
  if (lowest.size === 0) return null
  return {
    classes: [...lowest.keys()].sort((a, b) => a.localeCompare(b)),
    gainedAt: Math.min(...lowest.values())
  }
}

/** A duplicate wiki page for a spell already in the fold: it can only widen the row, never add one. */
function mergeOwned(row: BestSpellRow, owned: { classes: ClassAbbr[]; gainedAt: number }): void {
  const classes = new Set([...row.classes, ...owned.classes])
  row.classes = [...classes].sort((a, b) => a.localeCompare(b))
  row.gainedAt = Math.min(row.gainedAt, owned.gainedAt)
}

/**
 * Every owned spell that has ANY figure at this level, folded BY NAME.
 *
 * By name for `spellRows`'s reason, unchanged: the wiki genuinely carries a few spells twice, and a
 * duplicate page would put the same spell in the table two rows apart. The first record wins, and
 * a later record of the same name only widens the class list - it is the same spell.
 */
function ownedRows(
  data: LevelUnlockData,
  want: ReadonlySet<string>,
  level: number,
  view: BestSpellsView
): BestSpellRow[] {
  const simulate = normalizeSpellRank(view.simulate)
  const byName = new Map<string, BestSpellRow>()
  for (const spell of data.spells) {
    const owned = ownedBy(spell, want, level)
    if (!owned) continue
    const key = spell.name.toLowerCase()
    const seen = byName.get(key)
    if (seen) {
      mergeOwned(seen, owned)
      continue
    }
    // JOS-446's map is keyed by spell LINE, so the join is the display name and `observedRankRow`
    // strips the numeral - the catalog spells ~1,800 of its rows with no numeral at all.
    const observedRank = normalizeSpellRank(observedRankRow(view.observed, spell.name)?.rank)
    const rank = effectiveSpellRank(observedRank, simulate)
    const metrics = spellMetricsForLevel(spell, level, rank)
    if (!metrics) continue
    byName.set(key, {
      name: spell.name,
      gainedAt: owned.gainedAt,
      classes: owned.classes,
      mana: typeof spell.mana === 'number' && spell.mana > 0 ? spell.mana : null,
      metrics,
      outOfEra: spell.outOfEra === true,
      rank,
      observedRank
    })
  }
  return [...byName.values()]
}

/**
 * Two rows compared on one column. NULLS LAST IN BOTH DIRECTIONS, then name ascending.
 *
 * Nulls last is the honest reading of an absent figure and it is also what keeps a flip usable: a
 * reader sorting ascending by `dmg/mana` wants the cheapest spell that HAS a ratio at the top, not
 * a run of spells the catalog states no mana for. Name is the tie-break so the order is total - two
 * spells with the same dps must not swap places when the level ticks.
 */
function compareRows(a: BestSpellRow, b: BestSpellRow, sort: BestSpellSort): number {
  const av = columnValue(a, sort.column)
  const bv = columnValue(b, sort.column)
  if (av === null || bv === null) {
    if (av !== bv) return av === null ? 1 : -1
  } else if (av !== bv) {
    return sort.desc ? bv - av : av - bv
  }
  return a.name.localeCompare(b.name)
}

/** The same sort the table applies, exported so a caller can re-rank without rebuilding the rows. */
export function sortBestSpells(rows: readonly BestSpellRow[], sort: BestSpellSort): BestSpellRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort))
}

/**
 * WHICH TAB A SPELL BELONGS IN, asked once per tab per row.
 *
 * The presence of the SIDE's total decides whether the row exists at all, and the side's over-time
 * flag decides which of that side's two tabs holds it. The flag is read POSITIVELY on the tick
 * tables and as "not true" on the instant ones, so a metrics record that states nothing lands in DD
 * or Heal rather than vanishing between the two - the same reading `outOfEra` gets everywhere in
 * this app (silence is not a verdict, law 1).
 */
const TAB_MEMBER: Record<BestSpellTab, (m: SpellMetrics) => boolean> = {
  dd: (m) => m.damage !== undefined && m.dot !== true,
  dot: (m) => m.damage !== undefined && m.dot === true,
  heal: (m) => m.heal !== undefined && m.hot !== true,
  hot: (m) => m.heal !== undefined && m.hot === true
}

/** One tab's rows, split by the era rule and sorted. `has` says which figure puts a row here. */
function tableOf(
  rows: readonly BestSpellRow[],
  has: (m: SpellMetrics) => boolean,
  sort: BestSpellSort
): BestSpellsTable {
  const shown: BestSpellRow[] = []
  const outOfEra: BestSpellRow[] = []
  for (const row of rows) {
    if (!has(row.metrics)) continue
    ;(row.outOfEra ? outOfEra : shown).push(row)
  }
  return { shown: sortBestSpells(shown, sort), outOfEra: sortBestSpells(outOfEra, sort) }
}

/**
 * THE WHOLE READOUT. Pure over the dataset, the loadout, the level and the four sorts - so the panel
 * re-ranks by calling this again and nothing is cached that could disagree with what is drawn.
 *
 * A spell that both damages and heals appears in one DAMAGE tab AND one HEALING tab, which is the
 * honest answer: it really is a candidate for either job. It can never be in both tabs of one side,
 * because a side's over-time flag is one boolean. A lifetap reaches only the damage tabs, because
 * `spellMetricsAt` already refuses to read the caster's own recovery as healing (its header says
 * why).
 */
export function bestSpellsAt(
  data: LevelUnlockData,
  combo: ComboClasses,
  level: number,
  view: BestSpellsView
): BestSpells {
  const classes = comboClassSet(combo)
  const base = { level, classes, ambiguous: combo.ambiguous }
  if (classes.length === 0 || !Number.isFinite(level)) {
    return { ...base, classes: [], tabs: emptyTables() }
  }
  const rows = ownedRows(data, new Set<string>(classes), level, view)
  const tabs = emptyTables()
  for (const tab of TAB_ORDER) tabs[tab] = tableOf(rows, TAB_MEMBER[tab], view.sorts[tab])
  return { ...base, tabs }
}
