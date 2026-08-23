// ============================================================================
// storeTornWrite.test.mts — JOS-272: a torn settings file does not reset the app.
// ============================================================================
//
// THE FAILURE THIS PINS. `updater.ts` applies a staged build with
// `quitAndInstall(true, true)`, which spawns the NSIS installer and then quits; the installer
// sleeps about a second and taskkills whatever is still running. A store write caught by that kill
// lands on disk half-written, and on the next boot `migrateStoreFile` cannot parse it. Until this
// ticket the whole answer was: rename it to `<name>.corrupt.json` and start from defaults. Every
// alert, character, preference and window position gone — in the one launch a user most associates
// with the app having changed something — with the recovery sitting in a file nobody could reach.
//
// WHAT IS ACTUALLY MEASURED HERE, and what deliberately is NOT:
//
//   * WHAT ELECTRON-STORE ALREADY DID IS NOT RE-TESTED. conf 10.2.0 writes every `set` through
//     `atomically` 1.7.0 — temp file, fsync, rename (node_modules/conf/dist/source/index.js:360-388
//     and node_modules/atomically/dist/index.js:111-176). "Make store saves atomic" was therefore
//     already true for the library's own writes, and a wrapper around them would have been a second
//     competing writer. The suite pins the writes this REPO makes instead, which were the ones
//     going through a bare `writeFileSync`.
//   * THE TEAR IS SIMULATED AS BYTES ON DISK, not as a killed process. A test may not arrange a
//     real taskkill mid-`write`, but it can write exactly what one leaves behind, and there are two
//     shapes: a file extended with NUL padding, and a shorter rewrite sitting in front of the tail
//     of the longer file it replaced. Both are recoverable and both are recovered.
//   * A TRUNCATED file is NOT recovered, on purpose, and that refusal is pinned as hard as the
//     recoveries. A salvage that half-restores is worse than defaults: the user cannot tell which
//     of their settings came back, and "some of your alerts" is a state nobody can act on.
//
// No Electron: `migrateStoreFile` takes a path and `hooks`, so this runs on a real temp directory
// and never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '../src/main/storeMigrations'
import { backupPathFor, migrateStoreFile, quarantinePathFor } from '../src/main/storeFile'

/** Spelled, never written as a byte — AGENTS.md's rule about raw control bytes in source. */
const NUL = '\u0000'

const STORE = 'everquest-companion-progress.json'

/** A scratch dir with the given files, cleaned up when `fn` returns. */
function inTempDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-torn-store-'))
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A current-schema store with real content in it, so "did the settings come back" is answerable. */
const LIVE_STORE = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  byCharacter: { 'primitive_freeport': { inventory: { 'Rune of Al`Kabor': 2 }, completedQuests: ['sky-1'] } },
  alerts: [{ id: 'charm-break', name: 'Charm break', sound: { packId: 'peon', soundId: 'ready' } }],
  voice: { mode: 'system' },
  windowBounds: { x: 100, y: 120, width: 1400, height: 900, maximized: false }
}

const liveJson = (): string => JSON.stringify(LIVE_STORE)

/** Collect both hook streams so a test can say exactly how much was said, and in which one. */
function runMigration(path: string): {
  out: ReturnType<typeof migrateStoreFile>
  errors: string[]
  infos: string[]
} {
  const errors: string[] = []
  const infos: string[] = []
  const out = migrateStoreFile(path, { error: (m) => errors.push(m), info: (m) => infos.push(m) })
  return { out, errors, infos }
}

// --------------------------------------------------------------------- the recoveries

test('a store torn by a kill mid-write — NUL padding — comes back whole, not as defaults', () => {
  // What Windows leaves when a write is interrupted after the file has been extended: the content
  // this app wrote, then a run of zero bytes. NUL is not legal JSON and `JSON.stringify` escapes
  // every one it is ever given, so a NUL at the tail is evidence of the tear and never of content.
  const torn = `${liveJson()}${NUL.repeat(512)}`
  inTempDir({ [STORE]: torn }, (dir) => {
    const path = join(dir, STORE)
    const { out, errors } = runMigration(path)

    assert.equal(out.salvagedFrom, 'torn-bytes')
    assert.equal(out.quarantinedPath, quarantinePathFor(path))
    assert.equal(readFileSync(quarantinePathFor(path), 'utf8'), torn, 'the torn bytes are KEPT, verbatim')
    assert.equal(out.wrote, true)

    const restored: unknown = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(restored, LIVE_STORE, 'every setting is back, byte-equal in value')

    // ONE error line, and the VERDICT comes before the paths — JOS-272 (iv) sends this line to the
    // fleet, which reads it after `redactMessage` has eaten from the first path to the end. Written
    // the obvious way round, every one of these would arrive as `store schema: <path>`.
    assert.equal(errors.length, 1)
    assert.ok(errors[0].startsWith('store schema: the store file is not valid JSON, salvaged '))
    assert.ok(errors[0].includes(path), 'the human reading errors.log still gets the full path')
    assert.equal(errors[0].indexOf(path) > errors[0].indexOf('salvaged'), true, 'but only after the verdict')
  })
})

