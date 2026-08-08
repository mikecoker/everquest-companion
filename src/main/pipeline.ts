// ============================================================================
// pipeline.ts — the log-derived world: one event stream, and everything that folds it.
// ============================================================================
//
// See AGENTS.md → Architecture. Both feeders (the startup scan and the live Tailer) push
// onto ONE LogBus; the ModuleRegistry folds every event into each extension module and the
// CombatEngine folds it into its own state machine.
//
// This module CONSTRUCTS that world and wires it, at import time, in the order the design
// requires — the module instances (via `modules/wiring.ts`, which owns the list and its order),
// the registry host that pushes `module:delta`, and the two bus subscriptions. index.ts imports
// it as the composition root's first act; `session.ts` drives it (scan → tail → reset on
// character switch).
//
// The module ORDER is load-bearing and is documented in modules/wiring.ts, beside the
// constructions. Do not reorder them. That file is Electron-free on purpose: `npm run bench:replay`
// folds the same modules in the same order OUTSIDE Electron to attribute the startup fold per
// consumer (JOS-55), and it must not be holding a private copy of the list.

import { IPC } from '../shared/ipc'
import { logInfo } from './errorLog'
import { LogBus } from './log/bus'
import { EpochDetector } from './log/epochDetector'
import { SessionDetector } from './log/sessionDetector'
import { baselineOverlay, loadUserOverlay } from './data/overlayPersistence'
import { CombatEngine } from './combat/engine'
import { ModuleRegistry } from './modules/registry'
import { createModules } from './modules/wiring'
import type { ModuleDelta } from './modules/types'
import { lookupItem } from './itemLookup'
import { MOB_CATALOG_SIZE, lookupMob, ownLoot } from './mobLookup'
import { getAlerts } from './store'
import { getOverlayWindow, sendToMain } from './windows'
import type { AlertsDelta } from '../shared/types'

/**
 * Log-derived state for the active character, rebuilt on launch + appended live.
 * A single canonical LogEvent stream (bus) feeds every consumer: the module
 * registry folds it into each extension module, the combat engine folds it into
 * its state machine. Both feeders (scan + tail) share one monotonic seq counter,
 * owned by session.ts.
 */
export const bus = new LogBus()
export const combat = new CombatEngine()
// Character-epoch detection (Task #49; anchor replaced in Task #50): the OFFICIAL LAUNCH
// (2026-07-28 00:00 local) is the boundary of a same-name+server character being WIPED +
// recreated at launch (they reuse the same log file — see epochDetector.ts's beta-wipe
// story). The first at/after-launch event hands a derived `epoch` event back onto the SAME
// bus (the Task #47 emitDerived path), which every character-scoped module resets on, so
// post-scan tallies (AA/loot/kills/turn-ins/quests) reflect ONLY the current character.
// Fires mid-replay during a rescan, so epochs apply historically for free; a live crossing
// works identically. (The old level-regression heuristic was removed — EQ Legends loadout
// swaps legitimately change level, so a level drop is NOT a reliable rebirth signal.)
export const epoch = new EpochDetector()
// LOGIN/LOGOUT (the session frame). `Welcome to EverQuest Legends!` is a parsed `sessionStart`;
// this detector turns each one into a derived `offlineGap {fromTs, toTs, camped}` on the SAME
// bus (the emitDerived path epoch and buffs already use), so every consumer learns the world
// stopped being observable for a while. It shares index.ts's LAST bus subscription with the
// epoch detector for the same reason: it must see each event only after the modules and the
// combat engine have folded it. See sessionDetector.ts for why `fromTs` is NOT the last event
// before the Welcome (a measured reconnect preamble makes that read a 13-hour absence as 6s).
export const sessionDetector = new SessionDetector()

const CLOUD_SYNC_MODULES = new Set(['character', 'combo', 'loot', 'progression'])
let cloudSyncStateObserver: (() => void) | null = null

/** Install the optional cloud publisher observer without making the pipeline import policy/store. */
export function setCloudSyncStateObserver(observer: (() => void) | null): void {
  cloudSyncStateObserver = observer
}

/** Character switches and combat events use the same synchronous dirty seam as module flushes. */
export function notifyCloudSyncStateChanged(): void {
  cloudSyncStateObserver?.()
}

// The extension framework. Modules own their slice of log-derived state and push
// deltas to the renderer over the generic `module:delta` channel. Registration
// order = bus delivery order.
export const registry = new ModuleRegistry({
  emitDelta: (delta: ModuleDelta) => {
    sendToMain(IPC.onModuleDelta, delta)
    // Task #59: alert fires are ALSO event-log rows. Folding them here (rather than teaching
    // AlertsModule about the feed) keeps the alerts module untouched, and because eventFeed is
    // registered LAST the row it appends is picked up by the same flush pass.
    feedAlertDelta(delta)
    // The 'events' overlay is a second consumer of the module transport (it hydrates the
    // eventFeed module and rides its deltas), so deltas must reach that window too.
    const evOverlay = getOverlayWindow('events')
    if (evOverlay && !evOverlay.isDestroyed()) evOverlay.webContents.send(IPC.onModuleDelta, delta)
    if (CLOUD_SYNC_MODULES.has(delta.moduleId)) notifyCloudSyncStateChanged()
  }
})
/**
 * EVERY MODULE, IN BUS-DELIVERY ORDER — built by `modules/wiring.ts`, not here (JOS-55).
 *
 * The construction and the registration order moved to that file for one reason: the startup
 * fold is what `npm run bench:replay` takes apart per consumer, and it measures the fold IN
 * PROCESS, outside Electron, where THIS file cannot be imported (store, windows, the two
 * knowledge lookups). A bench holding its own hand-copied list of modules would attribute a
 * pipeline nobody ships. There is one list; this is its only Electron-flavoured caller.
 *
 * Everything impure is injected from here — the user's alert defs, both message overlays, the
 * item/mob knowledge lookups, the shared own-loot index, and the bus the buffs module hands its
 * derived `buffExpired` back to (Task #47: queued until the current primary event finishes
 * delivering — no re-entrancy, no feedback loop, since buffs ignores buffExpired).
 */
