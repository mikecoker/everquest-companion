import { env } from 'cloudflare:workers'
import { applyD1Migrations, reset } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { CleanupScheduler, cleanupExpiredRows } from '../../worker/retention'
import { ACCOUNT_ID, seedAccount } from './helpers'

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

async function count(table: 'pairing' | 'session_ticket' | 'rate_limit', condition: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}`).first<{ count: number }>()
  return row?.count ?? 0
}

describe('bounded control-plane retention', () => {
  it('removes only a bounded batch of expired rows from each transient table', async () => {
    await seedAccount()
    for (let index = 0; index < 3; index += 1) {
      await env.DB.prepare(
        'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, ?, NULL, 1)'
      ).bind(`pair-${index}`, ACCOUNT_ID, index + 1).run()
      await env.DB.prepare(
        `INSERT INTO session_ticket
           (token_hash, discord_user_id, role, subject_id, expires_at, consumed_at, created_at)
         VALUES (?, ?, 'viewer', ?, ?, NULL, 1)`
      ).bind(`ticket-${index}`, ACCOUNT_ID, ACCOUNT_ID, index + 1).run()
      await env.DB.prepare('INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, ?)')
        .bind(`expired-${index}`, index + 1).run()
    }
    await env.DB.prepare(
      'INSERT INTO pairing (code_hash, discord_user_id, expires_at, consumed_at, created_at) VALUES (?, ?, 100, NULL, 1)'
    ).bind('active-pair', ACCOUNT_ID).run()
    await env.DB.prepare(
      `INSERT INTO session_ticket
         (token_hash, discord_user_id, role, subject_id, expires_at, consumed_at, created_at)
       VALUES ('active-ticket', ?, 'viewer', ?, 100, NULL, 1)`
    ).bind(ACCOUNT_ID, ACCOUNT_ID).run()
    await env.DB.prepare("INSERT INTO rate_limit (key, count, reset_at) VALUES ('active-rate', 1, 100)").run()

    await cleanupExpiredRows(env, { now: 10, limit: 2 })
    expect(await count('pairing', 'expires_at <= 10')).toBe(1)
    expect(await count('session_ticket', 'expires_at <= 10')).toBe(1)
    expect(await count('rate_limit', 'reset_at <= 10')).toBe(1)
    expect(await count('pairing', 'expires_at > 10')).toBe(1)
    expect(await count('session_ticket', 'expires_at > 10')).toBe(1)
    expect(await count('rate_limit', 'reset_at > 10')).toBe(1)
  })

  it('rejects cleanup limits that could make a request unbounded', async () => {
    await expect(cleanupExpiredRows(env, { limit: 101 })).rejects.toThrow('between 1 and 100')
  })

  it('schedules at most one bounded cleanup per five-minute isolate window', async () => {
    const scheduler = new CleanupScheduler()
    const pending: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    scheduler.schedule(env, context, 100)
    scheduler.schedule(env, context, 101)
    scheduler.schedule(env, context, 300_100)
    expect(pending).toHaveLength(2)
    await Promise.all(pending)
  })
})
