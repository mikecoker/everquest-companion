import { CLOUD_SYNC_LIMITS } from '../../shared/cloudSync'
import type { CloudSyncCredentials } from './config'

const MAX_HTTP_BODY_CHARS = 8 * 1024

export interface PairDeviceResult extends CloudSyncCredentials {
  discordName: string
}

export interface DeviceSession {
  ticket: string
  expiresAt: number
}

export class CloudSyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message.slice(0, CLOUD_SYNC_LIMITS.maxErrorChars))
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

async function responseBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_HTTP_BODY_CHARS + 1)
  if (text.length > MAX_HTTP_BODY_CHARS) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function httpError(response: Response, value: unknown): CloudSyncHttpError {
  const error = objectValue(objectValue(value)?.error)
  const code = boundedString(error?.code, 64) ?? 'request_failed'
  const message = boundedString(error?.message, CLOUD_SYNC_LIMITS.maxErrorChars) ?? 'Cloud sync request failed'
  return new CloudSyncHttpError(response.status, code, message)
}

async function postJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const value = await responseBody(response)
  if (!response.ok) throw httpError(response, value)
  if (value === null) throw new CloudSyncHttpError(502, 'invalid_response', 'Cloud sync returned an invalid response')
  return value
}

function requiredString(source: Record<string, unknown>, key: string, max: number): string {
  const value = boundedString(source[key], max)
  if (value === null) throw new CloudSyncHttpError(502, 'invalid_response', 'Cloud sync returned an invalid response')
  return value
}

export class CloudSyncClient {
  constructor(
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async pair(code: string, label: string): Promise<PairDeviceResult> {
    const value = objectValue(await postJson(this.fetcher, `${this.endpoint}/api/devices/pair`, { code, label }))
    if (value === null) throw new CloudSyncHttpError(502, 'invalid_response', 'Cloud sync returned an invalid response')
    return {
      deviceId: requiredString(value, 'deviceId', 128),
      deviceSecret: requiredString(value, 'deviceSecret', 256),
      discordName: requiredString(value, 'discordName', CLOUD_SYNC_LIMITS.maxNameChars)
    }
  }

  async createSession(credentials: CloudSyncCredentials): Promise<DeviceSession> {
    const value = objectValue(
      await postJson(this.fetcher, `${this.endpoint}/api/devices/session`, {
        deviceId: credentials.deviceId,
        deviceSecret: credentials.deviceSecret
      })
    )
    const ticket = value === null ? null : boundedString(value.ticket, 256)
    const expiresAt = value?.expiresAt
    if (ticket === null || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      throw new CloudSyncHttpError(502, 'invalid_response', 'Cloud sync returned an invalid response')
    }
    return { ticket, expiresAt }
  }

  socketUrl(ticket: string): string {
    const url = new URL('/api/sync', `${this.endpoint}/`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)
    return url.toString()
  }
}
