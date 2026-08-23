import { EventEmitter } from 'events'
import { open, stat, type FileHandle } from 'fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import { noteTailRead, type TailIoSample, type TailReopenReason } from './tailIoStats'

export interface TailerOptions {
  /** If true, read the whole file from the start; otherwise start at EOF. */
  fromStart?: boolean
  /**
   * Explicit byte offset to resume from (takes precedence over `fromStart`).
   * Used for a gapless handoff from the initial scan: the scan reports the byte
   * offset it stopped at and the tailer picks up exactly there, so lines the game
   * appended during the scan are read (not skipped) and none are double-read.
   */
  startOffset?: number
  /** Poll interval in ms (polling is more reliable for game-appended logs). */
  pollInterval?: number
}

/**
 * THE MOST BYTES ONE READ MAY ASK FOR (JOS-363).
 *
 * EverQuest writes its log SYNCHRONOUSLY from the game thread, so anything that delays its append
 * is a frame it did not draw. An append that extends the file needs the NTFS file resource
 * exclusively; one uncapped `read` of a whole delta holds that resource shared for the length of
 * the read, and the delta after a stall or a busy raid is not small. Slicing turns one long hold
 * into a run of short ones with a yield between them — the game gets a gap to append into, and the
 * main process gets its event loop back between slices instead of after the lot.
 *
 * 256 KiB is ~2500 log lines: far more than a poll interval of real play produces (the steady-state
 * read is a few KiB and takes exactly one slice), and small enough that a slice is a single-digit
 * millisecond read off a warm file. The constant is exported because the tests assert on the number
 * of slices a stated burst takes, and a test that guessed it would silently stop testing anything.
 */
export const TAIL_READ_SLICE_BYTES = 256 * 1024

/**
 * The Tailer's event map — the typed public surface of `on`/`once`/`emit`:
 *   'line'  — one complete raw line (no trailing newline / `\r`).
 *   'error' — a stat/read/watch failure; the tailer keeps running.
 * Declared as a generic argument to EventEmitter rather than as an `interface Tailer`
 * declaration-merged onto the class: same signatures, same runtime class, but nothing can
 * silently claim a member the class doesn't implement.
 */
interface TailerEvents {
  line: [raw: string]
  error: [err: unknown]
}

/** The one read cycle's costs, filled in as it goes and handed to the stats seam at the end. */
interface ReadMetrics {
  statMs: number
  openMs: number
  readMs: number
  bytes: number
  slices: number
  reason: TailReopenReason
}

/** Hand the event loop back. Not a pause (AGENTS.md: a main-process timer snaps to a 15.6 ms
 *  grid and `setImmediate` is not a sleep at all) — a slice boundary wants exactly a yield. */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Tails a single growing text file. Tracks a byte offset, reads only appended
 * bytes on each change, and emits one 'line' event per complete raw line (the
 * caller parses it — the Tailer stays purely byte-level). Survives log
 * rotation/truncation by resetting the offset when the file shrinks.
 */