test('a SHORTER rewrite over a longer file is salvaged, and the stale tail is discarded', () => {
  // The other tear shape, and the one a non-atomic in-place `writeFileSync` produces all by itself:
  // the new content is complete, the bytes behind it are the end of the file it replaced.
  const older = JSON.stringify({ ...LIVE_STORE, extra: 'x'.repeat(400) })
  const newer = liveJson()
  const torn = newer + older.slice(newer.length)
  assert.ok(torn.length > newer.length, 'the fixture really does carry a stale tail')

  inTempDir({ [STORE]: torn }, (dir) => {
    const path = join(dir, STORE)
    const { out, errors } = runMigration(path)

    assert.equal(out.salvagedFrom, 'torn-bytes')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), LIVE_STORE)
    assert.ok(errors[0].includes('stale trailing bytes discarded'), 'and it says what it threw away')
  })
})

test('an UNRECOVERABLE store falls back to the pristine backup and runs the chain over it', () => {
  // Truncated part-way through a value: no lossless repair exists, so the torn bytes give nothing.
  // The `.vN.backup.json` copy this module wrote at some past schema upgrade is complete, though —
  // older than the user's latest settings, but a whole store, which is the bar.
  const truncated = '{"schemaVersion":11,"alerts":[{"id":"charm-break","na'
  const preFramework = JSON.stringify({ byCharacter: { 'primitive_freeport': { inventory: {}, completedQuests: [] } } })

  inTempDir({ [STORE]: truncated }, (dir) => {
    const path = join(dir, STORE)
    writeFileSync(backupPathFor(path, 1), preFramework, 'utf8')
    const { out } = runMigration(path)

    assert.equal(out.salvagedFrom, 'backup')
    assert.equal(out.from, 1, 'a v1 backup enters the chain at 1…')
    assert.equal(out.to, CURRENT_SCHEMA_VERSION, '…and is migrated all the way forward')
    const restored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    assert.equal(restored.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.ok(Object.keys(restored.byCharacter as object).includes('primitive_freeport'))
  })
})

test('the newest backup wins when several are on disk', () => {
  inTempDir({ [STORE]: '{"alerts":[' }, (dir) => {
    const path = join(dir, STORE)
    writeFileSync(backupPathFor(path, 1), JSON.stringify({ byCharacter: {}, marker: 'old' }), 'utf8')
    writeFileSync(backupPathFor(path, 4), JSON.stringify({ byCharacter: {}, marker: 'newer', schemaVersion: 4 }), 'utf8')
    const { out } = runMigration(path)

    assert.equal(out.salvagedFrom, 'backup')
    assert.equal(out.from, 4)
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).marker, 'newer')
  })
})

test('the salvage line names the backup by version, not by path', () => {
  inTempDir({ [STORE]: '{"alerts":[' }, (dir) => {
    const path = join(dir, STORE)
    writeFileSync(backupPathFor(path, 4), JSON.stringify({ byCharacter: {}, schemaVersion: 4 }), 'utf8')
    const { errors } = runMigration(path)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('out of the v4 backup'))
    assert.equal(errors[0].includes(backupPathFor(path, 4)), false, 'no second path to swallow the line')
  })
})

// ---------------------------------------------------------------------- the refusals
//
// Each of these is a case where SOMETHING could have been handed back and deliberately is not.

