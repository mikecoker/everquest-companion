// BEST AT THIS LEVEL — the Leveling tab's right-hand efficiency readout (JOS-445).
//
// "New at this level" says what a level GAVE you. This says what to cast: of everything the loadout
// already owns, ranked at the level being viewed. The arithmetic is all in `shared/bestSpells.ts`
// (pure, node-tested); this file decides only how it is drawn.
//
// FOUR TABLES BEHIND FOUR TABS (JOS-448, owner ask 2026-08-22: "i want a section for dots/section
// for dd/section for heal/section for hot - tabs is probably the right metaphor in the panel").
//
// This column is a third of the row at `lg` with a 260px floor at the app's own minimum width, so
// seven numeric columns is ~30px each and reads as nothing. `SIDE_COLUMNS` splits them four and four
// (mana in both, because "what does it cost" is the same question either way) and the four tabs are
// two per side, so a tab always draws its side's four.
//
// THE STACK BECAME A PICKER, and that is the trade the owner named. Two sections drawn at once was
// right when there were two: the page is the scroller here (JOS-289) so vertical space was the cheap
// axis, and nothing was hidden behind a click. Four sections of up to ten rows each is a column of
// eighty rows, which is a scroll rather than a readout. Tabs spend one click to buy back the height,
// and the count on every label means the tabs you are NOT looking at still tell you whether there is
// anything in them.
//
// EACH TAB KEEPS ITS OWN SORT, which is what makes "best DD by dps AND best HoT by hps" a default
// state rather than a thing to set up, and what makes flipping to `dmg/mana` on the DoT table not
// disturb the DD one. The SELECTION itself is deliberately NOT persisted: a glance away and back
// should show the readout's default answer, not the last question somebody asked it.
//
// IT IS NOT GATED ON THE CHARTS, and that is the placement rule (owner, 2026-08-22: the readout
// belongs on the right side of the panel). Its neighbour below, `LedgerColumn`, is every panel that
// reads a SCOPE and therefore needs a chartable log; this one needs no log at all beyond the
// loadout, exactly like `NewAtLevelPanel`. A fresh character with two dings still wants to know
// which nuke is his best. So the right column exists whenever EITHER is drawable and this sits at
// the top of it.
//
// THE LEVEL IS THE TAB'S, NOT THIS PANEL'S. `LevelingView` owns the viewed level and hands the same
// number to this panel and to the stepper inside `NewAtLevelPanel` — one control, two readouts. Two
// steppers would be two levels on one screen and no way to tell which one a table is about.
//
// NO INNER SCROLLER (JOS-289, and `leveling.e2e` measures it): the top ten are drawn and the rest
// sit behind a `+N more` disclosure, the same one-click shape the out-of-era rows use. A porthole
// in a column that has no height to give is exactly what that ticket removed.
//
// ERA: `outOfEraLabel`, IMPORTED from the mob page the way `UnlockList` imports it — a second copy
// would be a second wording. Positive verdicts fold; silence is not a verdict and stays in place.
//
// AND THE ROWS ARE AT THEIR MOTE RANK (JOS-447). Every figure here is read at
// `max(observed rank, simulated rank)`: the observed half is JOS-446's map, already subscribed for
// the `yours: VIII` chip that marks those rows, and the simulated half is `SpellRankSlider` under
// the tabs. The panel therefore answers two questions with one table - what my real spellbook does
// today, and what it would do if a candidate were levelled - which is the owner's ask read
// literally. The arithmetic is `shared/spellScale.ts`'s, fitted to his own log.

import { type JSX, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tabs,
  Typography
} from '@mui/material'
import {
  COLUMN_LABEL,
  COLUMN_TITLE,
  TAB_LABEL,
  TAB_ORDER,
  bestSpellsAt,
  columnValue,
  defaultSorts,
  tabColumns,
  type BestSpellColumn,
  type BestSpellRow,
  type BestSpellSort,
  type BestSpellTab,
  type BestSpellsTable
} from '@shared/bestSpells'
import { Tooltip } from '../../lib/Tooltip'
import { SpellTooltip } from '../../lib/SpellCard'
import { outOfEraLabel } from '../mobs/dropEra'
import { NONE } from './rangeStatsRows'
import { useCurrentComboClasses, useLevelUnlocks } from './useLevelUnlocks'
import { comboClassSet } from '@shared/levelUnlocks'
// The `yours: III` chip (JOS-446), the SAME component the unlock list draws — one wording, one
// tooltip (the outOfEraLabel arrangement, one component further). Subscribed once for the panel.
import { RankChip } from './UnlockList'
import { useObservedSpellRanks } from '../../lib/useObservedSpellRanks'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import SpellRankSlider from './SpellRankSlider'