export class Tailer extends EventEmitter<TailerEvents> {
  private readonly path: string
  private readonly fromStart: boolean
  private readonly startOffset?: number
  private readonly pollInterval: number
  private offset = 0
  /**
   * The trailing partial line, AS BYTES — the game has not written its newline yet.
   *
   * Bytes rather than decoded text since JOS-363, and the slicing is why. A poll boundary used to
   * fall wherever EQ's own write ended, which is always a whole line, so decoding each delta on its
   * own was safe. A SLICE boundary falls at a fixed byte count and lands wherever it lands —
   * mid-line, and just as easily mid-CHARACTER. Decoding a slice that ends inside a multi-byte
   * sequence yields U+FFFD and destroys the character permanently, so nothing is decoded until its
   * terminating newline is in hand: `consume` splits on the newline BYTE and carries the tail
   * forward. That also makes `checkpointOffset` exact arithmetic instead of a re-encode.
   */
  private leftover: Buffer = Buffer.alloc(0)
  private watcher?: FSWatcher
  private reading = false
  private pending = false
  /**
   * THE PERSISTENT READ HANDLE (JOS-363), and the reason it is deliberately held open on a file
   * ANOTHER PROCESS IS APPENDING TO.
   *
   * The tail used to `open` and `close` around every read — up to ~2/sec in combat. On Windows
   * each of those opens is an on-access-scan trigger for Defender's minifilter against a file that
   * is routinely hundreds of MB, and a share-mode negotiation against EQ's own handle, all of it
   * on the path of a game that writes its log synchronously from the render thread. Holding ONE
   * read handle costs the game nothing (a shared read handle never blocks its append), and turns
   * every subsequent poll into a `stat` on an already-open handle — no name lookup, no negotiation,
   * no scan.
   *
   * FOUR THINGS FORCE A REOPEN, and they are exactly the cases where the handle stops describing
   * the file at the path:
   *   • `first`    — there isn't one yet (or a failure dropped it).
   *   • `replaced` — the path vanished and came back. An open handle follows the file it opened,
   *                  not the name, so a rotated-by-replacement log would grow forever unseen. This
   *                  is the case a `stat` BY PATH used to cover for free, and losing it silently is
   *                  the one real hazard of holding a handle; `unlink` → `add` from the watcher is
   *                  the evidence, and the reopen deliberately does NOT reset the offset — the
   *                  shrink branch below decides that from the new file's actual size.
   *   • `shrunk`   — the file is smaller than our offset (truncate/rotate in place).
   *   • `error`    — `stat`/`read` on the handle failed (EBADF/EINVAL and friends): the handle is
   *                  suspect, so it is dropped and the next cycle opens a fresh one.
   * Every one of those is counted under its own name in `tailIoStats`, so "steady state opens
   * nothing" is a measurement rather than a claim.
   */
  private fh: FileHandle | null = null
  /** The reason the NEXT open will carry, or null when the handle in hand is trusted. */
  private pendingOpen: TailReopenReason | null = 'first'
  /** The watcher saw the path disappear; the next `add` is a different file. */
  private vanished = false
  /**
   * `stop()` has been called. IT GUARDS THE HANDLE, which is new work a stopped tail can now do:
   * a read already in flight when the watcher closed will finish, and its `pending` re-entry would
   * schedule one more cycle — a cycle that would OPEN THE FILE AGAIN, after `stop` had closed it
   * and with nothing left to ever close it. Character switching stops a tail and starts another,
   * so that is a handle leaked per switch rather than a corner case. It also silences the EBADF
   * this raced into: a read torn down mid-flight is a shutdown, not something to file as an error.
   */
  private stopped = false

  constructor(path: string, opts: TailerOptions = {}) {
    super()
    this.path = path
    this.fromStart = opts.fromStart ?? false
    this.startOffset = opts.startOffset
    this.pollInterval = opts.pollInterval ?? 400
  }

  async start(): Promise<void> {
    this.stopped = false
    try {
      const s = await stat(this.path)
      if (this.startOffset != null) {
        // Resume from the scan's handoff point. Clamp to current size in case the
        // file shrank (rotation/truncation) between scan and tail start.
        this.offset = Math.min(this.startOffset, s.size)
      } else {
        this.offset = this.fromStart ? 0 : s.size
      }
    } catch {
      this.offset = this.startOffset ?? 0
    }

    this.watcher = chokidar.watch(this.path, {
      persistent: true,
      usePolling: true,
      interval: this.pollInterval,
      awaitWriteFinish: false
    })

    this.watcher.on('add', () => {
      // Only a RE-appearance forces a reopen. Chokidar emits `add` for an already-existing file on
      // its first scan, and treating that as a replacement would open the file twice on every
      // launch — which is the exact cost this change exists to remove.
      if (this.vanished && this.fh) this.pendingOpen = 'replaced'
      this.vanished = false
      this.scheduleRead()
    })
    this.watcher.on('unlink', () => {
      this.vanished = true
    })
    this.watcher.on('change', () => this.scheduleRead())
    this.watcher.on('error', (err) => this.emit('error', err))

    // Read immediately when reading from start or resuming from a scan offset, so
    // any bytes appended during the scan are picked up without waiting for a poll.
    if (this.fromStart || this.startOffset != null) this.scheduleRead()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.watcher?.close()
    this.watcher = undefined
    await this.dropHandle()
  }

