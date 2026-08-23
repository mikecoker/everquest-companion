import { safeStorage } from 'electron'
import type { CloudSyncStatus } from '../../shared/cloudSyncPrefs'
import { IPC } from '../../shared/ipc'
import { E2E } from '../e2e'
import { getStoredCloudSyncPrefs, setStoredCloudSyncPrefs } from '../storeCloudSync'
import { sendToMain } from '../windows'
import type { CloudSyncSecretCodec } from './secretStorage'
import {
  CloudSyncSettingsControl,
  type MainCloudSyncSettings
} from './settingsControl'

const electronCodec: CloudSyncSecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value))
}

export const cloudSyncSettings = new CloudSyncSettingsControl({
  read: getStoredCloudSyncPrefs,
  write: setStoredCloudSyncPrefs,
  codec: electronCodec,
  e2e: E2E,
  pushStatus: (status) => sendToMain(IPC.onCloudSyncStatus, status)
})

export function readMainCloudSyncSettings(): MainCloudSyncSettings {
  return cloudSyncSettings.read()
}

export function subscribeCloudSyncSettings(listener: (settings: MainCloudSyncSettings) => void): () => void {
  return cloudSyncSettings.subscribe(listener)
}

export function setCloudSyncPublisherStatus(status: unknown): CloudSyncStatus {
  return cloudSyncSettings.setStatus(status)
}
