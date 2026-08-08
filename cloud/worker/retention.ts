import type { Env } from './types'

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const CLEANUP_BATCH_SIZE = 100

export interface CleanupOptions {
  now?: number
  limit?: number
}

export async function cleanupExpiredRows(env: Env, options: CleanupOptions = {}): Promise<void> {
  const { now = Date.now(), limit = CLEANUP_BATCH_SIZE } = options
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLEANUP_BATCH_SIZE) {
    throw new Error(`Cleanup limit must be between 1 and ${CLEANUP_BATCH_SIZE}`)
  }
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM pairing WHERE code_hash IN (
         SELECT code_hash FROM pairing WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
       )`
    ).bind(now, limit),
    env.DB.prepare(
      `DELETE FROM session_ticket WHERE token_hash IN (
         SELECT token_hash FROM session_ticket WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
       )`
    ).bind(now, limit),
    env.DB.prepare(
      `DELETE FROM rate_limit WHERE key IN (
         SELECT key FROM rate_limit WHERE reset_at <= ? ORDER BY reset_at LIMIT ?
       )`
    ).bind(now, limit)
  ])
}

export class CleanupScheduler {
  private nextCleanupAt = 0

  schedule(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>, now = Date.now()): void {
    if (now < this.nextCleanupAt) return
    this.nextCleanupAt = now + CLEANUP_INTERVAL_MS
    ctx.waitUntil(cleanupExpiredRows(env, { now }))
  }
}

const cleanupScheduler = new CleanupScheduler()

export function scheduleExpiredRowCleanup(env: Env, ctx: ExecutionContext): void {
  cleanupScheduler.schedule(env, ctx)
}
