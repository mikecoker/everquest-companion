import { CLOUD_SYNC_PROTOCOL_VERSION, type ServerCloudSyncMessage } from '../../src/shared/cloudSync'
import type { ServerCloudRoomMessage } from '../../src/shared/cloudRoom'
import type { SyncRole } from './types'

const RATE_WINDOW_MS = 10 * 1000
const MESSAGE_BUDGET = 30
const BYTE_BUDGET = 512 * 1024
const MAX_OFFENSES = 3

export interface SocketAttachment {
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

type OutgoingMessage = ServerCloudSyncMessage | ServerCloudRoomMessage

export function safeSend(socket: WebSocket, message: OutgoingMessage): void {
  try {
    socket.send(JSON.stringify(message))
  } catch {
    // The close callback owns presence changes; a racing send is disposable.
  }
}

export function attachment(socket: WebSocket): SocketAttachment | null {
  try {
    return socket.deserializeAttachment() as SocketAttachment | null
  } catch {
    return null
  }
}

export function chargeSocket(socket: WebSocket, body: string): boolean {
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
