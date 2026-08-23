// GOLDEN WINDOWS — THE UNBOUND PET, AND THE ONE THING THAT BINDS IT.
//
// Two real spans from the owner's own log, extracted verbatim through the shared scrub by
// tests/extract-pet-claim-fixtures.mjs:
//
//   p1-unbound-pet.log  Thu Jul 30 16:10–16:30, Solusek's Eye. Twenty minutes with an ENCHANTER
//                       animation pet called Kober. The owner never ORDERS it, so it never sends
//                       the private `… Master.'` tell; it is not charmed, so there is no
//                       broadcast either. It lands 105 hits for 1,966 points across four mobs —
//                       three of them mobs the owner is hitting too — and the app cannot see one
//                       of them. This is the reporter's bug (feedback 01KZBV8WFC8PD7DNASTJ5S5CWZ,
//                       "Dps overlay meter is not showing my pet dps") in the OWNER's own log.
//   p2-pet-arc-bound.log Thu Aug 06 12:34–12:46, a Nagafen's Lair instance. The other half of the
//                       story in one span: an animation summoned and unbound, the tell that ends
//                       that at 12:43:12, a second animation at 12:44:45, and its own tell six
//                       seconds later.
//
// WHAT THE APP DOES ABOUT IT, and the history that matters for reading these tests. JOS-47 shipped
// a QUESTION — the meter offered "<Name> — your pet?" above the rows, with Yes/No, backed by a
// candidate detector and a per-character claim store. JOS-49 DELETED all of it, by owner ruling:
//
//     "just cut out the 'is this my pet question' - if you just have to pet attack once,
//      this is a lot of work we can get wrong."
//
// So the blind spot is now an ACCEPTED, documented non-distinguishable (AGENTS.md world-model law
// 6): a pet that is never ordered is a pet the log does not name as yours, and the app says
// nothing rather than guessing or asking. Order it once — any `/pet` command — and the tell binds
// it retroactively for the whole session. These windows pin exactly that: the damage stays
// unattributed while nothing has bound it, NO question is asked anywhere, and a real tell
// recovers every point.
//
// Fixture-guarded: `readFixture` returns [] when the file is absent, and every test skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName } from '../src/main/log/rulesets'
import { CombatEngine } from '../src/main/combat/engine'
import { scopeSources } from '../src/renderer/src/features/combat/meterScope'
import type { MeterScope } from '../src/shared/roster'
import type { CombatSnapshot, SegmentView } from '../src/shared/combat'

// THE TAILED CHARACTER, injected the way session.ts injects it before a replay. Only ONE rule in
// the parser reads it — the `/pet who leader` answer (JOS-52), whose whole guard is "the leader
// it names is you"; the self-`/who` rule reads it too but neither fixture contains a `/who` row
// (measured: zero `ZONE: ` lines in either), so every assertion in sections 1–4 below is
// unaffected by this line and stayed byte-identical when it was added.
installCharacterName('Primitive')

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const read = (name: string): string[] => {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}
const P1 = read('p1-unbound-pet.log')
const P2 = read('p2-pet-arc-bound.log')
const skip = P1.length === 0 ? 'fixture not present' : false
const skipArc = P2.length === 0 ? 'fixture not present' : false

/** Replay spans through the real parser + engine, as the app does at launch. `pre` lines are
 *  folded first, which is how a test injects a line the window itself does not contain. */
