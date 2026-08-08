import type { Env } from './types'
import { activeRoom, closeRoom, leaveRoom } from './rooms'

export async function eraseAccount(accountId: string, env: Env): Promise<void> {
  const membership = await activeRoom(accountId, env)
  if (membership?.owner === true) await closeRoom(accountId, membership.id, env)
  else if (membership !== null) await leaveRoom(accountId, membership.id, env)
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
