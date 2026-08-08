import type { SyncRoom } from './SyncRoom'

export interface Env {
  DB: D1Database
  SYNC_ROOM: DurableObjectNamespace<SyncRoom>
  ASSETS?: Fetcher
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  COOKIE_SIGNING_KEY: string
  TICKET_SIGNING_KEY: string
  DEVICE_PEPPER: string
  ACTIVITY_COOKIE_DOMAIN?: string
  DISCORD_API_ORIGIN?: string
}

export interface CloudAccount {
  id: string
  username: string
  displayName: string
  avatarUrl?: string
}

export type SyncRole = 'publisher' | 'viewer'

export interface SyncHandoff {
  accountId: string
  role: SyncRole
  subjectId: string
  expiresAt: number
  nonce: string
}
