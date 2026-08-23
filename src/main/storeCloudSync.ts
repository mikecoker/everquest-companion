// storeCloudSync.ts — the persisted half of Discord cloud sync's main-only settings.
//
// ANOTHER MODULE THROUGH THE `settingsStore` DOOR (storeCloseToTray.ts states the precedent and
// the full list before it): store.ts sits at the repo's 400-code-line factoring ceiling and the
// stated answer to that is a split rather than a widened threshold.
//
// ADDITIVE + OPTIONAL ⇒ NO SCHEMA BUMP, NO MIGRATION — the `lastSeenNotesVersion` /
// `eqDiscoveredRoot` / `buffTrust` / `soundPacks` / `overlaySnap` / `closeToTray` carve-out
// storeShape.ts documents. It is also private-by-construction: settings sharing reads an explicit
// whitelist and never reads this key, and the secret representation is main-only and never
// crosses IPC.

import { settingsStore } from './store'
import { normalizeStoredCloudSyncPrefs, type StoredCloudSyncPrefs } from './cloudSync/settingsControl'

/** Main-only cloud settings. Missing/malformed values always collapse to disabled. */
export function getStoredCloudSyncPrefs(): StoredCloudSyncPrefs {
  return normalizeStoredCloudSyncPrefs(settingsStore.get('cloudSync'))
}

export function setStoredCloudSyncPrefs(prefs: StoredCloudSyncPrefs): void {
  settingsStore.set('cloudSync', prefs)
}
