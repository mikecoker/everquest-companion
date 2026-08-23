// A minimal, synchronous, in-main event bus for the canonical LogEvent stream.
//
// Both feeders (the historical scan and the live tailer) call emit(); every
// consumer (loot/kills/levels/AA reducers, the combat engine, the coming world
// model + extension framework) subscribes. Subscribers fire in registration
// order, synchronously, in the emitting call stack — no async, no queue — so the
// scan's strict file order is preserved end-to-end and reducers see events in the
// exact sequence the log produced them.
//
// `live` distinguishes the two feeders: false during the initial historical
// replay, true for lines the game appends while the app runs. Consumers use it to
// gate side effects that should only happen live (IPC pushes, classification-ring
// logging) while still folding historical events into their snapshot state.

import type { LogEvent } from '../../shared/logEvents'
// THE ONE CHOKE POINT (JOS-100). Both feeders and the derived drain pass through `emit`, which
// makes it the only place a breadcrumb ring can see everything exactly once. `breadcrumbs.ts`
// imports NOTHING — it has to, to be callable from here — and a push is three slot writes into
// preallocated arrays with no clock read and no allocation, which is what the hot path's
// discipline requires (see that file's header, and `linesPending` in telemetry/collector.ts).
import { noteEventKind } from '../telemetry/breadcrumbs'

export type LogEventListener = (ev: LogEvent, live: boolean) => void

/** One queued DERIVED event awaiting delivery (see `LogBus.derived`). */
interface DerivedEvent {
  ev: LogEvent
  live: boolean
}

/**
 * THE DERIVED-DRAIN SEAM (JOS-55): the bench's per-consumer attribution needs the drain to be its
 * own row, not a silent surcharge on every module's number.
 *
 * A derived event (`buffExpired`, `epoch`, `offlineGap`) travels the SAME listener loop as a
 * primary one, so a timer wrapped around the listeners cannot tell the two apart — the modules'
 * totals would quietly include work done on somebody else's behalf, and "the derived drain costs
 * X" could only ever be a guess. So the bus brackets the drain and the probe brackets with it:
 * `start()` before the first derived delivery, `end(count, ms)` after the last, and the bench's
 * dispatch timer routes everything in between into a separate bucket. Rows that way are disjoint
 * and add up.
 *
 * A constructor argument, absent everywhere except the bench (`replaySlicer.ts`'s precedent, and
 * pipeline.ts constructs its bus with none): with no probe the emit path is the one that always
 * ran, and there is no clock read per event to pay for.
 */
export interface LogBusProbe {
  /** A derived drain is beginning. */
  start(): void
  /** …and it is over: `count` derived events delivered in `ms`. Never called for an empty drain. */
  end(count: number, ms: number): void
}

export class LogBus {
  private listeners: LogEventListener[] = []
  /**
   * DERIVED-event queue (Task #47). A consumer (the buffs module) may synthesize a RESOLVED
   * event (`buffExpired`) while folding a primary event and hand it back to the bus via
   * emitDerived(). We queue it rather than emit it inline so we never re-enter the listener
   * loop mid-delivery; it is drained AFTER the current primary event finishes reaching every
   * listener, then delivered through the SAME listener loop (so a later-registered consumer —
   * e.g. alerts — sees it). No feedback loop is possible: buffs, the only producer, ignores
   * `buffExpired`, so a derived event never spawns another. `live` is inherited from the
   * primary event so a replayed wear-off stays live:false (alerts never fire on replay).
   */
  private derived: DerivedEvent[] = []
  private delivering = false

  /** The bench's derived-drain observer (JOS-55). Undefined in the app, always. */
  constructor(private probe?: LogBusProbe) {}

  /** Register a listener; returns an unsubscribe fn. Order is registration order. */
  subscribe(fn: LogEventListener): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** Synchronously deliver an event to all subscribers in registration order. */
  emit(ev: LogEvent, live: boolean): void {
    // BEFORE the listeners, so a crumb exists for the event a listener is about to throw on —
    // which is precisely the event a reader of that crash most wants to see.
    noteEventKind(ev.kind, ev.ts)
    for (const fn of this.listeners) fn(ev, live)
    // Drain any derived events synthesized during this delivery (and any they in turn
    // synthesize — though in practice buffs never derives from a derived event). The
    // `delivering` guard means a nested emit() (should one ever occur) doesn't double-drain.
    if (this.delivering) return
    this.delivering = true
    try {
      if (this.probe) this.timedDrain(this.probe)
      else this.drain()
    } finally {
      this.delivering = false
    }
  }

  /**
   * Deliver every queued derived event, and anything they in turn queue.
   *
   * Shift-until-empty: `shift()` returns undefined exactly when the queue is empty, so the loop
   * condition is also the proof that `next` is defined inside the body.
   */
  private drain(): void {
    let next: DerivedEvent | undefined
    while ((next = this.derived.shift()) !== undefined) {
      // Derived events get a crumb too (`epoch` is one of the most informative there is), and
      // for the same reason as above: before the listeners that might throw on it.
      noteEventKind(next.ev.kind, next.ev.ts)
      for (const fn of this.listeners) fn(next.ev, next.live)
    }
  }

  /** The same drain, bracketed for the bench (see LogBusProbe). Two clock reads per emit that
   *  actually had something to drain, and none at all on the ordinary path. */
  private timedDrain(probe: LogBusProbe): void {
    if (this.derived.length === 0) return
    probe.start()
    const t0 = performance.now()
    let count = 0
    let next: DerivedEvent | undefined
    while ((next = this.derived.shift()) !== undefined) {
      count += 1
      // Derived events get a crumb too (`epoch` is one of the most informative there is), and
      // for the same reason as above: before the listeners that might throw on it.
      noteEventKind(next.ev.kind, next.ev.ts)
      for (const fn of this.listeners) fn(next.ev, next.live)
    }
    probe.end(count, performance.now() - t0)
  }

  /**
   * Queue a DERIVED event (Task #47) to be delivered after the current primary event. Called
   * by a consumer from inside its own onEvent while folding the primary event. See the
   * `derived` field for the no-feedback-loop rationale.
   */
  emitDerived(ev: LogEvent, live: boolean): void {
    this.derived.push({ ev, live })
  }

  /** Drop all subscribers (used when re-pointing at a new character). */
  clear(): void {
    this.listeners = []
    this.derived = []
  }
}
