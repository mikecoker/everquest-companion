import type { JSX } from 'react'
import { Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import type { WindowedRows } from '../../lib/useWindowedRows'
import type { InventoryRow } from '../inventory/reconcile'
import type { GroupRow, KeyedLoot } from './lootGrouping'
import { FlatRow, GroupedRow } from './lootRows'

/**
 * `tableLayout: fixed` — the other half of the fixed-height contract (JOS-260, lootRows.tsx).
 *
 * An AUTO-layout table sizes its columns from the widest cell it can see, and a windowed table can
 * only ever see a screenful: scrolling swaps the rows underneath, the widest visible item name
 * changes, the columns re-measure and the row heights move with them — under a hook whose every
 * index assumes they cannot. Fixed layout takes the widths from the HEADER row alone, so the
 * geometry stops depending on which slice happens to be mounted, and a long name is clipped by the
 * cell rather than being allowed to wrap the row to two lines.
 *
 * Percentages, not pixels, so the columns always add up to the pane the user actually has: a fixed
 * table whose stated widths exceed its box grows past it and hands the ledger a horizontal
 * scrollbar. Every stated width is a percentage now — the one pixel exception was the favorite
 * star's 44 px column, which left with the star (JOS-345); the unstated Item column simply
 * absorbed it, since it is the column that takes whatever the others leave.
 */
const FIXED_TABLE = { tableLayout: 'fixed' } as const

// The spacer rows (top/bottom) that reserve the full scroll height so only the visible
// slice of MUI rows is ever mounted — see useWindowedRows.
function PadRow({ height, colSpan }: { height: number; colSpan: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow style={{ height }}>
      <TableCell colSpan={colSpan} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

/** What both tables need from the view to draw a row. */
export interface LootTableContext {
  win: WindowedRows
  knowledgeByKey: Map<string, ItemKnowledge>
  invByKey: Map<string, InventoryRow>
  onSelect: (item: string) => void
}

/**
 * The two shapes the same loot can take: one row per ITEM (with the reconciled inventory
 * estimate and the top source), or one row per EVENT — the raw ledger, newest first.
 */
export function LootTable({
  groupByItem,
  rows,
  events,
  ctx
}: {
  groupByItem: boolean
  rows: GroupRow[]
  events: KeyedLoot[]
  ctx: LootTableContext
}): JSX.Element {
  if (groupByItem) {
    return (
      <GroupedLootTable
        rows={rows}
        win={ctx.win}
        knowledgeByKey={ctx.knowledgeByKey}
        invByKey={ctx.invByKey}
        onSelect={ctx.onSelect}
      />
    )
  }
  return (
    <FlatLootTable
      events={events}
      win={ctx.win}
      knowledgeByKey={ctx.knowledgeByKey}
      onSelect={ctx.onSelect}
    />
  )
}

export function GroupedLootTable({
  rows,
  win,
  knowledgeByKey,
  invByKey,
  onSelect
}: {
  rows: GroupRow[]
  win: WindowedRows
  knowledgeByKey: Map<string, ItemKnowledge>
  invByKey: Map<string, InventoryRow>
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <Table size="small" stickyHeader sx={FIXED_TABLE}>
      <TableHead>
        <TableRow>
          {/* No width: the item NAME takes whatever the stated columns leave. */}
          <TableCell>Item</TableCell>
          <TableCell align="right" sx={{ width: '11%' }}>Times looted</TableCell>
          {/* The header carries the caveat as ONE WORD (JOS-127 + the house tooltip diet): a
              popper on a sticky header hangs over the first rows, and every row is a control. */}
          <TableCell align="right" sx={{ width: '13%' }}>In inventory (est.)</TableCell>
          <TableCell sx={{ width: '20%' }}>Top source</TableCell>
          <TableCell align="right" sx={{ width: '8%' }}>Zones</TableCell>
          <TableCell sx={{ width: '15%' }}>Last looted</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <PadRow height={win.topPad} colSpan={6} />
        {rows.slice(win.start, win.end).map((g) => (
          <GroupedRow
            key={g.key}
            g={g}
            knowledge={knowledgeByKey.get(g.countKey)}
            inv={invByKey.get(g.countKey)}
            onSelect={onSelect}
          />
        ))}
        <PadRow height={win.bottomPad} colSpan={6} />
      </TableBody>
    </Table>
  )
}

export function FlatLootTable({
  events,
  win,
  knowledgeByKey,
  onSelect
}: {
  events: KeyedLoot[]
  win: WindowedRows
  knowledgeByKey: Map<string, ItemKnowledge>
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <Table size="small" stickyHeader sx={FIXED_TABLE}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: '15%' }}>Time</TableCell>
          {/* No width: the item NAME takes whatever the stated columns leave. */}
          <TableCell>Item</TableCell>
          <TableCell sx={{ width: '24%' }}>From</TableCell>
          <TableCell sx={{ width: '20%' }}>Zone</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <PadRow height={win.topPad} colSpan={4} />
        {events.slice(win.start, win.end).map((e, i) => (
          <FlatRow
            key={`${e.ts}-${e.item}-${win.start + i}`}
            e={e}
            knowledge={knowledgeByKey.get(e.countKey)}
            onSelect={onSelect}
          />
        ))}
        <PadRow height={win.bottomPad} colSpan={4} />
      </TableBody>
    </Table>
  )
}
