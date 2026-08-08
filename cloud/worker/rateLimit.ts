import type { Env } from './types'
import { HttpError } from './validation'

export async function enforceRateLimit(
  env: Env,
  key: string,
  options: { limit: number; windowMs: number; now?: number }
): Promise<void> {
  const { limit, windowMs, now = Date.now() } = options
  const resetAt = now + windowMs
  const row = await env.DB.prepare(
    `INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
     RETURNING count, reset_at`
  )
    .bind(key, resetAt, now, now, resetAt)
    .first<{ count: number; reset_at: number }>()
  if (row !== null && row.count > limit) {
    throw new HttpError(429, 'rate_limited', `Too many attempts; retry after ${Math.max(1, row.reset_at - now)} ms`)
  }
}