function replay(spans: string[][], pre: string[] = []): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of pre) {
    const ev = parseEvent(raw, seq++)
    assert.ok(ev, `the injected line must parse: ${raw}`)
    eng.ingestEvent(ev, false)
  }
  let lastTs = 0
  for (const span of spans) {
    for (const raw of span) {
      const ev = parseEvent(raw, seq++)
      if (!ev) continue
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  return { eng, lastTs }
}

/** Every zone session's outgoing rows — a summoned pet follows you through a zone line, and P1
 *  crosses five of them, so "what did the pet do" is only answerable across all of them. */
function allSessions(eng: CombatEngine, lastTs: number): SegmentView[] {
  const now = lastTs + 120_000
  const out: SegmentView[] = []
  for (const zs of eng.snapshot(now, {}).zoneSessions) {
    const s = eng.snapshot(now, { selectedId: zs.id }).selected
    if (s) out.push(s)
  }
  return out
}

function petTotals(views: SegmentView[]): { total: number; hits: number; names: Set<string> } {
  let total = 0
  let hits = 0
  const names = new Set<string>()
  for (const v of views)
    for (const e of v.entities)
      if (e.kind === 'pet') {
        total += e.total
        hits += e.hits
        names.add(e.name)
      }
  return { total, hits, names }
}

// ── 1. THE BLIND SPOT, EXACTLY — AND IT IS SILENT ──────────────────────────────────────────

test('P1: 105 pet hits parse perfectly and NOTHING binds them', { skip }, () => {
  // Every one of the pet's lines parses — this was never a parse failure.
  const raw = P1.filter((l) => /\] Kober [a-z]+ .* for \d+ points? of damage\.$/.test(l))
  assert.equal(raw.length, 105)
  // …and none of it is attributed to anybody.
  const { eng, lastTs } = replay([P1])
  assert.deepEqual(eng.petDisplayNames(), [])
  assert.equal(petTotals(allSessions(eng, lastTs)).total, 0)
})

test('P1: the missing damage is invisible at EVERY scope, not hidden by one', { skip }, () => {
  // The scope chip is a view filter over rows the engine RECORDED. This damage was dropped at
  // admission, so no row was ever created and there is no scope the user could switch to. The
  // original triage brief assumed Everyone covered discovery; the replay says it cannot.
  const { eng, lastTs } = replay([P1])
  const snap = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' })
  const rows = snap.selected?.entities ?? []
  for (const scope of ['you', 'group', 'everyone'] as MeterScope[]) {
    const kept = scopeSources(rows, scope, snap.roster)
    assert.equal(kept.some((r) => r.kind === 'pet'), false, `${scope} must show no pet row`)
  }
})

test('P1: and the app ASKS NOTHING about it — the question is gone (JOS-49)', { skip }, () => {
  // The owner's ruling, as a property of the snapshot rather than of a rendered surface: there is
  // no channel for a question to arrive on. `petClaims` used to ride here beside `roster`,
  // carrying candidates for the meter to ask about and the names already claimed.
  const { eng, lastTs } = replay([P1])
  const snap: CombatSnapshot = eng.snapshot(lastTs + 120_000, {})
  assert.equal('petClaims' in snap, false, 'the snapshot carries no question')
  assert.equal('roster' in snap, true, '…while the roster it used to sit beside is untouched')
  // Nor is there any way to install one: the engine's claim seam is gone with it.
  assert.equal('setPetClaims' in eng, false)
  assert.equal(typeof (eng as unknown as Record<string, unknown>).setPetClaims, 'undefined')
})

test('P1: the four pet-voiced SAYS still parse, and still bind nothing', { skip }, () => {
  // The scrub carve-out stays (fixtures are cut through it and re-cutting is not in scope), and
  // the parser still emits `petSay` — shared/logEventKinds.ts lists it in the alert vocabulary.
  // What is gone is the inference: `says` is BROADCAST, so it proves the speaker is somebody's
  // pet and nothing whatever about whose. It used to nominate; now it is inert in the engine.
  const says = P1.filter((l) => /\] Kober says, '/.test(l))
  assert.equal(says.length, 4)
  for (const line of says) assert.equal(parseEvent(line, 0)?.kind, 'petSay')
  const { eng, lastTs } = replay([P1])
  assert.deepEqual(eng.petDisplayNames(), [], 'four pet-voiced sentences, zero pets')
  assert.equal(petTotals(allSessions(eng, lastTs)).total, 0)
})

// ── 2. THE NEGATIVE CONTROL ────────────────────────────────────────────────────────────────