/** How many rows are drawn before the disclosure. The owner's suggestion, and it fits the column. */
const TOP_N = 10

const CELL_SX = { py: 0.25, px: 0.6, fontSize: 11, borderBottom: 'none' } as const
const HEAD_SX = { ...CELL_SX, fontWeight: 700, whiteSpace: 'nowrap', color: 'text.secondary' } as const

/**
 * A figure, formatted the way `spellMetricsParts` formats the same figure on an unlock row.
 *
 * Totals and rates are whole numbers (nobody buys a spell on a tenth of a point); the per-mana
 * ratios keep the one decimal `spellMetricsAt` rounded them to, because there the tenth is most of
 * the difference between two spells. An ABSENT figure is the app's null cell, never a zero.
 */
function cellText(row: BestSpellRow, column: BestSpellColumn): string {
  const v = columnValue(row, column)
  if (v === null) return NONE
  return column === 'damagePerMana' || column === 'healPerMana' ? String(v) : String(Math.round(v))
}

/**
 * The share of the table each column takes, and it is MEASURED rather than left to `fixed`'s equal
 * split: `dmg/mana` is twice the header text of `dps` and an equal quarter clipped its last letters
 * off the right edge of the panel. The four add to 100, so the table never overflows its column.
 */
const COLUMN_WIDTH: Record<BestSpellColumn, string> = {
  dps: '22%',
  hps: '22%',
  damage: '23%',
  heal: '23%',
  mana: '22%',
  damagePerMana: '33%',
  healPerMana: '33%'
}

// THE `over Ns` COLUMN IS NOT DRAWN, AND THE MEASUREMENT IS WHY (JOS-448, the ticket's one design
// note: a fifth narrow column on the DoT/HoT tabs "if it fits the 260px floor").
//
// It does not fit, and the four widths above are not a taste. MEASURED in the running app (a probe
// in the leveling e2e reading each header's own `scrollWidth` plus its cell padding, sort arrow
// included): `dps` needs 54px, `dmg` 60px, `mana` 65px and `dmg/mana` 93px, which is 272px of
// table. At the app's own minimum width the right column is 260px, the Paper's `p: 1.5` takes 24 of
// it, and the ~234px left over is what those percentages divide - so at the floor the four headers
// are ALREADY 38px past what they ask for, and the unequal shares above are a decision about which
// one clips first rather than spare room. A fifth column holding `over` and a `126s` value is
// another ~37px, taken from columns that have none to give.
//
// So the window stays on the ROW, where it already is: `SpellTooltip` prints the whole
// `spellMetricsParts` line for the spell under the cursor, `over 24s` included, and the tab label
// itself already says that every row in the table ticks. Widening the panel is not a fix available
// here: the 260px floor is the app's own minimum, and a readout that only reads at `lg` is wrong on
// exactly the machine it is wrong on.

/** One sortable header. Clicking the active column flips it; clicking another takes it descending. */
function HeadCell({
  column,
  sort,
  onSort
}: {
  column: BestSpellColumn
  sort: BestSpellSort
  onSort: (s: BestSpellSort) => void
}): JSX.Element {
  const active = sort.column === column
  return (
    <TableCell
      align="right"
      sx={{ ...HEAD_SX, width: COLUMN_WIDTH[column] }}
      sortDirection={active ? (sort.desc ? 'desc' : 'asc') : false}
    >
      <Tooltip title={COLUMN_TITLE[column]}>
        <TableSortLabel
          active={active}
          direction={active && !sort.desc ? 'asc' : 'desc'}
          data-testid="best-spells-sort"
          data-column={column}
          data-active={active ? 'true' : 'false'}
          onClick={() => onSort({ column, desc: active ? !sort.desc : true })}
        >
          {COLUMN_LABEL[column]}
        </TableSortLabel>
      </Tooltip>
    </TableCell>
  )
}

/**
 * One spell, as TWO rows: its name across the whole width, then the side's four figures under it.
 *
 * MEASURED, and it is why the shape is not the obvious one. The first build put the name in a fifth
 * column; at the panel's real width (330px in the e2e's window, 260px at the app minimum) five
 * columns share out to ~62px each and every name in the table renders as `Disco…`, with the last
 * header clipped off the right edge for good measure. A spell you cannot read is not a
 * recommendation. Spending a LINE instead of a COLUMN gives the name the full width and the four
 * figures ~76px each — enough for the numbers, their headers and a sort arrow — and vertical space
 * is the axis this tab has to spare since JOS-289 made the page the scroller.
 *
 * The gain level rides beside the name because it is the whole point of the readout: `Garrison's
 * Mighty Mana Shock` sitting second at level 35 with an `L18` on it is the owner's own question,
 * answered.
 */