test('a TRUNCATED store is never half-restored — defaults, exactly as before', () => {
  // The tempting repair is to close the open brackets and keep the keys that made it in. That is
  // the one thing this module may not do: the user would come up with an arbitrary prefix of their
  // settings and no way to know which half is missing.
  const truncated = '{"schemaVersion":11,"byCharacter":{},"alerts":[{"id":"charm-break","name":"Charm'
  inTempDir({ [STORE]: truncated }, (dir) => {
    const path = join(dir, STORE)
    const { out, errors } = runMigration(path)

    assert.equal(out.salvagedFrom, undefined)
    assert.equal(out.quarantinedPath, quarantinePathFor(path))
    assert.equal(out.fileMissing, true, 'the app starts from defaults')
    assert.equal(existsSync(path), false, 'and nothing partial was written back')
    assert.equal(readFileSync(quarantinePathFor(path), 'utf8'), truncated, 'the evidence is kept')
    assert.equal(errors.length, 1)
    assert.ok(errors[0].startsWith('store schema: the store file is not valid JSON, starting from defaults - '))
  })
})

test('a recovered object that is not this app’s store is refused', () => {
  // The salvage only runs on bytes that failed to parse, so the object it recovers has to be
  // identified before it is adopted — otherwise any JSON that happened to be sitting at that path
  // would become the settings file.
  for (const alien of ['{"hello":"world"}', '{}', '{"nested":{"alerts":[]}}']) {
    inTempDir({ [STORE]: `${alien}${NUL.repeat(8)}` }, (dir) => {
      const path = join(dir, STORE)
      const { out } = runMigration(path)
      assert.equal(out.salvagedFrom, undefined, `refused: ${alien}`)
      assert.equal(out.fileMissing, true)
    })
  }
})

test('a recovered store whose version is not a whole number is refused', () => {
  const bad = `{"byCharacter":{},"schemaVersion":"eleven"}${NUL}`
  inTempDir({ [STORE]: bad }, (dir) => {
    const { out } = runMigration(join(dir, STORE))
    assert.equal(out.salvagedFrom, undefined)
  })
})

test('a backup that is itself junk is skipped rather than adopted', () => {
  inTempDir({ [STORE]: '{"alerts":[' }, (dir) => {
    const path = join(dir, STORE)
    writeFileSync(backupPathFor(path, 3), 'not json at all', 'utf8')
    const { out } = runMigration(path)
    assert.equal(out.salvagedFrom, undefined)
    assert.equal(out.fileMissing, true)
  })
})

// ------------------------------------------------------------------------ atomicity

test('every write this module makes is atomic: no scratch file is ever left behind', () => {
  // `writeFileDurable` (telemetry/durableWrite.ts, JOS-265) writes `<path>.tmp`, fsyncs it and
  // renames. The rename is what makes the store file go from complete-old to complete-new with no
  // observable state in between; the absence of the temp afterwards is what proves the path taken.
  const preFramework = JSON.stringify({ byCharacter: {}, alerts: [] })
  inTempDir({ [STORE]: preFramework }, (dir) => {
    const path = join(dir, STORE)
    const { out } = runMigration(path)
    assert.equal(out.wrote, true, 'a v1 store really was migrated and written')

    const left = readdirSync(dir).sort()
    assert.deepEqual(left, [STORE, `${STORE.replace(/\.json$/, '')}.v1.backup.json`].sort())
    assert.equal(left.some((f) => f.endsWith('.tmp')), false, 'no scratch file survives')
    assert.equal(readFileSync(backupPathFor(path, 1), 'utf8'), preFramework, 'and the backup is still byte-exact')
  })
})

test('THE SOURCE PIN: nothing in storeMigrations.ts writes the store with a bare writeFileSync', () => {
  // The behavioural tests above cannot tell an atomic write from a lucky one — the failure they
  // guard against is a process being killed, which no test may arrange. This is the assertion that
  // actually holds the line, and it is the one to update if a new writer is ever added here.
  const src = readFileSync(new URL('../src/main/storeFile.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("import { writeFileDurable } from './telemetry/durableWrite'"))
  assert.equal(/\bwriteFileSync\s*\(/.test(src), false, 'every write goes through writeFileDurable')
})

// ----------------------------------------------------------------------- idempotence

test('the launch AFTER a salvage is an ordinary launch', () => {
  inTempDir({ [STORE]: `${liveJson()}${NUL.repeat(64)}` }, (dir) => {
    const path = join(dir, STORE)
    assert.equal(runMigration(path).out.salvagedFrom, 'torn-bytes')

    const second = runMigration(path)
    assert.equal(second.out.salvagedFrom, undefined, 'nothing to salvage: the file parses now')
    assert.equal(second.out.quarantinedPath, undefined)
    assert.equal(second.out.status, 'up-to-date')
    assert.equal(second.errors.length, 0, 'and it says nothing at all')
  })
})
