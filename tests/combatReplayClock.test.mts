/**
 * ============================================================================
 * combatReplayClock.test.mts — A REPLAY IS NOT A MOMENT IN TIME (JOS-208 phase 4).
 * ============================================================================
 *
 * THE DEFECT, measured rather than imagined. `CombatEngine.snapshot(now)` evaluates deferred
 * encounter closure and sweeps uncorroborated charm binds, both against `now` — which for the
 * running app is the WALL CLOCK. The historical replay yields to the event loop every slice
 * (`replaySlicer.ts`), and the renderer polls `combat:snapshot` throughout hydration, so a poll
 * landing between two slices reached an engine whose open fight was hours or weeks behind the wall
 * clock and finalized it. The rest of that fight's lines then opened a NEW encounter.
 *
 * On the owner-scale log every fight is behind the wall clock, so the only thing standing between a
 * user and a sawn-in-half fight was whether a poll happened to land mid-fight. MEASURED, in the e2e
 * restart-compare under full-suite load the day the engine joined the container:
 * `e2e-combat.log`'s 53,577-damage fight came back as 43,504 + 10,073, and the in-app shadow
 * verifier called it a divergence. It is PRE-EXISTING — every launch folded the whole log in one
 * pass, so nothing could ever compare two folds and notice — and the checkpoint is what made it
 * visible, because a restored launch folds the same bytes in two passes.
 *
 * WHAT THIS PINS is the PROPERTY, in both directions, so a fix that simply switched the sweep off
 * would fail as loudly as the defect did:
 *
 *   1. polling `snapshot(wall clock)` at every single event of a real replay changes NOTHING about
 *      what the fold produces;
 *   2. …and once `setLive()` has been called, the very same call DOES finalize the open fight —
 *      which is the behaviour the live meter is built on and must keep.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CombatEngine } from '../src/main/combat/engine'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName } from '../src/main/log/rulesets'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'e2e-combat.log')

/** A wall clock far past every fixture's last line — what a real launch's `Date.now()` is. */
const WALL_CLOCK = Date.UTC(2027, 0, 1)

/** Fold the whole fixture, optionally taking a wall-clock snapshot after EVERY event. */
function fold(pollEveryEvent: boolean): CombatEngine {
  installCharacterName('Primitive')
  const engine = new CombatEngine()
  engine.reset()
  engine.setPlayerName('Primitive')
  let seq = 0
  for (const raw of readFileSync(FIXTURE, 'utf8').split('\n')) {
    const ev = parseEvent(raw.endsWith('\r') ? raw.slice(0, -1) : raw, seq++)
    if (!ev) continue
    engine.ingestEvent(ev, false)
    // The renderer's poll, at its most adversarial: every line rather than every slice.
    if (pollEveryEvent) engine.snapshot(WALL_CLOCK)
  }
  return engine
}

/** The fight list as a reader would compare it: id, kind and damage per segment. */
function segments(engine: CombatEngine): string[] {
  engine.setLive()
  return engine.snapshot(WALL_CLOCK).segments.map((s) => `${s.id}:${s.kind}:${String(s.total)}`)
}

test('a snapshot taken mid-replay cannot close a fight the log has not ended', () => {
  const quiet = segments(fold(false))
  const polled = segments(fold(true))
  assert.deepStrictEqual(
    polled,
    quiet,
    'a renderer poll during hydration changed the fold — the wall clock split a fight'
  )
  // …and the fixture really does leave a fight open at EOF, or the assertion above is vacuous:
  // a fold whose last fight had already closed on log time could not be sawn in half by anything.
  assert.ok(quiet.length >= 3, `the fixture must produce a real fight list, got ${quiet.join(', ')}`)
})

/**
 * Fold until a fight is OPEN and stop there — mid-file, which is the only place this fixture has
 * one. Its last line is trailing chatter well past the final kill, so the fold ends with `current`
 * already closed on LOG time; asserting the live sweep at EOF would be asserting nothing.
 */
function foldUntilOpenFight(): CombatEngine {
  installCharacterName('Primitive')
  const engine = new CombatEngine()
  engine.reset()
  engine.setPlayerName('Primitive')
  let seq = 0
  for (const raw of readFileSync(FIXTURE, 'utf8').split('\n')) {
    const ev = parseEvent(raw.endsWith('\r') ? raw.slice(0, -1) : raw, seq++)
    if (!ev) continue
    engine.ingestEvent(ev, false)
    if (engine.snapshot(WALL_CLOCK).segments[0]?.kind === 'current') return engine
  }
  throw new Error('the fixture never opened a fight — this test is measuring nothing')
}

test('…and once the app is LIVE, the same wall clock does finalize the open fight', () => {
  const engine = foldUntilOpenFight()
  // BEFORE `setLive()`: the fold is still hydrating, so the open fight is the head row and is
  // reported as the CURRENT one however far past it the wall clock has moved.
  const hydrating = engine.snapshot(WALL_CLOCK)
  assert.equal(hydrating.hydrating, true)
  assert.equal(hydrating.segments[0]?.kind, 'current', 'the open fight must still be open mid-fold')

  // AFTER: the deferred closure runs, exactly as the live meter needs it to — this is the half
  // that stops the fix from being "the sweep was switched off".
  engine.setLive()
  const live = engine.snapshot(WALL_CLOCK)
  assert.equal(live.hydrating, false)
  assert.equal(live.inCombat, false)
  assert.equal(live.segments[0]?.kind, 'fight', 'going live must finalize a fight the clock has left behind')
  assert.equal(live.currentTarget, undefined, 'a fight that just closed on elapsed time names no target')
  // The DAMAGE is untouched by either path — world-model law 8's tripwire, applied to the fix.
  assert.equal(live.segments[0]?.total, hydrating.segments[0]?.total)
})