const modules = createModules({
  alertDefs: getAlerts(),
  // The committed baseline first, then what this user's own log has taught since install.
  overlays: [baselineOverlay(), loadUserOverlay()],
  lookupItem,
  lookupMob,
  ownLoot,
  emitDerived: (ev, live) => {
    bus.emitDerived(ev, live)
  }
})

export const spellDb = modules.spellDb
export const comboModule = modules.combo
export const rosterModule = modules.roster
export const lootModule = modules.loot
export const turnInsModule = modules.turnIns
export const killsModule = modules.kills
export const progressionModule = modules.progression
export const levelingModule = modules.leveling
export const characterModule = modules.character
export const itemTiersModule = modules.itemTiers
export const alertsModule = modules.alerts
export const buffsModule = modules.buffs
export const considerModule = modules.consider
export const eventFeedModule = modules.eventFeed

logInfo(
  `[everquest-companion] Message overlay: applied ${modules.overlayCorrections} cast-message corrections over the wiki DB.`
)
logInfo(`[everquest-companion] Spell DB: ${spellDb.spells.length} spells (${spellDb.castOnYou.size} unique cast-on-you msgs).`)
logInfo(
  `[everquest-companion] Mob catalog: ${MOB_CATALOG_SIZE} mobs (scraped drop tables; the live wiki lookup is the fallback).`
)

/** Fold an `alerts` module delta into the event feed (alert id → its display name). */
function feedAlertDelta(delta: ModuleDelta): void {
  if (delta.moduleId !== 'alerts') return
  const { fired } = delta.delta as AlertsDelta
  if (!fired?.length) return
  const defs = alertsModule.snapshot().state.defs
  for (const f of fired) {
    const def = defs.find((d) => d.id === f.alertId)
    eventFeedModule.noteAlertFire(def?.name ?? f.alertId, f.matchedText, f.ts)
  }
}

// REGISTRATION ORDER IS BUS DELIVERY ORDER, and the order itself is stated (with its reasons) in
// modules/wiring.ts beside the constructions — combo first, roster second, eventFeed last. This
// loop is the whole registration: a module added there is registered here without an edit, which
// is exactly the property that keeps the bench's attribution honest.
for (const mod of modules.ordered) registry.register(mod)
// Subscribe consumers to the bus ONCE, at startup. The bus persists across
// character switches; on a switch we reset() each consumer rather than tearing
// down and re-subscribing (the old bus.clear() churned subscriptions and risked
// registration-order drift). Registry first, then combat — same order as before.
registry.attach(bus)
// THE ROSTER SEAM (docs/plans/group-model.md §3.5). The engine's admission gate and its scope
// filtering both read the roster through this ONE pull, installed before the engine ever folds
// a line: the registry is attached above, so within a single bus delivery the roster module has
// already consumed the event the engine is about to. A pull rather than a copy, because a user
// edit made between two log lines must be visible to the very next one.
combat.setRoster(rosterModule)
bus.subscribe((ev, live) => combat.ingestEvent(ev, live))
// Item-knowledge prefetch (Task #53): when a LIVE loot event arrives, warm the
// "what's this for" cache in the background (throttled by itemLookup's serialized queue
// + persistent cache) so the answer is ready by the time the user clicks the item. LIVE
// only — the historical scan (live:false) would otherwise fire thousands of lookups; the
// cache/local-posky path covers those instantly on demand.
//
// Task #59 folded this INTO the event-feed module: its live-loot notability probe calls the
// same cache-first `lookupItem`, so the cache is warmed exactly as before with ONE request
// per item (the module also de-dupes concurrent probes of the same name, which the bare
// prefetch did not). A second subscription here would double-request every uncached loot.
//
// The THIRD and last subscription — epoch detection — is added by index.ts, after this
// module has finished wiring: it must observe each event only once the modules and the
// combat engine have folded it, and it reaches for the active character, which session.ts
// owns. See the composition root.

/**
 * When the log-derived world finished being CONSTRUCTED, in ms since process start — the
 * `dataLoaded` startup phase (docs/plans/perf-profiling.md P4): the spell DB is parsed, the
 * learned message overlay is folded in, the mob catalog is counted and every module exists.
 *
 * A plain exported number, for the same reason `STORE_READY_MS` is one: this all happens during
 * module EVALUATION, long before Electron's `ready`, and importing main's perf module from here
 * to mark it would buy a dependency cycle for a timestamp. The composition root imports both and
 * does the marking.
 */
export const DATA_READY_MS = performance.now()
