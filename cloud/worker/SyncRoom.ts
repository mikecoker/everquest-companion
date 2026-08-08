import { DurableObject } from 'cloudflare:workers'
import {
  CLOUD_SYNC_LIMITS,
  CLOUD_SYNC_PROTOCOL_VERSION,
  parseDesktopCloudSyncJson,
  type CloudSyncState,
  type ServerCloudSyncMessage
} from '../../src/shared/cloudSync'
import { verifySignedValue } from './crypto'
import type { Env, SyncHandoff, SyncRole } from './types'

const OFFLINE_TTL_MS = 60 * 60 * 1000
const RATE_WINDOW_MS = 10 * 1000
const MESSAGE_BUDGET = 30
const BYTE_BUDGET = 512 * 1024
const MAX_OFFENSES = 3

interface SocketAttachment {
  role: SyncRole
  subjectId: string
  connectedAt: number
  windowStartedAt: number
  messages: number
  bytes: number
  offenses: number
}

interface StoredState {
  revision: number
  state: CloudSyncState
}

function serverMessage(message: ServerCloudSyncMessage): string {
  return JSON.stringify(message)
}

function safeSend(socket: WebSocket, message: ServerCloudSyncMessage): void {
  try {
    socket.send(serverMessage(message))
  } catch {
    // The close callback owns presence changes; a racing send is disposable.
  }
}

function attachment(socket: WebSocket): SocketAttachment | null {
  try {
    return socket.deserializeAttachment() as SocketAttachment | null
  } catch {
    return null
  }
}

export class SyncRoom extends DurableObject<Env> {
  private erased = false

