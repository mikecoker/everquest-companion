import type { SyncRoom } from './worker/SyncRoom'

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      SYNC_ROOM: DurableObjectNamespace<SyncRoom>
      DISCORD_CLIENT_ID: string
      DISCORD_CLIENT_SECRET: string
      COOKIE_SIGNING_KEY: string
      TICKET_SIGNING_KEY: string
      DEVICE_PEPPER: string
      DISCORD_API_ORIGIN: string
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
