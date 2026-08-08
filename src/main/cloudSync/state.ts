// Pure projection from the desktop's authoritative snapshots to the deliberately small
// Discord/cloud allowlist. Keep this file free of Electron, stores and network concerns: the
// final protocol parser is the boundary that copies named fields into a fresh object.

import classesJson from '../data/classes.json'
import { resolvedClasses, type ClassAbbr, type ComboSnap } from '../../shared/classCombo'
import type { CombatSnapshot, SourceKind } from '../../shared/combat'
import {
  CLOUD_SYNC_LIMITS,
  parseCloudSyncState,
  type CloudCombatantKind,
  type CloudSyncState
} from '../../shared/cloudSync'
import { rangeStats, type RangeStats } from '../../shared/progressionStats'
import type { ProgressionSnap } from '../../shared/progressionTypes'
import type { CharacterSnap, LootSnap } from '../../shared/types'

const HOUR_MS = 3_600_000
const ETA_MIN_ONLINE_MS = 15 * 60_000
const PUBLIC_DECIMALS = 1_000

export interface CloudSyncStateInputs {
  characterId: string
  character: CharacterSnap
  combo: ComboSnap
  combat: CombatSnapshot
  progression: ProgressionSnap
  loot: LootSnap
}

function publicKind(kind: SourceKind): CloudCombatantKind {
  if (kind === 'you') return 'self'
  if (kind === 'pet') return 'pet'
  if (kind === 'member') return 'party'
  return 'other'
}

function publicString(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max
}

function publicInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function publicNumberValue(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function className(abbr: ClassAbbr): string | null {
  const entry = Object.entries(classesJson.names).find(([key]) => key === abbr)
  const name = entry?.[1]
  return typeof name === 'string' && publicString(name, CLOUD_SYNC_LIMITS.maxNameChars) ? name : null
}

function classNames(combo: ComboSnap): string[] {
  if (!combo.ready || combo.current === null) return []
  return resolvedClasses(combo.current)
    .map(className)
    .filter((name): name is string => name !== null)
    .slice(0, CLOUD_SYNC_LIMITS.maxClasses)
}

function publicTarget(combat: CombatSnapshot): string | undefined {
  const target = combat.currentTarget?.name ?? combat.selected?.name
  return target !== undefined && publicString(target, CLOUD_SYNC_LIMITS.maxNameChars) ? target : undefined
}

function combatState(combat: CombatSnapshot): CloudSyncState['combat'] {
  const selected = combat.selected
  const current = combat.segments.find((segment) => segment.kind === 'current')
  const target = publicTarget(combat)
  const startedAt = current?.startTs
  const rows =
    selected?.entities
      .filter(
        (row) =>
          publicString(row.name, CLOUD_SYNC_LIMITS.maxNameChars) &&
          publicNumberValue(row.total) &&
          publicNumberValue(row.dps)
      )
      .slice(0, CLOUD_SYNC_LIMITS.maxCombatRows)
      .map((row) => ({
        name: row.name,
        total: row.total,
        dps: row.dps,
        kind: publicKind(row.kind)
      })) ?? []
  return {
    inCombat: combat.inCombat,
    ...(target === undefined ? {} : { target }),
    ...(startedAt === undefined || !publicInteger(startedAt) ? {} : { startedAt }),
    totalDamage: selected?.outTotal ?? 0,
    dps: selected?.outDps ?? 0,
    rows
  }
}

function currentLevel(snap: ProgressionSnap): number | null {
  const n = snap.levelValue.length
  return n === 0 ? null : snap.levelValue[n - 1]
}

function publicNumber(value: number): number {
  return Math.round(value * PUBLIC_DECIMALS) / PUBLIC_DECIMALS
}

function statedSinceDing(snap: ProgressionSnap, dingTs: number): { equiv: number; unstated: number } {
  let equiv = 0
  let unstated = 0
  for (let i = snap.expTs.length - 1; i >= 0 && snap.expTs[i] > dingTs; i--) {
    if ((snap.expFlag[i] & 1) !== 0) unstated++
    else equiv += snap.expPct[i] / 100
  }
  return { equiv, unstated }
}

function honestProjection(
  snap: ProgressionSnap,
  hour: RangeStats
): Pick<NonNullable<CloudSyncState['progression']>, 'percent' | 'etaMs'> {
  const n = snap.levelTs.length
  if (n === 0) return {}
  const dingTs = snap.levelTs[n - 1]
  if (snap.windowStart > 0 && dingTs < snap.windowStart) return {}
  const { equiv, unstated } = statedSinceDing(snap, dingTs)
  if (unstated > 0 || equiv >= 1) return {}
  if (hour.offlineMs > 0 && hour.durationMs - hour.offlineMs < ETA_MIN_ONLINE_MS) return {}
  const pace = hour.levelsPerHourWall
  if (hour.levelsPerHourActive === null || pace === null || pace <= 0) return {}
  return {
    percent: publicNumber(equiv * 100),
    etaMs: Math.round(((1 - equiv) / pace) * HOUR_MS)
  }
}

function progressionState(snap: ProgressionSnap): CloudSyncState['progression'] {
  const level = currentLevel(snap)
  if (level === null || snap.lastTs <= 0) return undefined
  const hour = rangeStats({ snap, range: { t0: snap.lastTs - HOUR_MS, t1: snap.lastTs } })
  const pace = hour.levelsPerHourWall
  if (pace === null) return undefined
  return {
    level,
    xpPerHour: publicNumber(pace * 100),
    ...honestProjection(snap, hour)
  }
}

function recentState(inputs: CloudSyncStateInputs): CloudSyncState['recent'] {
  return {
    kills: inputs.progression.recentKills
      .filter((kill) => publicString(kill.name, CLOUD_SYNC_LIMITS.maxNameChars) && publicInteger(kill.ts))
      .slice(-CLOUD_SYNC_LIMITS.maxRecentKills)
      .map((kill) => ({ name: kill.name, ts: kill.ts })),
    loot: inputs.loot
      .filter(
        (row) =>
          publicString(row.item, CLOUD_SYNC_LIMITS.maxItemChars) &&
          publicInteger(row.ts) &&
          (row.count === undefined || (publicInteger(row.count) && row.count > 0))
      )
      .slice(-CLOUD_SYNC_LIMITS.maxRecentLoot)
      .map((row) => ({
        item: row.item,
        ts: row.ts,
        ...(row.count === undefined ? {} : { quantity: row.count })
      }))
  }
}

/** Build and validate a fresh public snapshot. Invalid or absent identity fails closed. */
export function buildCloudSyncState(inputs: CloudSyncStateInputs, now: number): CloudSyncState | null {
  const character = inputs.character.character
  if (character === null || inputs.characterId.length === 0) return null
  const progression = progressionState(inputs.progression)
  const zone = inputs.character.zone ?? inputs.combat.zone
  const candidate: CloudSyncState = {
    publishedAt: now,
    character: {
      id: inputs.characterId,
      name: character.name,
      server: character.server,
      ...(progression === undefined ? {} : { level: progression.level }),
      classes: classNames(inputs.combo),
      ...(zone === undefined || !publicString(zone, CLOUD_SYNC_LIMITS.maxZoneChars) ? {} : { zone })
    },
    combat: combatState(inputs.combat),
    ...(progression === undefined ? {} : { progression }),
    recent: recentState(inputs)
  }
  const parsed = parseCloudSyncState(candidate)
  return parsed.ok ? parsed.value : null
}