  private publishers(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket !== except && attachment(socket)?.role === 'publisher')
  }

  private broadcast(message: ServerCloudSyncMessage, role?: SyncRole): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (role === undefined || attachment(socket)?.role === role) safeSend(socket, message)
    }
  }

  private async readHandoff(request: Request): Promise<SyncHandoff | null> {
    const signed = request.headers.get('x-eq-sync-handoff')
    if (signed === null) return null
    const value = await verifySignedValue(signed, this.env.TICKET_SIGNING_KEY)
    if (value === null) return null
    try {
      const handoff = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as SyncHandoff
      if (
        typeof handoff.accountId !== 'string' ||
        (handoff.role !== 'publisher' && handoff.role !== 'viewer') ||
        typeof handoff.subjectId !== 'string' ||
        typeof handoff.nonce !== 'string' ||
        typeof handoff.expiresAt !== 'number' ||
        handoff.expiresAt <= Date.now()
      ) {
        return null
      }
      return handoff
    } catch {
      return null
    }
  }

  private closeDuplicatePublisher(subjectId: string): void {
    for (const socket of this.publishers()) {
      if (attachment(socket)?.subjectId === subjectId) socket.close(4001, 'Replaced by a newer connection')
    }
  }

  private async initializeSocket(socket: WebSocket, handoff: SyncHandoff): Promise<void> {
    const now = Date.now()
    if (handoff.role === 'publisher') this.closeDuplicatePublisher(handoff.subjectId)
    this.ctx.acceptWebSocket(socket)
    socket.serializeAttachment({
      role: handoff.role,
      subjectId: handoff.subjectId,
      connectedAt: now,
      windowStartedAt: now,
      messages: 0,
      bytes: 0,
      offenses: 0
    } satisfies SocketAttachment)
    safeSend(socket, {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'ready',
      sessionId: handoff.nonce,
      serverTime: now
    })
    if (handoff.role === 'publisher') {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.put('online', true)
      this.broadcast({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: true })
      return
    }
    const latest = await this.ctx.storage.get<StoredState>('latest')
    if (latest !== undefined) {
      safeSend(socket, {
        version: CLOUD_SYNC_PROTOCOL_VERSION,
        type: 'state',
        revision: latest.revision,
        state: latest.state
      })
    }
    const online = this.publishers().length > 0
    const lastSeenAt = await this.ctx.storage.get<number>('lastSeenAt')
    safeSend(socket, {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'presence',
      online,
      ...(!online && lastSeenAt !== undefined ? { lastSeenAt } : {})
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 })
    const handoff = await this.readHandoff(request)
    if (handoff === null || this.erased) return new Response('Unauthorized', { status: 401 })
    const account = await this.env.DB.prepare('SELECT 1 AS active FROM account WHERE discord_user_id = ?')
      .bind(handoff.accountId)
      .first<{ active: number }>()
    if (account === null) return new Response('Unauthorized', { status: 401 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    await this.initializeSocket(server, handoff)
    return new Response(null, { status: 101, webSocket: client })
  }

  private charge(socket: WebSocket, body: string): boolean {
    const budget = attachment(socket)
    if (budget === null) return false
    const now = Date.now()
    const reset = now - budget.windowStartedAt >= RATE_WINDOW_MS
    const next: SocketAttachment = {
      ...budget,
      windowStartedAt: reset ? now : budget.windowStartedAt,
      messages: (reset ? 0 : budget.messages) + 1,
      bytes: (reset ? 0 : budget.bytes) + new TextEncoder().encode(body).byteLength
    }
    const overBudget = next.messages > MESSAGE_BUDGET || next.bytes > BYTE_BUDGET
    if (overBudget) next.offenses = Math.min(MAX_OFFENSES, next.offenses + 1)
    socket.serializeAttachment(next)
    if (!overBudget) return true
    safeSend(socket, {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'error',
      code: 'rate_limited',
      message: 'Publisher rate limit exceeded',
      retryAfterMs: RATE_WINDOW_MS
    })
    if (next.offenses >= MAX_OFFENSES) socket.close(4008, 'Rate limit exceeded')
    return false
  }

  private rejectMessage(socket: WebSocket, code: 'invalid_message' | 'version_mismatch', message: string): void {
    safeSend(socket, {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'error',
      code,
      message: message.slice(0, CLOUD_SYNC_LIMITS.maxErrorChars)
    })
  }

  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    const meta = attachment(socket)
    if (meta?.role !== 'publisher' || typeof value !== 'string') {
      this.rejectMessage(socket, 'invalid_message', 'Only publishers may send text messages')
      return
    }
    if (!this.charge(socket, value)) return
    const parsed = parseDesktopCloudSyncJson(value)
    if (!parsed.ok) {
      this.rejectMessage(
        socket,
        parsed.error.code === 'unsupported_version' ? 'version_mismatch' : 'invalid_message',
        parsed.error.message
      )
      return
    }
    if (parsed.value.type === 'ping') return
    const revision = ((await this.ctx.storage.get<number>('revision')) ?? 0) + 1
    const latest: StoredState = { revision, state: parsed.value.state }
    await this.ctx.storage.put({ revision, latest, online: true })
    this.broadcast(
      { version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'state', revision, state: parsed.value.state },
      'viewer'
    )
  }

  private async handlePublisherDeparture(socket: WebSocket): Promise<void> {
    if (this.erased || attachment(socket)?.role !== 'publisher' || this.publishers(socket).length > 0) return
    await this.markOffline()
  }

  private async markOffline(): Promise<void> {
    if ((await this.ctx.storage.get<boolean>('online')) === false) return
    const lastSeenAt = Date.now()
    await this.ctx.storage.put({ online: false, lastSeenAt })
    await this.ctx.storage.setAlarm(lastSeenAt + OFFLINE_TTL_MS)
    this.broadcast({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: false, lastSeenAt }, 'viewer')
  }

  async disconnectPublisher(deviceId: string): Promise<boolean> {
    const matching = this.publishers().filter((socket) => attachment(socket)?.subjectId === deviceId)
    if (matching.length === 0) return false
    const matchingSet = new Set(matching)
    const hasOtherPublisher = this.publishers().some((socket) => !matchingSet.has(socket))
    if (!hasOtherPublisher) await this.markOffline()
    for (const socket of matching) socket.close(4003, 'Device revoked')
    return true
  }

  async eraseAccount(): Promise<void> {
    this.erased = true
    for (const socket of this.ctx.getWebSockets()) socket.close(4004, 'Account deleted')
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.handlePublisherDeparture(socket)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.handlePublisherDeparture(socket)
  }

  async alarm(): Promise<void> {
    if (this.publishers().length > 0) return
    await this.ctx.storage.deleteAll()
  }
}