test('P1: a proper-named HOSTILE fighting the same mobs is never a pet', { skip }, () => {
  // `Guard Effel` is proper-named, is not a mob-shaped article name, and trades blows with the
  // same entities. It is also swinging at the owner, which is the whole difference — and with
  // the question deleted there is not even a surface on which it could be mistaken for one.
  assert.ok(P1.some((l) => /\] Guard Effel .*YOU/.test(l)), 'the control must actually hit you')
  const { eng } = replay([P1])
  assert.equal(eng.petDisplayNames().some((n) => n.toLowerCase().includes('effel')), false)
})

// ── 3. THE ANSWER: ORDER IT ONCE ───────────────────────────────────────────────────────────

const KOBER_TELL = `[Thu Jul 30 16:10:11 2026] Kober told you, 'Attacking a sonic bat Master.'`

test('P1: one pet command at the start recovers every point — 1,966 over 105 hits', { skip }, () => {
  // THE WHOLE FEATURE, in one line of log. `/pet attack` makes the pet answer you privately, and
  // that tell is the only thing in this log that says a summoned pet is yours. Ordered here at
  // 16:10:11, one second before the window's first pet swing — see the P2 test below for what
  // ordering it LATE costs, which is the honest limit of "just order it once".
  assert.equal(parseEvent(KOBER_TELL, 0)?.kind, 'petClaim')
  const { eng, lastTs } = replay([P1], [KOBER_TELL])
  const totals = petTotals(allSessions(eng, lastTs))
  assert.deepEqual([...totals.names], ['Kober'])
  assert.equal(totals.hits, 105)
  assert.equal(totals.total, 1966)
  assert.deepEqual(eng.petDisplayNames(), ['Kober'])
})

test('P1: a bound pet is SUMMONED, so it walks through the five zone lines with you', { skip }, () => {
  assert.equal(P1.filter((l) => /\] You have entered /.test(l)).length, 5)
  const { eng, lastTs } = replay([P1], [KOBER_TELL])
  // Still bound at the end, and its damage lands in more than one zone session — which is
  // exactly what would NOT happen if the tell bound it as a charmed pet (charm cannot zone).
  assert.deepEqual(eng.petDisplayNames(), ['Kober'])
  const withPet = allSessions(eng, lastTs).filter((v) => v.entities.some((e) => e.kind === 'pet'))
  assert.ok(withPet.length >= 2, 'the pet followed you')
})

test('P1: binding it adds a pet row and moves NO other number', { skip }, () => {
  // The design's central promise, stated as arithmetic: the user's own damage is byte-identical
  // either way, and the segment total grows by exactly the pet's own contribution.
  const before = replay([P1])
  const after = replay([P1], [KOBER_TELL])
  const you = (views: SegmentView[]): number =>
    views.reduce((n, v) => n + v.entities.filter((e) => e.kind === 'you').reduce((m, e) => m + e.total, 0), 0)
  const out = (views: SegmentView[]): number => views.reduce((n, v) => n + v.outTotal, 0)
  const b = allSessions(before.eng, before.lastTs)
  const a = allSessions(after.eng, after.lastTs)
  assert.equal(you(a), you(b))
  assert.equal(out(a) - out(b), 1966)
})

// ── 4. THE WHOLE ARC OF A PET, IN ELEVEN MINUTES (P2) ──────────────────────────────────────
//
// The owner's own last two pets, located after he watched JOS-47's question get the CURRENT one
// wrong. Timeline, in the log's own stamps:
//
//   12:35:28  you zone into your own instance
//   12:35:43  `You begin casting Kintaz's Animation.` → Jaber
//   12:35:47→ Jaber fights the greater kobolds you are fighting, UNBOUND, for seven and a half
//             minutes. Every point of it is dropped, and nothing is asked.
//   12:43:12  `Jaber told you, 'Attacking a greater kobold Master.'` — the tell BINDS.
//   12:44:45  a second Kintaz cast → Gonekn
//   12:44:51  Gonekn's own tell binds it, three seconds after its first swing.
//
// AND THE ANIMATION CASTS SPELLS — Wrath, Stun, Daring, Symbol of Ryltan — and HEALS ITSELF. That
// is here because it is the shape most likely to be mis-inferred: a self-heal is NOT player
// evidence in this log (routing.ts noteHealEvidence takes a healer only when the heal lands on
// YOU or on an already-known player), and if it were, the app would file the owner's own pet as
// a person and delete its damage.

