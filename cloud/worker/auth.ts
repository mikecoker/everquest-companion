import { signValue, verifySignedValue } from './crypto'
import type { CloudAccount, Env } from './types'
import { HttpError, readJsonObject, requiredString } from './validation'

const COOKIE_NAME = 'eq_activity_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
}

function discordOrigin(env: Env): string {
  return (env.DISCORD_API_ORIGIN ?? 'https://discord.com/api/v10').replace(/\/$/u, '')
}

function accountFromDiscord(user: DiscordUser): CloudAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name ?? user.username,
    ...(user.avatar == null
      ? {}
      : { avatarUrl: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` })
  }
}

async function exchangeCode(code: string, env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code
  })
  const response = await fetch(`${discordOrigin(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) throw new HttpError(401, 'oauth_failed', 'Discord authorization failed')
  const result = (await response.json()) as { access_token?: unknown }
  if (typeof result.access_token !== 'string' || result.access_token.length === 0) {
    throw new HttpError(502, 'oauth_failed', 'Discord returned an invalid token response')
  }
  return result.access_token
}

async function fetchDiscordUser(accessToken: string, env: Env): Promise<CloudAccount> {
  const response = await fetch(`${discordOrigin(env)}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) throw new HttpError(401, 'oauth_failed', 'Discord identity verification failed')
  const user = (await response.json()) as Partial<DiscordUser>
  if (typeof user.id !== 'string' || typeof user.username !== 'string') {
    throw new HttpError(502, 'oauth_failed', 'Discord returned an invalid user response')
  }
  return accountFromDiscord(user as DiscordUser)
}

function cookieDomain(env: Env): string {
  const domain = env.ACTIVITY_COOKIE_DOMAIN
  if (domain === undefined || domain.length === 0) return ''
  if (!/^[a-z0-9.-]+$/iu.test(domain)) throw new HttpError(500, 'configuration_error', 'Cookie domain is invalid')
  return `; Domain=${domain}`
}

async function sessionCookie(accountId: string, env: Env, now: number): Promise<string> {
  const expiresAt = now + SESSION_TTL_MS
  const payload = btoa(JSON.stringify({ sub: accountId, exp: expiresAt }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  const value = await signValue(payload, env.COOKIE_SIGNING_KEY)
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Secure; HttpOnly; SameSite=None; Partitioned${cookieDomain(env)}`
}

export async function oauthToken(request: Request, env: Env): Promise<Response> {
  const source = await readJsonObject(request)
  const code = requiredString(source, 'code', 512)
  const accessToken = await exchangeCode(code, env)
  const account = await fetchDiscordUser(accessToken, env)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO account (discord_user_id, username, display_name, avatar_url, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(discord_user_id) DO UPDATE SET username=excluded.username,
       display_name=excluded.display_name, avatar_url=excluded.avatar_url, last_seen_at=excluded.last_seen_at`
  )
    .bind(account.id, account.username, account.displayName, account.avatarUrl ?? null, now, now)
    .run()
  return new Response(JSON.stringify({ accessToken, account }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': await sessionCookie(account.id, env, now)
    }
  })
}

function cookieValue(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) return rest.join('=')
  }
  return null
}

export async function requireSession(request: Request, env: Env): Promise<string> {
  const cookie = cookieValue(request)
  if (cookie === null) throw new HttpError(401, 'unauthorized', 'Authentication is required')
  const value = await verifySignedValue(cookie, env.COOKIE_SIGNING_KEY)
  if (value === null) throw new HttpError(401, 'unauthorized', 'Session is invalid')
  try {
    const payload = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: unknown; exp?: unknown }
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      throw new Error('expired')
    }
    return payload.sub
  } catch {
    throw new HttpError(401, 'unauthorized', 'Session is invalid or expired')
  }
}

export async function loadAccount(accountId: string, env: Env): Promise<CloudAccount> {
  const row = await env.DB.prepare(
    'SELECT discord_user_id, username, display_name, avatar_url FROM account WHERE discord_user_id = ?'
  )
    .bind(accountId)
    .first<{ discord_user_id: string; username: string; display_name: string; avatar_url: string | null }>()
  if (row === null) throw new HttpError(401, 'unauthorized', 'Account no longer exists')
  return {
    id: row.discord_user_id,
    username: row.username,
    displayName: row.display_name,
    ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url })
  }
}
