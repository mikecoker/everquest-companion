export interface CloudSyncCredentials {
  deviceId: string
  deviceSecret: string
}

export interface CloudSyncSettings {
  enabled: boolean
  endpoint?: string
  credentials?: CloudSyncCredentials
}

export type CloudSyncConfig =
  | { enabled: false; reason: 'disabled' | 'e2e' | 'invalid_endpoint' | 'missing_credentials' }
  | { enabled: true; endpoint: string; credentials: CloudSyncCredentials }

function isLocalHttp(url: URL): boolean {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  return local && url.protocol === 'http:'
}

function isBareOrigin(url: URL): boolean {
  return (
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    (url.pathname === '' || url.pathname === '/')
  )
}

function normalizedEndpoint(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && !isLocalHttp(url)) return null
    if (!isBareOrigin(url)) return null
    url.pathname = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

function validCredentials(value: CloudSyncCredentials | undefined): value is CloudSyncCredentials {
  return (
    value !== undefined &&
    value.deviceId.trim().length > 0 &&
    value.deviceId.length <= 128 &&
    value.deviceSecret.length > 0 &&
    value.deviceSecret.length <= 256
  )
}

export function cloudSyncEndpoint(value: string | undefined): string | null {
  return normalizedEndpoint(value)
}

export function resolveCloudSyncConfig(settings: CloudSyncSettings, e2e = process.env.EQ_E2E === '1'): CloudSyncConfig {
  if (e2e) return { enabled: false, reason: 'e2e' }
  if (!settings.enabled) return { enabled: false, reason: 'disabled' }
  const endpoint = normalizedEndpoint(settings.endpoint)
  if (endpoint === null) return { enabled: false, reason: 'invalid_endpoint' }
  if (!validCredentials(settings.credentials)) return { enabled: false, reason: 'missing_credentials' }
  return { enabled: true, endpoint, credentials: settings.credentials }
}