/**
 * The pet rows of every zone session, keyed by name.
 *
 * The spawn-generation suffix comes OFF (world-model law 2: `WorldModel.label()` appends a
 * ` (N)` that appears in no log line and is display flavor, never identity — `mobKey` strips it
 * the same way). Jaber's row really does render as `Jaber (2)` in this window, because the mobs
 * swinging at it resolved an instance of the name before the tell minted its pet one.
 */
function petRowsByName(eng: CombatEngine, lastTs: number): Map<string, { hits: number; total: number }> {
  const out = new Map<string, { hits: number; total: number }>()
  for (const v of allSessions(eng, lastTs)) {
    for (const e of v.entities) {
      if (e.kind !== 'pet') continue
      const name = e.name.replace(/\s+\(\d+\)$/, '')
      const row = out.get(name) ?? { hits: 0, total: 0 }
      row.hits += e.hits
      row.total += e.total
      out.set(name, row)
    }
  }
  return out
}

test('P2: the fixture carries the arc it says it does', { skip: skipArc }, () => {
  assert.equal(P2.filter((l) => /\] You begin casting Kintaz's Animation\.$/.test(l)).length, 2)
  assert.equal(P2.filter((l) => /told you, 'Attacking a greater kobold Master\.'$/.test(l)).length, 2)
  assert.ok(P2.some((l) => /\] Jaber begins casting Wrath\.$/.test(l)), 'the animation casts')
  assert.ok(P2.some((l) => /\] Jaber hit .* points of magic damage by Wrath\.$/.test(l)), 'its spell lands')
  assert.ok(P2.some((l) => /\] Jaber healed himself for \d+ hit points by Daring\.$/.test(l)), 'it self-heals')
  // ONE LINE WAS DELIBERATELY ABSENT UNTIL JOS-52: `Jaber says, 'My leader is Primitive.'`
  // (12:44:20), the /pet who leader answer. It is quoted speech outside the six pet-voiced
  // sentences, so the shared scrub dropped it and this assertion pinned the absence so the
  // golden could not start depending on it before the carve-out existed. It exists now (gated on
  // selfName — this is the one pet-voiced line that names a PLAYER), the fixture was re-cut, and
  // the assertion is a positive one. Section 5 below is what it earns.
  assert.equal(P2.filter((l) => /\] Jaber says, 'My leader is Primitive\.'$/.test(l)).length, 1)
})

test('P2: an animation that casts and self-heals is still nobody, until it is ordered', { skip: skipArc }, () => {
  // Replay only up to the moment before the tell. Nothing is bound, nothing is asked, and the
  // spellcasting has not made the app mistake the pet for a player.
  const beforeTell = P2.filter((l) => l < '[Thu Aug 06 12:43:12')
  assert.ok(beforeTell.length > 200, `${beforeTell.length} lines of unbound pet`)
  const { eng, lastTs } = replay([beforeTell])
  assert.deepEqual(eng.petDisplayNames(), [], 'seven and a half minutes, no pet')
  assert.equal(petRowsByName(eng, lastTs).size, 0, 'and no pet row anywhere')
  assert.equal('petClaims' in eng.snapshot(lastTs + 60_000, {}), false, 'and no question')
})

test('P2: each tell binds its own pet, and the arc is two rows not one', { skip: skipArc }, () => {
  const { eng, lastTs } = replay([P2])
  const rows = petRowsByName(eng, lastTs)
  assert.deepEqual([...rows.keys()].sort(), ['Gonekn', 'Jaber'])
  assert.ok(eng.petDisplayNames().includes('Gonekn'), 'the replacement is bound, by its own tell')
  // Gonekn's tell arrives at 12:44:51, THREE SECONDS after its first swing, so its row is
  // essentially its whole life: 41 landed hits for 1,700 points, out of 41 damage lines.
  assert.deepEqual(rows.get('Gonekn'), { hits: 41, total: 1700 })
})

