import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './worker/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-07',
        d1Databases: ['DB'],
        durableObjects: {
          SYNC_ROOM: { className: 'SyncRoom', useSQLite: true }
        },
        bindings: {
          DISCORD_CLIENT_ID: 'test-client',
          DISCORD_CLIENT_SECRET: 'test-client-secret',
          COOKIE_SIGNING_KEY: 'test-cookie-signing-key-with-enough-entropy',
          TICKET_SIGNING_KEY: 'test-ticket-signing-key-with-enough-entropy',
          DEVICE_PEPPER: 'test-device-pepper-with-enough-entropy',
          DISCORD_API_ORIGIN: 'https://discord.test',
          TEST_MIGRATIONS: await readD1Migrations('./migrations')
        }
      }
    }))
  ],
  test: {
    include: ['tests/worker/**/*.test.ts']
  }
})
