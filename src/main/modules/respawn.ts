// RESPAWN CLOCKS — the fold (JOS-194). Death lines in, live countdowns out.
//
// The vocabulary, the estimate ladder and the argument for all of it live in `shared/respawn.ts`;
// the wiki floor and the measurement of how thin it is live in `shared/respawnWiki.ts`. This file
// is the state machine between them and owns three things the pure code cannot:
//
//   1. THE ZONE STAY. A death→death gap is only a respawn sample when you never left the zone
//      between the two deaths, and only the fold knows where you have been. `zoneSince` is the
//      timestamp of the `You have entered` line that started the current stay; a gap qualifies
//      when the EARLIER death also falls inside it.
//      That same `zone` is ALSO what the display scopes to (owner ruling, 2026-08-10: the overlay
//      shows the zone you are in, the tab defaults to it). It is published as `RespawnSnap.zone`
//      and the surfaces filter against it with `respawnInZone` — deliberately ONE piece of zone
//      state serving both jobs, because a second tracker would be free to disagree with the one
//      that decides whether a gap counts. The ROWS are not filtered here: cross-zone data is kept
//      and published (bounded, most-recent-death first), so the tab's all-zones view and the
//      history behind it cost no second channel.
//   2. THE LRU. A months-long replay walks past thousands of distinct mob names and every one of
//      them is a potential watch candidate, so the history is capped and evicted by last-death.
//   3. ITS OWN REVISION NUMBER. This module has a SECOND INPUT — the user's watch list, edited
//      over IPC while the log sits idle — so reporting the last event's `seq` would let
//      `useModule`'s `d.seq <= knownSeq` dedupe silently swallow the push that carries a watch the
//      user just added. That is JOS-87's scar exactly (a combo correction written during an idle
//      log never reached the screen), so `rev` is a private counter bumped by anything that can
//      change the state, reported by BOTH `snapshot()` and `flushDelta()`, and the IPC setter
//      calls `registry.flushNow()` rather than waiting for the heartbeat. Both halves are needed.
//      By round 3 there are THREE such inputs — the watch list, a zone line, and a confirmed
//      sighting — and every one of them bumps `rev`. The rule generalizes: if it changes what the
//      screen shows, it moves the revision, or the delta is swallowed.
//      AND IT PUBLISHES EVERY WATCHED MOB IT HOLDS A DEATH FOR (round 8). This file used to sweep
//      the derived rows against a 30-minute linger, which meant a watch clicked hours after the
//      kill produced no row at all — the defect the owner reported from live play. The sweep is
//      gone; the linger's remaining jobs are readings in `shared/respawn.ts` and remove nothing.
//   4. WHAT THE LOG HAS SAID ABOUT A WATCHED MOB SINCE ITS CLOCK STARTED (round 3). The rulings
//      and the full coverage statement are in `shared/respawn.ts`; the mechanism here is small
//      and deliberately so — `seenNamesOf` maps a TYPED event to the names it states, `markSeen`
//      records the newest of them against the (zone, mob) entry, and nothing else in the fold
//      changes. In particular a sighting never touches `minGapMs`, `samples` or `lastTs`: it is
//      not a death and the ladder must not learn from it.