test('P2: the second summons RETIRES the first — one pet at a time (JOS-54)', { skip: skipArc }, () => {
  // FROZEN HERE, having been observed-and-not-frozen when JOS-49 measured this window. The
  // single-pet invariant (AGENTS.md world-model law 4) did not exist anywhere in the combat
  // world model: `world.claim()` retired nothing, and `world.charm()` — which the brief assumed
  // did — does not either (charm succession lives in modules/buffs.ts, at the buff-entity
  // level). So both animations stood as live pets after 12:44:51, and on the owner's whole log
  // that compounded to TWENTY-THREE simultaneously live summoned pets by the last line.
  //
  // The game gives you one class pet and the recast despawns the old one, printing NOTHING when
  // it does. So the successor's own tell is the only evidence that ever arrives, and it is what
  // retires the predecessor now.
  const { eng, lastTs } = replay([P2])
  assert.deepEqual(eng.petDisplayNames(), ['Gonekn'], 'Gonekn is the pet; Jaber is retired')

  // RETIREMENT, NOT DELETION — and this is the arithmetic of it. Jaber's row is byte-for-byte
  // what it was before the invariant existed (see the tell-binds-forward test below for where
  // those numbers come from): everything booked to it while it was yours stays booked to it.
  const rows = petRowsByName(eng, lastTs)
  assert.deepEqual(rows.get('Jaber'), { hits: 8, total: 599 })
  assert.deepEqual(rows.get('Gonekn'), { hits: 41, total: 1700 })

  // …and the retirement costs this window nothing, because the game had already taken the pet
  // away: the second `Kintaz's Animation` cast lands at 12:44:45 and Jaber never swings again.
  // That is the general case, not a lucky span — measured over the whole log (JOS-54), the
  // invariant fires 23 times and the pet it retires lands ZERO further damage lines, ever.
  const jaberAfter = P2.filter(
    (l) => /\] Jaber .* for \d+ points? of (magic )?damage/.test(l) && l >= '[Thu Aug 06 12:44:45'
  )
  assert.equal(jaberAfter.length, 0, 'no post-recast Jaber swing exists to lose')
})

test('P2: A TELL BINDS FORWARD, NOT BACKWARD — ordering late costs you the rest', { skip: skipArc }, () => {
  // THE HONEST LIMIT OF "just order it once" (JOS-49), measured rather than assumed. A tell is an
  // event at a timestamp: `ingestPetClaim` binds the name from that line onward, and the engine
  // has no path that reaches back over damage it already filed as nobody's. The deleted user
  // CLAIM did have one — it was known BEFORE the replay started, so `route()` could apply it to
  // the pet's very first line — and losing that is the real cost of cutting the question.
  //
  // Jaber lands 51 hits for 2,615 points in this window. Its tell arrives at 12:43:12, after 43
  // of them. So the meter shows 8 hits for 599 points, and 2,016 points of the owner's own pet's
  // work stay invisible — in the span he went looking at precisely because of that.
  const { eng, lastTs } = replay([P2])
  assert.deepEqual(petRowsByName(eng, lastTs).get('Jaber'), { hits: 8, total: 599 })
  const raw = P2.filter((l) => /\] Jaber .* for \d+ points? of (magic )?damage/.test(l))
  assert.equal(raw.length, 51, 'it really did land 51')
  assert.equal(raw.filter((l) => l < '[Thu Aug 06 12:43:12').length, 43, 'and 43 of them before the tell')

  // …and the same window with the pet ordered at the moment it was SUMMONED loses nothing. This
  // is the whole user-facing instruction, as arithmetic: order it when you cast it.
  const early = replay([P2], [`[Thu Aug 06 12:35:45 2026] Jaber told you, 'Attacking a greater kobold Master.'`])
  assert.deepEqual(petRowsByName(early.eng, early.lastTs).get('Jaber'), { hits: 51, total: 2615 })
})

