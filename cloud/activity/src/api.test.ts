import { createActivityApi, viewerSocketUrl } from './api'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('Activity API', () => {
  it('uses relative credentialed endpoints and verifies pairing', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ accessToken: 'short-sdk-token', account: { id: '1', username: 'user', displayName: 'User' } }))
      .mockResolvedValueOnce(json({ account: { id: '1', username: 'user', displayName: 'User' }, devices: [], paired: false }))
      .mockResolvedValueOnce(json({ code: 'Q7KP2M', expiresAt: 5_000 }))
    const api = createActivityApi(fetcher)
    expect(await api.exchangeOAuthCode('oauth-code')).toBe('short-sdk-token')
    expect(await api.loadMe()).toMatchObject({ user: { displayName: 'User' }, paired: false })
    expect(await api.createPairing()).toEqual({ code: 'Q7KP2M', expiresAt: 5_000 })
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/oauth/token', expect.objectContaining({ credentials: 'include', method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/pairing', expect.objectContaining({ credentials: 'include', method: 'POST' }))
  })

  it('rejects malformed responses and HTTP errors', async () => {
    await expect(createActivityApi(vi.fn().mockResolvedValue(json({ accessToken: '', account: { id: '1', username: 'u', displayName: 'U' } }))).exchangeOAuthCode('x')).rejects.toThrow('missing')
    await expect(createActivityApi(vi.fn().mockResolvedValue(json({ error: { message: 'No' } }, 401))).loadMe()).rejects.toThrow('401')
  })

  it('puts only the short-lived ticket in the WebSocket URL', () => {
    const url = viewerSocketUrl('viewer-only', new URL('https://activity.example/app'))
    expect(url).toBe('wss://activity.example/api/sync?ticket=viewer-only')
    expect(url).not.toMatch(/access|token|device|secret/i)
  })
})
