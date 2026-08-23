// THE CALM LINE golden-window fixture extractor (JOS-213, 2026-08-12).
//
// Same law as tests/extract-poison-slow-fixtures.mjs: the window is kept VERBATIM and only what
// the shared scrub (tests/fixture-scrub.mjs `scrubKeep`) classifies as third-party chat/social is
// dropped. NEVER hand-copy a span into fixtures/ and never re-implement the drop list:
// `tests/fixtures/*.log` is COMMITTED to a PUBLIC repo.
//
// Usage: npm run fixtures:calm -- "<path to eqlog_Primitive_freeport.txt>"
//    or: node --import tsx tests/extract-calm-fixtures.mjs "<path>"
//
// Line numbers are against the LIVE log (1,597,052 lines as of Wed Aug 12 2026). The log only ever
// grows by APPENDING, so a span's raw range stays valid; the timestamps below are the real anchor
// if a number ever looks wrong.
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { scrubKeep } from './fixture-scrub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('[')) continue
    if (!scrubKeep(l)) continue
    seg.push(l)
  }
  writeFileSync(join(HERE, 'fixtures', out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// ---------------------------------------------------------------------------------------
// W64 PACIFY ON A MOB (Wed Aug 05 20:27:40 → 20:32:05, raw 1394040..1394158).
//
// The reporter's case, in the OWNER's own bytes. Report 01KZSDPV3NV8NWK2GF01MCQMK3 quotes
// `You begin casting Pacify IV.` / `an icy terror looks less aggressive.` and asks for the timer
// to report to the DEBUFF overlay; the owner's log has the identical shape 206 times over
// (55 distinct subjects), so nothing here is authored or injected.
//
// Hand-read, in order:
//   20:28:23  You have entered Nagafen's Lair - Solo 4 (Refined).   ← the window opens on a ZONE,
//                                                                     so the model starts clean
//   20:30:26  You begin casting Pacify.
//   20:30:28  a fire giant warrior looks less aggressive.           ← landing #1
//   20:30:39  You begin casting Pacify.
//   20:30:42  a fire giant warrior looks less aggressive.           ← #2, a SECOND mob of the name
//   20:30:56  You begin casting Pacify.
//   20:30:58  a fire giant warrior looks less aggressive.           ← #3
//   20:31:05  You begin casting Pacify.
//   20:31:07  a fire giant warrior looks less aggressive.           ← #4
//   20:31:15  Your Pacify spell has worn off of a fire giant warrior.
//   20:31:16  You begin casting Pacify.
//   20:31:19  a fire giant wizard looks less aggressive.            ← a DIFFERENT mob name
//   20:31:27  Your Pacify spell has worn off of a fire giant warrior.
//   20:31:39  Your Pacify spell has worn off of a fire giant warrior.
//   20:31:51  Your Pacify spell has worn off of a fire giant warrior.
//   20:32:05  Your Pacify spell has worn off of a fire giant wizard.
//
// WHY THIS WINDOW AND NOT ONE OF THE OTHERS. Every other Pacify span in the log has a charmed pet
// standing in it whose NAME the pacified mobs share (`a fire giant warrior has been charmed.` at
// 20:08:21, `Bzzazzt has been charmed.` on Aug 09) — the name collision AGENTS.md already records,
// which files the landing as a PET buff and says nothing about routing either way. This one is
// clean: no charm is live between the zone and the last wear-off.
//
// WHAT THE MODEL MAKES OF IT, MEASURED (and asserted in tests/buffTimers.test.mts). The four
// warrior landings are four separate log SECONDS, so each is a round of one against a group of
// one: the round rule (buffRounds.ts) REFRESHES the newest hold rather than appending, the row
// keeps a count of 1, and every refresh CONTAMINATES — so this span mints no duration sample at
// all and the bar counts down from Pacify's stated 42 s throughout. That is the same learner, the
// same refusal and the same count-and-close rule every mob debuff timer runs on, which is the half
// of the ticket that needed no code: it was already true, and this fixture is what says so.
slice(1394040, 1394158, 'w64-pacify-mob.log')

// ---------------------------------------------------------------------------------------
// W65 A PACIFIED MOB IS KILLED (Mon Jul 20 19:43:50 → 19:44:58, raw 157405..157625).
//
// The other half of "behaves like every other mob debuff timer": a hold that DAMAGE cannot break.
// JOS-228 gave the CC module a verb-aware death rule — a mez cannot be killed while it is mezzed,
// the log says `<mob> has been awakened by <name>.` before the corpse ever appears, so a death
// arriving under a live mez is about a DIFFERENT mob of that name. A calm is not that kind of
// hold: a pacified mob is pacified, not immune, and you can walk up and kill it. So the ordinary
// decrement-one death censor applies (buffsInstanceRules.ts `deathCensorsOpen`, whose header
// already names the PACIFY family as the reason it tests disposition and not just class).
//
// Hand-read, in order — the owner soothing his way through Lower Guk at level ~24:
//   19:44:00  You begin casting Soothe.
//   19:44:01  a shin ghoul knight looks less aggressive.
//   19:44:07  You begin casting Soothe.
//   19:44:08  a vampire bat looks less aggressive.          ← the CONTROL: a second mob, untouched
//   19:44:13  You begin casting Soothe.
//   19:44:14  a vampire bat looks less aggressive.
//   19:44:19  You begin casting Soothe.
//   19:44:20  a shin ghoul knight looks less aggressive.
//   19:44:30  You begin casting Boil Blood.                 ← …and then he kills it anyway
//   19:44:55  You have slain a shin ghoul knight!           ← the death, 35 s into a 150 s Soothe
//   19:44:56  Your Soothe spell has worn off of a shin ghoul knight.
//
// The wear-off one second AFTER the corpse is the log's own confirmation and is deliberately kept:
// the death has already closed the landing, so it lands on an empty group and must mint nothing.
slice(157405, 157625, 'w65-pacify-mob-death.log')