// ── 5. THE OTHER WAY IN: `/pet who leader` (JOS-52) ────────────────────────────────────────
//
// The tell only fires when the pet is ORDERED, and section 3 is the honest cost of that: order
// it late and the meter keeps only what came after. `/pet who leader` is the answer for a player
// who would rather ASK than order — the pet says whose it is out loud, and that line is the only
// one in this log in which a pet names its owner.
//
// MEASURED before any of it was written (whole-log sweep, 1,404,458 lines, 2026-08-06): the
// family has exactly ONE member and exactly ONE occurrence — `Jaber says, 'My leader is
// Primitive.'`, Thu Aug 06 12:44:20, now carried verbatim in P2. There is no follower variant, no
// no-leader variant and no charmed variant, and none ships until a real line prints one
// (AGENTS.md's awaiting-sample law).
//
// The one occurrence is on a pet ALREADY bound by its own tell 68 seconds earlier, so the real
// bytes can prove the line is inert-when-redundant but cannot show it BINDING. For that, the line
// is INJECTED into P1 — the fixture whose whole subject is a pet nothing ever binds — quoted
// verbatim from the owner's log with the pet's name swapped, which is the petClaimWindows /
// mobLifetapPlayer precedent for a shape the owner's log has printed in the wrong place.

/** The Aug 06 line, verbatim, with Jaber's name swapped for P1's never-ordered Kober. */
const KOBER_LEADER = `[Thu Jul 30 16:10:11 2026] Kober says, 'My leader is Primitive.'`

test('P1: `/pet who leader` binds the never-ordered pet — the same 1,966 the tell recovers', { skip }, () => {
  // THE TICKET, in one line of log. The say parses to the SAME canonical event the private tell
  // does (`petClaim`), tagged with which line said so, so everything downstream — attribution,
  // succession, the zone walk — is shared code rather than a second implementation.
  const ev = parseEvent(KOBER_LEADER, 0)
  assert.equal(ev?.kind, 'petClaim')
  assert.equal(ev?.kind === 'petClaim' ? ev.via : undefined, 'leader')

  const asked = replay([P1], [KOBER_LEADER])
  const totals = petTotals(allSessions(asked.eng, asked.lastTs))
  assert.deepEqual([...totals.names], ['Kober'])
  assert.equal(totals.hits, 105)
  assert.equal(totals.total, 1966)
  assert.deepEqual(asked.eng.petDisplayNames(), ['Kober'])

  // …and it is the same bind, not a similar one: asking and ordering produce identical meters.
  const ordered = replay([P1], [KOBER_TELL])
  const o = petTotals(allSessions(ordered.eng, ordered.lastTs))
  assert.deepEqual({ ...totals, names: [...totals.names] }, { ...o, names: [...o.names] })
})

test('P1: a leader say binds SUMMONED, so it walks the five zone lines like the tell', { skip }, () => {
  // The pet the /pet who leader answer names is a class pet, and class pets follow you. If the
  // say had bound as CHARMED it would be left behind at the first zone line and the later
  // sessions would hold no pet row at all.
  const { eng, lastTs } = replay([P1], [KOBER_LEADER])
  assert.deepEqual(eng.petDisplayNames(), ['Kober'])
  assert.deepEqual(eng.charmedPetNames(), [], 'a summoned bind, not a charm one')
  const withPet = allSessions(eng, lastTs).filter((v) => v.entities.some((e) => e.kind === 'pet'))
  assert.ok(withPet.length >= 2, 'the pet followed you')
})

