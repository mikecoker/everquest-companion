import type { Env } from './types'

export async function eraseAccount(accountId: string, env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairing WHERE discord_user_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM session_ticket WHERE discord_user_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM device WHERE discord_user_id = ?').bind(accountId),
    env.DB.prepare('DELETE FROM rate_limit WHERE key = ?').bind(`pairing-account:${accountId}`),
    env.DB.prepare('DELETE FROM account WHERE discord_user_id = ?').bind(accountId)
  ])
  const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(accountId))
  await room.eraseAccount()
}
