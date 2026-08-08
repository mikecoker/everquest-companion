export interface ViewerIdentity {
  id: string
  username: string
  displayName: string
  avatarUrl?: string
}

export interface ViewerAccount {
  user: ViewerIdentity
  paired: boolean
  devices: ViewerDevice[]
}

export interface ViewerDevice {
  id: string
  label: string
  createdAt: number
}

export interface ActivityApi {
  exchangeOAuthCode(code: string): Promise<string>
  loadMe(): Promise<ViewerAccount>
  createPairing(): Promise<{ code: string; expiresAt: number }>
  createViewerSession(): Promise<string>
  revokeDevice(deviceId: string): Promise<void>
  deleteAccount(): Promise<void>
}

type FetchLike = typeof fetch

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was invalid`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} was missing`)
  return value
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} was invalid`)
  return value
}

function identity(value: unknown): ViewerIdentity {
  const user = record(value, 'Account identity')
  return {
    id: requiredString(user.id, 'Account id'),
    username: requiredString(user.username, 'Username'),
    displayName: requiredString(user.displayName, 'Display name'),
    ...(typeof user.avatarUrl === 'string' ? { avatarUrl: user.avatarUrl } : {})
  }
}

async function request(fetcher: FetchLike, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(path, { credentials: 'include', ...init })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<unknown>
}

async function requestVoid(fetcher: FetchLike, path: string, init: RequestInit): Promise<void> {
  const response = await fetcher(path, { credentials: 'include', ...init })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
}

function device(value: unknown): ViewerDevice {
  const source = record(value, 'Device')
  return {
    id: requiredString(source.id, 'Device id'),
    label: requiredString(source.label, 'Device label'),
    createdAt: timestamp(source.createdAt, 'Device creation time')
  }
}

export function createActivityApi(fetcher: FetchLike = fetch): ActivityApi {
  return {
    async exchangeOAuthCode(code) {
      const data = record(await request(fetcher, '/api/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code })
      }), 'OAuth response')
      identity(data.account)
      return requiredString(data.accessToken, 'OAuth access token')
    },
    async loadMe() {
      const data = record(await request(fetcher, '/api/me'), 'Account response')
      if (!Array.isArray(data.devices) || typeof data.paired !== 'boolean') throw new Error('Account status was invalid')
      return {
        user: identity(data.account),
        paired: data.paired,
        devices: data.devices.map(device)
      }
    },
    async createPairing() {
      const data = record(await request(fetcher, '/api/pairing', { method: 'POST' }), 'Pairing response')
      return { code: requiredString(data.code, 'Pairing code'), expiresAt: timestamp(data.expiresAt, 'Pairing expiry') }
    },
    async createViewerSession() {
      const data = record(await request(fetcher, '/api/viewer/session', { method: 'POST' }), 'Viewer response')
      timestamp(data.expiresAt, 'Viewer expiry')
      return requiredString(data.ticket, 'Viewer ticket')
    },
    async revokeDevice(deviceId) {
      await requestVoid(fetcher, `/api/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    },
    async deleteAccount() {
      await requestVoid(fetcher, '/api/me', { method: 'DELETE' })
    }
  }
}

export function viewerSocketUrl(ticket: string, location: Location | URL = window.location): string {
  const url = new URL('/api/sync', location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}