function SpellRow({
  row,
  columns,
  ranks
}: {
  row: BestSpellRow
  columns: readonly BestSpellColumn[]
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element {
  return (
    <>
      <TableRow data-testid="best-spells-name-row" data-name={row.name}>
        <TableCell colSpan={columns.length} sx={{ ...CELL_SX, pt: 0.5, pb: 0 }}>
          <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
            <SpellTooltip name={row.name}>
              <Typography variant="caption" sx={{ fontSize: 11, fontWeight: 600 }} noWrap>
                {row.name}
              </Typography>
            </SpellTooltip>
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: 9.5 }} noWrap>
              L{row.gainedAt}
            </Typography>
            <RankChip name={row.name} ranks={ranks} />
          </Stack>
        </TableCell>
      </TableRow>
      <TableRow hover data-testid="best-spells-row" data-name={row.name}>
        {columns.map((c) => (
          <TableCell key={c} align="right" sx={CELL_SX} data-testid="best-spells-cell" data-column={c}>
            {cellText(row, c)}
          </TableCell>
        ))}
      </TableRow>
    </>
  )
}

/** A one-click disclosure over rows the section is not showing by default. */
function RowDisclosure({
  label,
  testid,
  rows,
  columns,
  ranks
}: {
  label: string
  testid: string
  rows: readonly BestSpellRow[]
  columns: readonly BestSpellColumn[]
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <TableRow>
        <TableCell colSpan={columns.length} sx={{ ...CELL_SX, py: 0 }}>
          <Box
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
            }}
            data-testid={testid}
            sx={{ cursor: 'pointer', color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
          >
            <Typography variant="caption" sx={{ fontSize: 10 }}>
              {label}
            </Typography>
          </Box>
        </TableCell>
      </TableRow>
      {open && rows.map((r) => <SpellRow key={r.name} row={r} columns={columns} ranks={ranks} />)}
    </>
  )
}

/**
 * ONE TAB'S TABLE. Empty is STATED rather than blank: a wizard has no healing tabs at all and a
 * warrior has none of the four, and both are honest answers rather than a panel that failed to load.
 *
 * The tab is a data attribute rather than the old `data-side` because the tab is now the unit the
 * sort, the columns and the model all key on - one vocabulary, end to end.
 */
