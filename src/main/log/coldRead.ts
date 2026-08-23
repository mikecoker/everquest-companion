// coldRead.ts — how much of a startup fold was bytes nobody had read yet (JOS-57 scope addition).
//
// ONE RULE, IN ONE PLACE, AND PURE. The store persists where the tail had read to when this app
// last shut down cleanly (`storeShape.ts LogTailMark`); the scan reports where the log ends now.
// The difference is the discriminator the fleet startup reading was missing: every other number it
// carries scales with the WHOLE log, and the on-access-scanner hypothesis for a slow first launch
// predicts the cost scales with the part of it the machine has never cached.
//
// It lives here rather than inside session.ts because it is the half of that wiring that can be
// WRONG — and being wrong here means publishing a number nobody measured, which is the one failure
// this whole measurement is meant to avoid. No Electron, no store, no clock: `tests/
// startupDiscriminators.test.mts` drives it directly.

/** What the last clean shutdown left behind. Structurally the store's `LogTailMark`, named by the
 *  only field this rule reads, so nothing here depends on the store's shape. */
export interface TailMark {
  offset: number
}

/**
 * Bytes the log grew by since `mark` was written, or UNDEFINED when the question has no answer.
 *
 * BOTH SIDES ARE THE FILE'S SIZE, observed the same way — the mark is the tailer's offset, which
 * advances to the size at every read, and `sizeNow` is the scan's frozen EOF. That symmetry is
 * load-bearing rather than incidental: subtracting the scan's `endOffset` (the last COMPLETE line)
 * instead would go a few bytes negative whenever the log happened to end mid-line, and the "it
 * rotated" branch below would fire on a partial line.
 *
 * TWO ABSENCES, and neither is a zero:
 *   * NO MARK — a first run, or the launch after a crash. There is no previous exit to measure
 *     from, so this launch simply does not contribute to the population.
 *   * A MARK PAST THE END — the log rotated or was truncated under it. The delta would be
 *     negative, and what actually happened is that the fold read the whole file, which the reading
 *     already states as its log size. A clamp to 0 here would claim the launch had nothing new to
 *     read, which is the opposite of the truth.
 *
 * A non-finite offset is treated as no mark at all: the store validates on the way out, so this is
 * the second of the two doors, not the only one.
 */
export function newBytesSince(mark: TailMark | undefined, sizeNow: number): number | undefined {
  if (mark === undefined || !Number.isFinite(mark.offset) || !Number.isFinite(sizeNow)) {
    return undefined
  }
  if (mark.offset > sizeNow) return undefined
  return sizeNow - mark.offset
}