  /**
   * How far into the file this tail has read, in bytes (JOS-57 scope addition).
   *
   * The one reader is the clean-shutdown mark (`session.ts stopSession` → `setLogTailMark`), which
   * needs the tail's own answer rather than a fresh `stat()`: what the next launch wants to know is
   * how many bytes NOBODY HAS READ, and the file may well have grown since the last read. It is a
   * getter over the same field `readNew` maintains, so it cannot drift from the handoff offset —
   * and it is 0 before `start()` has resolved, which reads correctly as "this tail read nothing".
   */
  readOffset(): number {
    return this.offset
  }

  /**
   * THE BYTE OFFSET THE FOLD'S KNOWLEDGE REACHES — the end of the last COMPLETE line emitted.
   *
   * NOT `this.offset`, and the difference is the whole reason this method exists. `offset` is how
   * far the tailer has READ, which includes a trailing partial line the game has not finished
   * writing; that line has been emitted to nobody. Anything claiming "the state I hold is
   * `fold(bytes [0, b))`" needs `b` to be exactly where the emitted lines stop — the same
   * definition `ScanResult.endOffset` uses, and the same reason it uses it.
   *
   * `leftover` is BYTES (JOS-363), so the subtraction is the arithmetic itself rather than a
   * re-encode of decoded text. That is not a tidy-up: the old form re-measured `Buffer.byteLength`
   * of a string that had already been through the decoder, so a partial line whose last character
   * was itself cut in half by a read boundary would have been measured after the decoder had
   * already replaced it with U+FFFD — three bytes claimed for one, and `b` pointing at a byte no
   * line starts at. Carrying the undecoded tail makes that shape unrepresentable.
   *
   * THE SIBLING ABOVE IS THE OTHER ANSWER, AND THE TWO MUST NOT BE SWAPPED. `readOffset()` (JOS-57)
   * is the READ cursor, and the cold-read delta wants exactly that — how many bytes nobody has
   * read; the tail mark `markTailPosition` writes is that one. This one is where the FOLD's
   * knowledge stops. They differ by at most one partial line, which is nothing to a byte-count
   * bucket and everything to a claim about what has been folded.
   */
  checkpointOffset(): number {
    return Math.max(0, this.offset - this.leftover.length)
  }

  /** Coalesce rapid change events into sequential reads. */
  private scheduleRead(): void {
    if (this.stopped) return
    if (this.reading) {
      this.pending = true
      return
    }
    void this.readNew()
  }

  private async readNew(): Promise<void> {
    this.reading = true
    const m: ReadMetrics = { statMs: 0, openMs: 0, readMs: 0, bytes: 0, slices: 0, reason: 'reused' }
    try {
      const next = await this.nextRead(m)
      if (next !== null) await this.readSlices(next.fh, next.size, m)
    } catch (err) {
      // The handle is the prime suspect for anything that threw in here — drop it and let the next
      // cycle open a fresh one under the `error` reason, so the reopen is COUNTED rather than
      // hidden inside a retry.
      await this.dropHandle()
      this.pendingOpen = 'error'
      if (!this.stopped) this.emit('error', err)
    } finally {
      // Recorded even when the cycle threw: a read that failed is exactly what this measures.
      noteTailRead({ at: Date.now(), ...m } satisfies TailIoSample)
      this.reading = false
      if (this.pending) {
        this.pending = false
        this.scheduleRead()
      }
    }
  }

