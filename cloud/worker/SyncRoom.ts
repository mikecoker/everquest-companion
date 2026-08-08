import { DurableObject } from 'cloudflare:workers'
import {
  CLOUD_SYNC_LIMITS,
  CLOUD_SYNC_PROTOCOL_VERSION,
  parseDesktopCloudSyncJson,
  type CloudSyncState,
  type ServerCloudSyncMessage
} from '../../src/shared/cloudSync'
import type { ServerCloudRoomMessage } from '../../src/shared/cloudRoom'
import { verifySignedValue } from './crypto'
import {
  addRoomMember,
  applyRoomContribution,
  createStoredRoom,
  removeRoomMember,
  roomSnapshot,
  type RoomMemberIdentity,
  type StoredRoomState
} from './roomState'
import type { Env, SyncHandoff, SyncRole } from './types'

const OFFLINE_TTL_MS = 60 * 60 * 1000
const RATE_WINDOW_MS = 10 * 1000
const MESSAGE_BUDGET = 30
const BYTE_BUDGET = 512 * 1024
const MAX_OFFENSES = 3

interface SocketAttachment {
  role: SyncRole
  accountId: string
  roomId?: string
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

export interface SharedRoomTarget {
  roomId: string
  name: string
  ownerParticipantId: string
  member: RoomMemberIdentity
}

type OutgoingMessage = ServerCloudSyncMessage | ServerCloudRoomMessage

function serverMessage(message: OutgoingMessage): string {
  return JSON.stringify(message)
}

function safeSend(socket: WebSocket, message: OutgoingMessage): void {
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

function validHandoff(value: SyncHandoff): boolean {
  return typeof value.accountId === 'string' &&
    (value.roomId === undefined || typeof value.roomId === 'string') &&
    (value.role === 'publisher' || value.role === 'viewer') &&
    typeof value.subjectId === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.expiresAt === 'number' &&
    value.expiresAt > Date.now()
}

export class SyncRoom extends DurableObject<Env> {
  private erased = false

  private publishers(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket !== except && attachment(socket)?.role === 'publisher')
  }

  private broadcast(message: OutgoingMessage, role?: SyncRole): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (role === undefined || attachment(socket)?.role === role) safeSend(socket, message)
    }
  }

  private sendRoom(socket: WebSocket, stored: StoredRoomState): void {
    safeSend(socket, {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'room',
      room: roomSnapshot(stored, Date.now())
    })
  }

  private broadcastRoom(stored: StoredRoomState): void {
    const message: ServerCloudRoomMessage = {
      version: CLOUD_SYNC_PROTOCOL_VERSION,
      type: 'room',
      room: roomSnapshot(stored, Date.now())
    }
    for (const socket of this.ctx.getWebSockets()) {
      if (attachment(socket)?.roomId === stored.roomId) safeSend(socket, message)
    }
  }

  private async pushSharedContribution(state: CloudSyncState, online: boolean, now: number): Promise<void> {
    const target = await this.ctx.storage.get<SharedRoomTarget>('sharedTarget')
    if (target === undefined) return
    const shared = this.env.SYNC_ROOM.get(this.env.SYNC_ROOM.idFromName(`shared:${target.roomId}`))
    await shared.updateRoomContribution(target, state, online, now)
  }

  private async loadSharedRoom(roomId: string): Promise<StoredRoomState | undefined> {
    const room = await this.env.DB.prepare(
      'SELECT name, owner_discord_user_id FROM room WHERE id = ? AND closed_at IS NULL'
    ).bind(roomId).first<{ name: string; owner_discord_user_id: string }>()
    if (room === null) return undefined
    const rows = await this.env.DB.prepare(
      `SELECT a.discord_user_id, a.display_name, a.avatar_url
       FROM room_member rm JOIN account a ON a.discord_user_id = rm.discord_user_id
       WHERE rm.room_id = ? AND rm.left_at IS NULL ORDER BY rm.joined_at`
    ).bind(roomId).all<{ discord_user_id: string; display_name: string; avatar_url: string | null }>()
    const stored = createStoredRoom(roomId, room.name, room.owner_discord_user_id)
    for (const row of rows.results) {
      addRoomMember(stored, {
        participantId: row.discord_user_id,
        displayName: row.display_name,
        ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url })
      })
    }
    await this.ctx.storage.put('sharedRoom', stored)
    return stored
  }

  async attachToSharedRoom(target: SharedRoomTarget): Promise<void> {
    await this.ctx.storage.put('sharedTarget', target)
    const shared = this.env.SYNC_ROOM.get(this.env.SYNC_ROOM.idFromName(`shared:${target.roomId}`))
    await shared.configureSharedRoom(target)
    const latest = await this.ctx.storage.get<StoredState>('latest')
    if (latest !== undefined) await shared.updateRoomContribution(target, latest.state, this.publishers().length > 0, Date.now())
  }

  async detachFromSharedRoom(roomId: string): Promise<void> {
    const target = await this.ctx.storage.get<SharedRoomTarget>('sharedTarget')
    if (target?.roomId === roomId) await this.ctx.storage.delete('sharedTarget')
  }

  async configureSharedRoom(target: SharedRoomTarget): Promise<void> {
    const stored = (await this.ctx.storage.get<StoredRoomState>('sharedRoom')) ??
      createStoredRoom(target.roomId, target.name, target.ownerParticipantId)
    stored.name = target.name
    stored.ownerParticipantId = target.ownerParticipantId
    addRoomMember(stored, target.member)
    await this.ctx.storage.put('sharedRoom', stored)
    this.broadcastRoom(stored)
  }

  async updateRoomContribution(
    target: SharedRoomTarget,
    state: CloudSyncState,
    online: boolean,
    now: number
  ): Promise<void> {
    const stored = (await this.ctx.storage.get<StoredRoomState>('sharedRoom')) ??
      createStoredRoom(target.roomId, target.name, target.ownerParticipantId)
    applyRoomContribution(stored, {
      member: target.member,
      state,
      online,
      now,
      encounterId: crypto.randomUUID()
    })
    await this.ctx.storage.put('sharedRoom', stored)
    this.broadcastRoom(stored)
  }

  async removeSharedRoomMember(participantId: string): Promise<void> {
    const stored = await this.ctx.storage.get<StoredRoomState>('sharedRoom')
    if (stored === undefined) return
    removeRoomMember(stored, participantId, Date.now())
    await this.ctx.storage.put('sharedRoom', stored)
    for (const socket of this.ctx.getWebSockets()) {
      if (attachment(socket)?.accountId === participantId) socket.close(4007, 'Left shared room')
    }
    this.broadcastRoom(stored)
  }

  async closeSharedRoom(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(4006, 'Shared room closed')
    await this.ctx.storage.deleteAll()
  }

  private async readHandoff(request: Request): Promise<SyncHandoff | null> {
    const signed = request.headers.get('x-eq-sync-handoff')
    if (signed === null) return null
    const value = await verifySignedValue(signed, this.env.TICKET_SIGNING_KEY)
    if (value === null) return null
    try {
      const handoff = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as SyncHandoff
      return validHandoff(handoff) ? handoff : null
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
      accountId: handoff.accountId,
      ...(handoff.roomId === undefined ? {} : { roomId: handoff.roomId }),
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
    if (handoff.role === 'viewer' && handoff.roomId !== undefined) {
      const shared = (await this.ctx.storage.get<StoredRoomState>('sharedRoom')) ??
        await this.loadSharedRoom(handoff.roomId)
      if (shared !== undefined) this.sendRoom(socket, shared)
      return
    }
    if (handoff.role === 'publisher') {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.put('online', true)
      this.broadcast({ version: CLOUD_SYNC_PROTOCOL_VERSION, type: 'presence', online: true })
      const latest = await this.ctx.storage.get<StoredState>('latest')
      if (latest !== undefined) await this.pushSharedContribution(latest.state, true, now)
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
    if (handoff.roomId !== undefined) {
      const membership = await this.env.DB.prepare(
        `SELECT 1 AS active FROM room_member rm JOIN room r ON r.id = rm.room_id
         WHERE rm.room_id = ? AND rm.discord_user_id = ? AND rm.left_at IS NULL AND r.closed_at IS NULL`
      ).bind(handoff.roomId, handoff.accountId).first<{ active: number }>()
      if (membership === null) return new Response('Unauthorized', { status: 401 })
    }
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
    await this.pushSharedContribution(parsed.value.state, true, Date.now())
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
    const latest = await this.ctx.storage.get<StoredState>('latest')
    if (latest !== undefined) await this.pushSharedContribution(latest.state, false, lastSeenAt)
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
    const target = await this.ctx.storage.get<SharedRoomTarget>('sharedTarget')
    if (target !== undefined) {
      const shared = this.env.SYNC_ROOM.get(this.env.SYNC_ROOM.idFromName(`shared:${target.roomId}`))
      await shared.removeSharedRoomMember(target.member.participantId)
    }
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