test("P1: a STRANGER's pet naming ITS OWN owner is never YOURS", { skip }, () => {
  // `says` is BROADCAST — every pet in earshot prints this exact shape naming its own owner, and
  // the log's one real occurrence would look identical coming from the player beside you. The
  // leader's name is the entire guard, and this assertion is what pins which side of it a line
  // lands on.
  //
  // THIS TEST USED TO ASSERT `unknown`, AND JOS-250 SUPERSEDED THAT HALF OF IT. The claim that
  // mattered was never "the parser emits nothing" — it was "a stranger's pet is nobody of OURS",
  // which is what the two assertions below say and what they said before. What changed is that
  // the line now has a reader: it parses to `allyPetLeader`, a kind NOTHING that binds your pets
  // consumes (the combat world model's `claim()`, the JOS-54 succession, modules/buffs.ts's
  // buff-entity succession, the progression pet ledger and the roster all switch on `petClaim`
  // and are untouched), and the one model that does read it credits that pet to GONEKN.
  //
  // The distinction the original comment drew — an event consumers must remember to ignore is
  // worse than no event — is answered by the separate KIND rather than by silence: there is no
  // field for anyone to forget to check, because the kind they match on never arrives.
  const strangers = `[Thu Jul 30 16:10:11 2026] Kober says, 'My leader is Gonekn.'`
  const ev = parseEvent(strangers, 0)
  assert.equal(ev?.kind, 'allyPetLeader')
  assert.deepEqual(
    ev?.kind === 'allyPetLeader' ? { pet: ev.pet, owner: ev.owner } : null,
    { pet: 'Kober', owner: 'Gonekn' },
    'both ends named, and neither of them is you'
  )
  const { eng, lastTs } = replay([P1], [strangers])
  assert.deepEqual(eng.petDisplayNames(), [], "somebody else's pet is still nobody of ours")
  assert.equal(petTotals(allSessions(eng, lastTs)).total, 0)
})

test("P1: a MOB-shaped leader is refused — a growl cannot mint a charmer", { skip }, () => {
  // The other half of the guard (JOS-250). `says` carries the whole log's mob speech, so a leader
  // capture that admitted an article-named subject would invent an owner out of flavour text.
  for (const owner of ['a fire giant warrior', 'A fire giant warrior', 'The Hand of Veeshan']) {
    const line = `[Thu Jul 30 16:10:11 2026] Kober says, 'My leader is ${owner}.'`
    assert.equal(parseEvent(line, 0)?.kind, 'unknown', `${owner} is not a person`)
  }
})

test("P1: with no character installed the rule declines the OWNER's own line", { skip }, () => {
  // The name comes from the session (rulesets.ts installCharacterName), never from a constant —
  // the self-`/who` rule's precedent, and the same safe default: with nothing installed we cannot
  // know whose pet a broadcast names, so we decline rather than guess.
  installCharacterName(undefined)
  try {
    assert.equal(parseEvent(KOBER_LEADER, 0)?.kind, 'unknown')
    const { eng } = replay([P1], [KOBER_LEADER])
    assert.deepEqual(eng.petDisplayNames(), [])
  } finally {
    installCharacterName('Primitive')
  }
})

test('P2: the real line is carried verbatim, and it moves NOT ONE NUMBER', { skip: skipArc }, () => {
  // WHY RE-CUTTING P2 WAS SAFE, as arithmetic rather than as a claim. The owner's one real leader
  // say lands at 12:44:20, 68 seconds after Jaber's own tell has already bound it. `world.claim()`
  // is idempotent (petSuccession.test.mts pins that directly), so the second claim is a refresh of
  // the same instance: no succession fires, no row moves, nothing retires. These are the exact
  // figures the tests above assert on the pre-JOS-52 cut of this fixture.
  assert.equal(P2.filter((l) => /\] Jaber says, 'My leader is Primitive\.'$/.test(l)).length, 1)
  const { eng, lastTs } = replay([P2])
  const rows = petRowsByName(eng, lastTs)
  assert.deepEqual([...rows.keys()].sort(), ['Gonekn', 'Jaber'])
  assert.deepEqual(rows.get('Jaber'), { hits: 8, total: 599 })
  assert.deepEqual(rows.get('Gonekn'), { hits: 41, total: 1700 })
  assert.deepEqual(eng.petDisplayNames(), ['Gonekn'])
})

test('P2: ASKING at 12:35 is worth as much as ORDERING at 12:35 — all 51 hits', { skip: skipArc }, () => {
  // The mirror of section 3's honest limit. A leader say binds FORWARD exactly like a tell, so the
  // instruction it buys is not "order it" but "say something to it, once, when you summon it" —
  // and either sentence at 12:35:45 recovers the 2,016 points that ordering at 12:43:12 loses.
  const asked = replay([P2], [`[Thu Aug 06 12:35:45 2026] Jaber says, 'My leader is Primitive.'`])
  assert.deepEqual(petRowsByName(asked.eng, asked.lastTs).get('Jaber'), { hits: 51, total: 2615 })
})