  /**
   * The handle and the size to read up to, or null when there is nothing new. OWNS EVERY REOPEN
   * DECISION — see the `fh` field for why each of them forces one.
   */
  private async nextRead(m: ReadMetrics): Promise<{ fh: FileHandle; size: number } | null> {
    let fh = await this.ensureHandle(m)
    let size = await this.statSize(fh, m)
    if (size === null) {
      // A `stat` the OS refused on a handle we hold: EBADF/EINVAL, i.e. the handle and the file
      // have parted company. One retry on a fresh one — if that fails too, the failure is the
      // file's rather than the handle's and belongs in the cycle's error path.
      m.reason = 'error'
      fh = await this.openHandle(m)
      size = await this.statSize(fh, m)
      if (size === null) throw new Error('Tailer: stat failed on a freshly opened handle')
    }
    if (size < this.offset) {
      // File truncated/rotated — restart from the beginning, on a fresh handle (the old one may be
      // following a file that is no longer at this path at all).
      this.offset = 0
      this.leftover = Buffer.alloc(0)
      m.reason = 'shrunk'
      fh = await this.openHandle(m)
    }
    return size > this.offset ? { fh, size } : null
  }

  /** Open only if there is no trusted handle; record WHY under the reason that forced it. */
  private async ensureHandle(m: ReadMetrics): Promise<FileHandle> {
    const fh = this.fh
    if (fh && this.pendingOpen === null) return fh
    m.reason = fh ? (this.pendingOpen ?? 'first') : 'first'
    return this.openHandle(m)
  }

  private async openHandle(m: ReadMetrics): Promise<FileHandle> {
    const t = performance.now()
    await this.dropHandle()
    const fh = await open(this.path, 'r')
    this.fh = fh
    this.pendingOpen = null
    m.openMs += performance.now() - t
    return fh
  }

  private async dropHandle(): Promise<void> {
    const fh = this.fh
    this.fh = null
    this.pendingOpen = 'first'
    if (!fh) return
    try {
      await fh.close()
    } catch {
      // A handle we are throwing away anyway; a close failure has nowhere useful to go.
    }
  }

  /**
   * `stat` on the OPEN HANDLE, not on the path — fewer name lookups, and it reads the live size of
   * the very file this tail is reading rather than of whatever currently answers to the name.
   * `null` (not a throw) when the OS refused, so the caller owns the one-retry policy in one place.
   */
  private async statSize(fh: FileHandle, m: ReadMetrics): Promise<number | null> {
    const t = performance.now()
    try {
      const s = await fh.stat()
      m.statMs += performance.now() - t
      return s.size
    } catch {
      m.statMs += performance.now() - t
      return null
    }
  }

  /** Read `[offset, size)` in bounded slices, yielding between them. */
  private async readSlices(fh: FileHandle, size: number, m: ReadMetrics): Promise<void> {
    while (this.offset < size && !this.stopped) {
      const len = Math.min(TAIL_READ_SLICE_BYTES, size - this.offset)
      const buf = Buffer.allocUnsafe(len)
      const t = performance.now()
      const { bytesRead } = await fh.read(buf, 0, len, this.offset)
      m.readMs += performance.now() - t
      if (bytesRead <= 0) break // the file shrank under us; the next cycle's stat will say so
      m.slices++
      m.bytes += bytesRead
      this.offset += bytesRead
      this.consume(bytesRead === len ? buf : buf.subarray(0, bytesRead))
      if (this.offset < size) await yieldToLoop()
    }
  }

  /**
   * Split appended BYTES into complete lines. Splitting on the newline byte rather than on decoded
   * text is what lets a slice boundary land anywhere: a multi-byte character straddling one is
   * still whole when its line's newline finally arrives, because neither half was ever decoded on
   * its own.
   */
  private consume(chunk: Buffer): void {
    const data = this.leftover.length > 0 ? Buffer.concat([this.leftover, chunk]) : chunk
    let start = 0
    for (let nl = data.indexOf(0x0a, start); nl !== -1; nl = data.indexOf(0x0a, start)) {
      const end = nl > start && data[nl - 1] === 0x0d ? nl - 1 : nl
      if (end > start) this.emit('line', data.toString('utf8', start, end))
      start = nl + 1
    }
    // COPIED, never a view: `data` may be a slice-sized read buffer, and keeping a subarray of it
    // as the carry would pin the whole 256 KiB alive for the sake of a partial line.
    this.leftover = start >= data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(start))
  }
}