import type { EqModule } from './types'
import { isCountedKill } from '../log/reducers'
import { idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import respawnsJson from '../data/respawns.json'
import type { WikiRespawn, WikiRespawnData } from '../../shared/respawnWiki'
import {
  DEFAULT_RESPAWN_PREFS,
  RESPAWN_MAX_GAPS,
  RESPAWN_MAX_RECENT,
  RESPAWN_MAX_ROWS,
  RESPAWN_SHAPE_VERSION,
  orderRespawnRows,
  resolveRespawn,
  type RespawnCandidate,
  type RespawnDelta,
  type RespawnPrefs,
  type RespawnRow,
  type RespawnSeenVia,
  type RespawnSnap,
  type RespawnWatchPref
} from '../../shared/respawn'

/**
 * The shortest death→death gap this module will read as a spawn cycle.
 *
 * MEASURED, not chosen: across all 394 respawns the committed wiki floor states a duration for,
 * the SHORTEST is 78 seconds (`Groi Gutblade`), the 1st percentile is 165 s and the median is
 * 22 minutes. Nothing in the game's own documented spread comes close to a minute. So two deaths
 * of one name inside 60 seconds are two mobs standing together — a placeholder pair, a trash
 * spawn group — dying in one pull, and reading that as a respawn would drive the estimate to a
 * number the mob can never honour. This refuses the sample outright rather than recording it and
 * hoping the wiki floor lifts it back, because 85% of the mobs in the dungeons this ticket targets
 * have no wiki floor to lift it with.
 */
const MIN_GAP_MS = 60_000

/** Distinct (zone, mob) pairs the history keeps before evicting the least recently killed. */
const MAX_HISTORY = 800

/**
 * How often a CONTINUING sighting re-publishes.
 *
 * A fight prints several lines a second and every one of them names the mob, so recording the
 * sighting is free but PUSHING it is not: a delta per damage line would be a snapshot of every
 * clock in the fold, several times a second, for a number the renderer can already compute from
 * `seenTs`. The transition into the seen state always pushes immediately — that is the whole
 * ruling and it must not wait — and after that the row's published `seenTs` is allowed to lag by
 * up to this much. The visible consequence is bounded and stated: a row can read "seen 6s ago"
 * when the last line was 1s ago, which is the same order of staleness the 1 s heartbeat already
 * imposes on everything else in this window.
 */
const SEEN_REFRESH_MS = 5_000

/** What the fold knows about one mob in one zone. */
interface MobHistory {
  key: string
  display: string
  zone: string
  /** The most recent death, ms. */
  lastTs: number
  /** The SMALLEST qualifying gap seen — an upper bound on the respawn (shared/respawn.ts). */
  minGapMs?: number
  /** How many qualifying gaps back `minGapMs`. */
  samples: number
  /**
   * THE GAPS THEMSELVES, oldest first, capped at `RESPAWN_MAX_GAPS` (round 7 — the Running entry
   * shows its working now that the watch list at the bottom of the tab is gone). Kept beside
   * `samples` and `minGapMs` rather than replacing them: those two are computed over EVERY
   * qualifying gap and must not start describing only the last six.
   */
  gaps: number[]
  /** Deaths counted, qualifying or not. */
  kills: number
  /** The last event that NAMED this mob while the fold stood in this zone. Never a death. */
  seenTs?: number
  seenVia?: RespawnSeenVia
  /** The last `seenTs` a delta actually carried — see SEEN_REFRESH_MS. */
  seenPubTs?: number
  /**
   * A sighting the USER confirmed as the spawn (owner ruling, round 3). Competes with `lastTs`
   * for the clock's base and the LATER one wins, which is why a death needs no code to undo it.
   * Never persisted and never a gap sample: it is a judgement about one spawn, not a log line.
   */
  confirmedTs?: number
}

/** The clock's base for one history entry: the death, or a later confirmed sighting. */
function baseOf(h: MobHistory): number {
  return h.confirmedTs !== undefined && h.confirmedTs > h.lastTs ? h.confirmedTs : h.lastTs
}

/**
 * Copy the sighting onto the row — but ONLY when it is newer than the clock's base. A mention from
 * the fight that killed the mob is not a sighting of the spawn that follows, so a row must never
 * open in the seen state. Its own function because `rowFor` is at the repo's complexity ceiling.
 */
function attachSeen(row: RespawnRow, h: MobHistory, base: number): void {
  if (h.seenTs === undefined || h.seenTs <= base) return
  row.seenTs = h.seenTs
  if (h.seenVia !== undefined) row.seenVia = h.seenVia
}

/**
 * THE NAMES A TYPED EVENT STATES, and which family stated them — the whole of round 3's evidence
 * intake. The coverage statement (what is in, what is deliberately out, and what the log simply
 * cannot say) lives in `shared/respawn.ts`'s header, beside the ruling; this is only the mapping.
 *
 * Split into four readers rather than one switch because one switch over twelve kinds exceeds the
 * repo's `complexity` ceiling, and the four groups are the four `RespawnSeenVia` values anyway —
 * the factoring and the vocabulary agree.
 *
 * Exported so a unit test can hold the mapping to the events the parser really emits, rather than
 * having to reach it through a fold.
 */
export function seenNamesOf(ev: LogEvent): { names: (string | null | undefined)[]; via: RespawnSeenVia } | null {
  const combat = seenCombat(ev)
  if (combat) return { names: combat, via: 'combat' }
  if (ev.kind === 'consider') return { names: [ev.mob], via: 'consider' }
  const hold = seenHold(ev)
  if (hold) return { names: hold, via: 'hold' }
  const spell = seenSpell(ev)
  if (spell) return { names: spell, via: 'spell' }
  return null
}

/** Somebody swung at it, or it swung at somebody. `attacker` is null on caster-less DoT lines. */
function seenCombat(ev: LogEvent): (string | null | undefined)[] | null {
  if (ev.kind === 'damage' || ev.kind === 'miss') return [ev.attacker, ev.target]
  if (ev.kind === 'heal') return [ev.healer, ev.target]
  return null
}

/** A mez / root / charm landed on it, broke on it, or wore off it. */
function seenHold(ev: LogEvent): (string | null | undefined)[] | null {
  if (ev.kind === 'cc' || ev.kind === 'ccWake' || ev.kind === 'charm' || ev.kind === 'uncharm') {
    return [ev.mob]
  }
  return null
}

/** A spell named it — as a resister, as a caster, or as the thing something landed on. */
function seenSpell(ev: LogEvent): (string | null | undefined)[] | null {
  if (ev.kind === 'resist') return [ev.caster, ev.target]
  if (ev.kind === 'otherCastBegin') return [ev.caster]
  if (ev.kind === 'buffApply' || ev.kind === 'poisonProc') return [ev.target]
  return null
}

/**
 * The committed floor, indexed once at module load.
 *
 * `respawnsJson` types itself structurally off the JSON, which is assignable to `WikiRespawnData`
 * already — the annotation is here to say WHICH declared shape this file is reading, not to widen
 * anything, so it is a variable annotation rather than a cast.
 */
const FLOOR: WikiRespawnData = respawnsJson
const WIKI = new Map<string, WikiRespawn>(FLOOR.rows.map((r) => [r.key, r]))

export class RespawnModule implements EqModule<RespawnSnap, RespawnDelta> {
  readonly id = 'respawn'
  private history = new Map<string, MobHistory>()
  private zone = ''
  /** When the current continuous stay in `zone` began. Zero before any zone line. */
  private zoneSince = 0
  private prefs: RespawnPrefs = DEFAULT_RESPAWN_PREFS
  /** THE MODULE'S OWN REVISION — see the header. Never a LogEvent seq. */
  private rev = 0
  private dirty = false
  /** The last wall-clock tick, so `snapshot()` prunes against the same clock `onTick` does. */
  private nowMs = Date.now()

  /**
   * The watch list as a lookup, rebuilt whenever the list changes.
   *
   * NOT a micro-optimization: round 3 put `watchOf` on the HOTTEST path in this module. Every
   * damage and miss line in the log now asks it two questions, and the historical fold walks
   * months of them — a linear scan of up to RESPAWN_MAX_WATCHES entries per name would be tens of
   * millions of string comparisons before the app has finished starting. The list itself stays the
   * authority (it is what is persisted and what the snapshot publishes); this is derived from it in
   * one place so the two cannot disagree.
   */
  private watchIndex = new Map<string, RespawnWatchPref>()

  constructor(prefs?: RespawnPrefs) {
    if (prefs) this.prefs = prefs
    this.reindexWatches()
  }

  private reindexWatches(): void {
    this.watchIndex = new Map(this.prefs.watches.map((w) => [w.key, w]))
  }

  reset(): void {
    this.history = new Map()
    this.zone = ''
    this.zoneSince = 0
    // Re-read the wall clock: a reset opens a fresh fold, and the expiry sweep in `build` has to
    // judge it against now rather than against whenever this module was constructed.
    this.nowMs = Date.now()
    this.rev++
    this.dirty = true
  }

  /**
   * The user edited the watch list. Bumps the revision so the push is not deduped, and marks the
   * state dirty so the next flush carries it; the IPC handler additionally calls `flushNow()`.
   */
  setPrefs(prefs: RespawnPrefs): void {
    this.prefs = prefs
    this.reindexWatches()
    this.rev++
    this.dirty = true
  }

  getPrefs(): RespawnPrefs {
    return this.prefs
  }

  onEvent(ev: LogEvent): void {
    if (ev.kind === 'epoch') {
      // A character rebirth invalidates the LIVE clocks (they were another character's evening),
      // and takes the learned gaps with them for one reason only: the gaps are recomputed by the
      // very same fold that is replaying past this line, so nothing is lost that the log still
      // states. Game knowledge that persists across epochs is knowledge the log CANNOT restate.
      this.history = new Map()
      this.rev++
      this.dirty = true
      return
    }
    if (ev.kind === 'zone') {
      // A zone line ENDS the current stay and starts a new one, even when it names the same zone:
      // you left and came back, and the interval in between is not time you spent watching a
      // spawn point. Same-name re-entry is the case this would get wrong if it compared names.
      this.zone = ev.zone
      this.zoneSince = ev.ts
      // AND THE REVISION MOVES, because the zone is now part of what the screen shows (the display
      // is zone-scoped). `dirty` alone only decides whether a delta is BUILT; `useModule` then
      // drops it with `d.seq <= knownSeq`, and a zone line moves no other state in this module —
      // no death, no watch edit — so the push carrying "you are somewhere else now" was the one
      // push the dedupe was guaranteed to swallow. MEASURED in the e2e before this line existed:
      // both surfaces kept drawing the old zone's clocks for as long as the log stayed quiet.
      this.rev++
      this.dirty = true
      return
    }
    if (ev.kind === 'death') {
      if (!isCountedKill(ev)) return
      this.recordDeath(idKey(ev.name), ev.name, ev.ts)
      return
    }
    // EVERYTHING ELSE IS POSSIBLE EVIDENCE THAT A WATCHED MOB IS UP (round 3). A death is checked
    // first and returns, so the corpse can never mark its own row seen.
    const seen = seenNamesOf(ev)
    if (seen) for (const name of seen.names) this.markSeen(name, seen.via, ev.ts)
  }

  /**
   * The log named something. Mark it seen if — and only if — it is a mob the user watches and this
   * fold has a clock for it in the zone the fold is standing in.
   *
   * THE TWO GUARDS ARE THE POINT. Watching is the admission rule for everything in this module
   * (the opt-in ruling), so an unwatched name is dropped before it can cost anything, which is
   * what makes it acceptable to run this over every combat line in a dungeon. And the entry is
   * looked up under the CURRENT zone's id, so the only row a sighting can light is one for where
   * you are standing — no cross-zone leak, and no second zone tracker.
   *
   * A WATCHED MOB YOU HAVE NEVER KILLED HERE GETS NOTHING, and that is a stated limit rather than
   * an oversight: a row's clock is measured from a death, so there is no row to light. The
   * discovery surface still shows nothing about it either. Admitting a row from a sighting alone
   * would be a fourth kind of thing on this screen and the owner has not asked for one.
   */
  private markSeen(name: string | null | undefined, via: RespawnSeenVia, ts: number): void {
    if (name === null || name === undefined || name.length === 0) return
    const key = idKey(name)
    if (this.watchOf(key) === null) return
    const h = this.history.get(`${idKey(this.zone)}::${key}`)
    if (!h) return
    // A mention from before the clock started is not a sighting of the spawn the clock is about,
    // so the transition is judged against the base rather than against the previous `seenTs`.
    const wasSeen = h.seenTs !== undefined && h.seenTs > baseOf(h)
    if (h.seenTs !== undefined && ts < h.seenTs) return
    h.seenTs = ts
    h.seenVia = via
    if (wasSeen && ts - (h.seenPubTs ?? 0) < SEEN_REFRESH_MS) return
    h.seenPubTs = ts
    this.rev++
    this.dirty = true
  }

  /**
   * "YES, THAT SIGHTING WAS THE SPAWN — START THE CLOCK THERE" (owner ruling, round 3).
   *
   * The one thing a sighting is never allowed to do on its own. `id` is the row's own id, which is
   * how the surfaces name a row and how this fold keys its history — one identifier, no second
   * addressing scheme to keep in step. Returns false when the id is unknown or when the row is not
   * currently seen, so a stale click (the mob died between render and press) is a no-op rather
   * than a clock re-based onto an instant nothing is claiming any more.
   */
  confirmSighting(id: string): boolean {
    const h = this.history.get(id)
    if (!h) return false
    if (h.seenTs === undefined || h.seenTs <= baseOf(h)) return false
    h.confirmedTs = h.seenTs
    this.rev++
    this.dirty = true
    return true
  }

  private recordDeath(key: string, display: string, ts: number): void {
    const id = `${idKey(this.zone)}::${key}`
    const prior = this.history.get(id)
    const h: MobHistory = prior ?? { key, display, zone: this.zone, lastTs: 0, samples: 0, kills: 0, gaps: [] }
    if (prior) {
      // Re-insert so the Map's iteration order is the LRU order (oldest first).
      this.history.delete(id)
      // The gap qualifies only when the EARLIER death is inside the current stay. `zoneSince` is
      // zero before the scan has seen any zone line, and a zero start would qualify everything,
      // so a stay that never began qualifies nothing.
      const gap = ts - h.lastTs
      if (this.zoneSince > 0 && h.lastTs >= this.zoneSince && gap >= MIN_GAP_MS) {
        h.minGapMs = h.minGapMs === undefined ? gap : Math.min(h.minGapMs, gap)
        h.samples++
        // The working, for the row to print (round 7). Oldest first here and reversed on the way
        // out, so the cap drops the OLDEST rather than the freshest evidence.
        h.gaps.push(gap)
        if (h.gaps.length > RESPAWN_MAX_GAPS) h.gaps.shift()
      }
    }
    h.lastTs = ts
    h.kills++
    h.display = display
    this.history.set(id, h)
    while (this.history.size > MAX_HISTORY) {
      const oldest = this.history.keys().next()
      if (oldest.done) break
      this.history.delete(oldest.value)
    }
    this.rev++
    this.dirty = true
  }

  /**
   * KEEP THE FOLD'S CLOCK CURRENT, and nothing else. Live tail only; the registry never ticks a
   * replay.
   *
   * IT PUBLISHES NOTHING ON ITS OWN ANY MORE (round 8). It used to count the rows that were still
   * inside the linger and mark the module dirty when that number changed, because a row could STOP
   * EXISTING purely because time passed. Nothing does that now — `rowFor` no longer consults the
   * clock at all, so the set of rows changes only when a death, a watch edit, a zone line or a
   * sighting changes it, and every one of those already bumps `rev` and sets `dirty`. What the
   * clock still buys is the ORDER `build` publishes in, so it is recorded here and read there.
   *
   * The time-driven parts of a row — a countdown running down, a sighting going stale, a clock
   * passing into `stale` — are all derived by the RENDERER from `baseTs`/`seenTs` against its own
   * 1 Hz clock (that is why a row carries them), so none of them needs a push to be seen.
   */
  onTick(nowMs: number): void {
    this.nowMs = nowMs
  }

  /**
   * Is this mob watched? Returns null when it is not — which is every mob, until the player says
   * otherwise.
   *
   * THE ONLY ADMISSION RULE IS THE WATCH LIST (owner ruling, 2026-08-10 — the opt-in paragraph in
   * shared/respawn.ts carries the argument). The prototype also admitted the 394 mobs the
   * committed floor gives a duration for, and that is gone: EQ's names are duplicated across
   * zones and spawn points, so a clock nobody asked for is a clock about a mob the app cannot
   * identify. The wiki still NUMBERS a watched row (`rowFor`) and still floors it; it no longer
   * decides that a row exists.
   */
  private watchOf(key: string): { customMs?: number } | null {
    const explicit = this.watchIndex.get(key)
    if (!explicit) return null
    return explicit.customSec === undefined ? {} : { customMs: explicit.customSec * 1000 }
  }

  /**
   * ONE HISTORY ENTRY AS A ROW, or null when the mob is not watched — and that is now the ONLY
   * reason this returns null (owner ruling, round 8).
   *
   * IT USED TO SWEEP, and that was the defect: it ran `respawnRowExpired` on the row it had just
   * built and threw away anything whose estimate had elapsed more than half an hour ago. A player
   * clicking Watch on a kill from hours earlier therefore got a successful write, a bumped
   * revision, a pushed delta — and no row, because the row was born past the window. The linger's
   * two remaining jobs are READINGS and live in `shared/respawn.ts`; nothing here refuses to
   * publish a mob the user is watching.
   *
   * It no longer takes the clock either: nothing it computes depends on `now`, which is what lets
   * `onTick` stop republishing.
   */
  private rowFor(h: MobHistory): RespawnRow | null {
    const watch = this.watchOf(h.key)
    if (!watch) return null
    const wiki = WIKI.get(h.key)
    const wikiMs = wiki?.seconds !== undefined ? wiki.seconds * 1000 : undefined
    const est = resolveRespawn({
      customMs: watch.customMs,
      observedMs: h.minGapMs,
      samples: h.samples,
      wikiMs
    })
    const base = baseOf(h)
    const row: RespawnRow = {
      id: `${idKey(h.zone)}::${h.key}`,
      key: h.key,
      display: h.display,
      zone: h.zone,
      baseTs: base,
      basis: base === h.lastTs ? 'death' : 'sighting',
      source: est.source,
      samples: h.samples,
      kills: h.kills
    }
    attachSeen(row, h, base)
    if (est.estimateMs !== undefined) row.estimateMs = est.estimateMs
    if (h.minGapMs !== undefined) row.observedMs = h.minGapMs
    // NEWEST FIRST on the wire (the row reads left to right and the freshest gap is the one worth
    // reading), and a COPY, so a renderer holding a snapshot can never see the fold mutate it.
    if (h.gaps.length > 0) row.gapsMs = [...h.gaps].reverse()
    // Rung 1's number, so the row's own seconds box has something to open with (round 7).
    if (watch.customMs !== undefined) row.customMs = watch.customMs
    if (wiki) row.wikiText = wiki.text
    if (wikiMs !== undefined) row.wikiMs = wikiMs
    // ROUND 9: the page those words came from, so the edit modal can LINK to it. The scrape has
    // carried this title since the floor was written (`WikiRespawn.page`) and nothing had read it —
    // quoting a source the reader cannot open is the half of provenance this feature was missing.
    if (wiki) row.wikiPage = wiki.page
    return row
  }

  private build(nowMs: number): RespawnSnap {
    const rows: RespawnRow[] = []
    const recent: RespawnCandidate[] = []
    // The Map iterates oldest-first (the LRU order), so walk it backwards for "most recent".
    const entries = [...this.history.values()].sort((a, b) => b.lastTs - a.lastTs)
    for (const h of entries) {
      const row = this.rowFor(h)
      if (row && rows.length < RESPAWN_MAX_ROWS) rows.push(row)
      if (recent.length < RESPAWN_MAX_RECENT) {
        const wiki = WIKI.get(h.key)
        const cand: RespawnCandidate = {
          key: h.key,
          display: h.display,
          zone: h.zone,
          lastTs: h.lastTs,
          kills: h.kills,
          watched: this.watchOf(h.key) !== null
        }
        if (wiki) cand.wikiText = wiki.text
        if (wiki?.seconds !== undefined) cand.wikiMs = wiki.seconds * 1000
        recent.push(cand)
      }
    }
    return {
      v: RESPAWN_SHAPE_VERSION,
      zone: this.zone,
      rows: orderRespawnRows(rows, nowMs),
      recent,
      prefs: this.prefs
    }
  }

  snapshot(): { seq: number; state: RespawnSnap } {
    return { seq: this.rev, state: this.build(this.nowMs) }
  }

  flushDelta(): { seq: number; delta: RespawnDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.rev, delta: this.build(this.nowMs) }
  }
}

/**
 * What the committed floor says about a mob, for the IPC layer's benefit (the watch editor shows
 * the wiki's verbatim text beside a mob you are about to add). Exported rather than re-indexed:
 * one Map, one answer.
 */
export function wikiRespawnFor(key: string): WikiRespawn | undefined {
  return WIKI.get(key)
}
