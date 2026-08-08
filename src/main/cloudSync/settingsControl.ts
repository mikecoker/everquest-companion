import type { CloudSyncCredentials, CloudSyncSettings } from './config'
import { cloudSyncEndpoint, resolveCloudSyncConfig } from './config'
import type { PairDeviceResult } from './client'
import type { StoredCloudSyncSecret, CloudSyncSecretCodec } from './secretStorage'
import { decodeCloudSyncSecret, encodeCloudSyncSecret } from './secretStorage'
import type { CloudSyncActionResult, CloudSyncPrefsView, CloudSyncStatus } from '../../shared/cloudSyncPrefs'
import { sanitizeCloudSyncStatus } from '../../shared/cloudSyncPrefs'

export interface StoredCloudSyncPrefs {
  enabled: boolean
  endpoint: string
  deviceId?: string
  deviceSecret?: StoredCloudSyncSecret
  pairedDiscordName?: string
}

function storedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function storedSecret(value: unknown): StoredCloudSyncSecret | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (source.kind !== 'safeStorage' && source.kind !== 'plaintext') return undefined
  const secret = storedText(source.value, 2048)
  return secret === undefined ? undefined : { kind: source.kind, value: secret }
}

export function normalizeStoredCloudSyncPrefs(value: StoredCloudSyncPrefs | undefined): StoredCloudSyncPrefs {
  if (value === undefined) return { enabled: false, endpoint: '' }
  const endpoint = typeof value.endpoint === 'string' && value.endpoint.length <= 512 ? value.endpoint : ''
  const deviceId = storedText(value.deviceId, 128)
  const deviceSecret = storedSecret(value.deviceSecret)
  const pairedDiscordName = storedText(value.pairedDiscordName, 128)
  const hasCredentials = deviceId !== undefined && deviceSecret !== undefined
  return {
    enabled: value.enabled && hasCredentials,
    endpoint,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(deviceSecret === undefined ? {} : { deviceSecret }),
    ...(pairedDiscordName === undefined ? {} : { pairedDiscordName })
  }
}

export interface MainCloudSyncSettings extends CloudSyncSettings {
  endpoint: string
  pairedDiscordName?: string
  secretProtected: boolean
}

export interface CloudSyncSettingsDeps {
  read(): StoredCloudSyncPrefs
  write(value: StoredCloudSyncPrefs): void
  codec: CloudSyncSecretCodec
  e2e: boolean
  pushStatus(status: CloudSyncStatus): void
}

type SettingsListener = (settings: MainCloudSyncSettings) => void

function credentials(prefs: StoredCloudSyncPrefs, codec: CloudSyncSecretCodec): {
  credentials?: CloudSyncCredentials
  secretProtected: boolean
} {
  if (prefs.deviceId === undefined || prefs.deviceSecret === undefined) return { secretProtected: true }
  const secret = decodeCloudSyncSecret(prefs.deviceSecret, codec)
  if (secret === null) return { secretProtected: prefs.deviceSecret.kind === 'safeStorage' }
  return { credentials: { deviceId: prefs.deviceId, deviceSecret: secret.value }, secretProtected: secret.protected }
}

export class CloudSyncSettingsControl {
  private readonly listeners = new Set<SettingsListener>()
  private status: CloudSyncStatus = { state: 'disabled' }
  private statusInitialized = false

  constructor(private readonly deps: CloudSyncSettingsDeps) {}

  read(): MainCloudSyncSettings {
    const prefs = this.deps.read()
    const decoded = credentials(prefs, this.deps.codec)
    return {
      enabled: prefs.enabled && decoded.credentials !== undefined,
      endpoint: prefs.endpoint,
      ...(decoded.credentials === undefined ? {} : { credentials: decoded.credentials }),
      ...(prefs.pairedDiscordName === undefined ? {} : { pairedDiscordName: prefs.pairedDiscordName }),
      secretProtected: decoded.secretProtected
    }
  }

  view(): CloudSyncPrefsView {
    const settings = this.read()
    return {
      enabled: settings.enabled,
      endpoint: settings.endpoint,
      paired: settings.credentials !== undefined,
      ...(settings.pairedDiscordName === undefined ? {} : { pairedDiscordName: settings.pairedDiscordName }),
      secretProtected: settings.secretProtected
    }
  }

  getStatus(): CloudSyncStatus {
    if (!this.statusInitialized) {
      this.status = this.read().enabled ? { state: 'connecting' } : { state: 'disabled' }
      this.statusInitialized = true
    }
    return this.status
  }

  setStatus(value: unknown): CloudSyncStatus {
    this.statusInitialized = true
    this.status = sanitizeCloudSyncStatus(value)
    this.deps.pushStatus(this.status)
    return this.status
  }

  setEndpoint(value: string): CloudSyncActionResult {
    const endpoint = cloudSyncEndpoint(value)
    if (endpoint === null) return this.failure('Enter an HTTPS origin (localhost may use HTTP).')
    const current = this.deps.read()
    const changed = cloudSyncEndpoint(current.endpoint) !== endpoint
    const credentialsCleared = changed && current.deviceId !== undefined
    this.commit(changed ? { enabled: false, endpoint } : { ...current, endpoint })
    return { ok: true, prefs: this.view(), ...(credentialsCleared ? { credentialsCleared: true } : {}) }
  }

  savePair(result: PairDeviceResult): CloudSyncActionResult {
    const current = this.deps.read()
    this.commit({
      enabled: false,
      endpoint: current.endpoint,
      deviceId: result.deviceId,
      deviceSecret: encodeCloudSyncSecret(result.deviceSecret, this.deps.codec),
      pairedDiscordName: result.discordName
    })
    return { ok: true, prefs: this.view() }
  }

  setEnabled(enabled: boolean): CloudSyncActionResult {
    const current = this.read()
    if (enabled && !resolveCloudSyncConfig({ ...current, enabled: true }, this.deps.e2e).enabled) {
      return this.failure('Save a valid endpoint and pair this device before enabling cloud sync.')
    }
    this.commit({ ...this.deps.read(), enabled })
    return { ok: true, prefs: this.view() }
  }

  forget(): CloudSyncActionResult {
    this.commit({ enabled: false, endpoint: this.deps.read().endpoint })
    return { ok: true, prefs: this.view() }
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private failure(error: string): CloudSyncActionResult {
    return { ok: false, prefs: this.view(), error }
  }

  private commit(next: StoredCloudSyncPrefs): void {
    this.deps.write(next)
    const settings = this.read()
    this.status = settings.enabled ? { state: 'connecting' } : { state: 'disabled' }
    this.statusInitialized = true
    for (const listener of this.listeners) listener(settings)
    this.deps.pushStatus(this.status)
  }
}