function TabTable({
  tab,
  data,
  sort,
  onSort,
  ranks
}: {
  tab: BestSpellTab
  data: BestSpellsTable
  sort: BestSpellSort
  onSort: (s: BestSpellSort) => void
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element {
  const columns = tabColumns(tab)
  const top = data.shown.slice(0, TOP_N)
  const rest = data.shown.slice(TOP_N)
  return (
    <Box
      data-testid="best-spells-section"
      data-tab={tab}
      data-count={String(data.shown.length)}
      data-sort={sort.column}
      data-desc={String(sort.desc)}
    >
      {data.shown.length === 0 && data.outOfEra.length === 0 ? (
        <Typography variant="caption" color="text.disabled" display="block" data-testid="best-spells-empty">
          nothing this loadout owns yet
        </Typography>
      ) : (
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <HeadCell key={c} column={c} sort={sort} onSort={onSort} />
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {top.map((r) => (
              <SpellRow key={r.name} row={r} columns={columns} ranks={ranks} />
            ))}
            <RowDisclosure
              label={`+${String(rest.length)} more`}
              testid="best-spells-more"
              rows={rest}
              columns={columns}
              ranks={ranks}
            />
            <RowDisclosure
              label={outOfEraLabel(data.outOfEra.length)}
              testid="best-spells-era-toggle"
              rows={data.outOfEra}
              columns={columns}
              ranks={ranks}
            />
          </TableBody>
        </Table>
      )}
    </Box>
  )
}

export interface BestSpellsPanelProps {
  /** The level the TAB is showing — the same number the unlock stepper displays. */
  level: number
}

/**
 * WILL THERE BE A READOUT? Asked one layer up, by the column that HOLDS it.
 *
 * The `chartedOf` arrangement in LevelingView, for the same reason: two placements read one gate.
 * The right column exists when this panel or the ledger below it is drawable, and a column band
 * with nothing in it is a layout the tab's own e2e measures (`columnsInfo` counts the bands). The
 * test is `comboClassSet(...).length > 0` and it is the SAME test the panel applies to itself —
 * `bestSpellsAt` returns exactly that set as `classes`.
 */
export function useBestSpellsVisible(): boolean {
  const combo = useCurrentComboClasses()
  return comboClassSet(combo).length > 0
}

/**
 * THE PANEL. Null when the loadout is unknown, and that is the one gate: every row here is a claim
 * about spells YOU own, and there is no honest version of it over sixteen candidate classes. The
 * panel below already teaches the two ways to fix that (a `/who`, or a Profile correction), so
 * repeating the sentence in the column beside it would be the same instruction twice.
 */
export function BestSpellsPanel({ level }: BestSpellsPanelProps): JSX.Element | null {
  const data = useLevelUnlocks()
  const combo = useCurrentComboClasses()
  // JOS-446's observed ranks, one subscription for the whole panel (the NewAtLevelPanel arrangement).
  const ranks = useObservedSpellRanks()
  const [sorts, setSorts] = useState(defaultSorts)
  const [picked, setPicked] = useState<BestSpellTab | null>(null)
  // THE SIMULATE SLIDER'S STATE, session-only and owned here (JOS-447 — SpellRankSlider's header
  // says why it is not persisted). 0 is base, which is where every mount opens.
  const [simulate, setSimulate] = useState(0)
  // Re-ranked by the LEVEL, the SORT and the RANKS, and by nothing else — the whole readout is one
  // pure call over an already-cached dataset, so stepping the level or the slider costs one fold of
  // ~1,450 rows. All four tables are built every time on purpose: the tab labels carry counts, so
  // the tabs you are not looking at are part of what the panel says.
  const best = useMemo(
    () => bestSpellsAt(data, combo, level, { sorts, observed: ranks, simulate }),
    [data, combo, level, sorts, ranks, simulate]
  )
  // UNTIL SOMEBODY PICKS, THE PANEL PICKS THE FIRST TAB THAT HAS ANYTHING IN IT. `dd` is the owner's
  // first-named tab and the right default for the caster this readout was written for, but a cleric
  // has no DD table at all and opening him on an empty one would be the panel failing to answer a
  // question it can answer. Derived at render rather than in an effect, so it follows the level.
  const tab = picked ?? TAB_ORDER.find((t) => best.tabs[t].shown.length > 0) ?? 'dd'
  if (best.classes.length === 0) return null
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5 }}
      data-testid="best-spells"
      data-level={String(level)}
      data-simulate={String(simulate)}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2">Best at level {level}</Typography>
        {/* THE SAME ONE QUIET WORD the panel below says, for the same reason: these are base
            figures with no crits, focus, AA or resist in them (recast IS in them since JOS-444).
            Said once per surface, never on a row (AGENTS.md, the caveat diet). */}
        <Typography variant="caption" color="text.disabled" data-testid="best-spells-directional">
          directional
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {best.ambiguous && (
          <Tooltip title="Covers every class your loadout could still be.">
            <Chip
              size="small"
              label="~ambiguous"
              data-testid="best-spells-ambiguous"
              variant="outlined"
              sx={{ height: 18, fontSize: 10 }}
            />
          </Tooltip>
        )}
      </Stack>
      {/* `fullWidth` rather than `scrollable`: four labels this short divide 260px without a
          scroller, and a scroller would put the fourth answer behind a gesture nobody expects in a
          panel this small. The label carries its count so an empty tab says so before it is opened. */}
      <Tabs
        value={tab}
        onChange={(_e, next: BestSpellTab) => setPicked(next)}
        variant="fullWidth"
        data-testid="best-spells-tabs"
        sx={{ minHeight: 28, mb: 0.5, '& .MuiTabs-indicator': { height: 2 } }}
      >
        {TAB_ORDER.map((t) => (
          <Tab
            key={t}
            value={t}
            data-testid="best-spells-tab"
            data-tab={t}
            data-count={String(best.tabs[t].shown.length)}
            label={`${TAB_LABEL[t]} (${String(best.tabs[t].shown.length)})`}
            sx={{ minHeight: 28, minWidth: 0, px: 0.5, py: 0.25, fontSize: 10.5, textTransform: 'none' }}
          />
        ))}
      </Tabs>
      <SpellRankSlider rank={simulate} onChange={setSimulate} />
      {/* KEYED BY THE TAB so the two disclosures inside reset when the table changes: `+7 more` left
          open on the DD table is not a statement about the DoT table underneath it. */}
      <TabTable
        key={tab}
        tab={tab}
        data={best.tabs[tab]}
        sort={sorts[tab]}
        onSort={(next) => setSorts((prev) => ({ ...prev, [tab]: next }))}
        ranks={ranks}
      />
    </Paper>
  )
}
