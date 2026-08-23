// alertSeeds.ts — the seeded alert set, written through the DEFAULT-PACK PREFERENCE (JOS-273).
//
// A FILE OF ITS OWN, AND NOT storeSoundPacks.ts, BECAUSE OF THE IMPORT GRAPH. The seeds live in
// store.ts (SEED_ALERTS), the preference is a key in the same store, and storeSoundPacks.ts
// imports `settingsStore` FROM store.ts — so putting this there and calling it from store.ts
// would make the settings store an import cycle, which is the hazard STORE_READY_MS already
// documents about the perf module. This module takes the stored value as an ARGUMENT and reaches
// nothing that reaches back, so the graph stays a tree. store.ts is also at the repo's
// 400-code-line factoring ceiling, whose stated answer is a split rather than a widened threshold.
//
// WHAT IT DOES, in one sentence: point each seeded ref at the pack the user chose, then let the
// shared resolver find that pack's line of the same CESP category (a completion sting stays a
// completion line — the intent-preserving rule `migrateAlertSoundRef` established for retired
// packs). With no preference stored, or with nothing installed yet, it is the identity function:
// a FRESH INSTALL seeds exactly the bytes it always did, which is what the owner's ruling asks.

import { normalizeSoundPackPrefs, seedSoundRef } from '../shared/soundPacks'
import { DEFAULT_ALERT_PACK_ID, DEFAULT_ALERT_SOUNDS } from './data/defaultPacks'
import { listPacks } from './sounds'
import type { AlertDef } from '../shared/types'

/**
 * Rewrite a seed list's sound refs onto the user's default pack.
 *
 * `storedPrefs` is the RAW `soundPacks` value off the store — normalized here, through the same
 * function every other reader of that key uses, so a hand-edited file cannot put a path fragment
 * where a pack id goes.
 */
export function seedAlertsWith(seeds: readonly AlertDef[], storedPrefs: unknown): AlertDef[] {
  const packId = normalizeSoundPackPrefs(storedPrefs).defaultPackId ?? DEFAULT_ALERT_PACK_ID
  const fallback = { defaultPackId: packId, fallbackSoundId: DEFAULT_ALERT_SOUNDS.buffWearsOff }
  const packs = listPacks()
  return seeds.map((a) => ({ ...a, sound: seedSoundRef(a.sound, packs, fallback) }))
}
