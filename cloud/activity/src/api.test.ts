import { createActivityApi, viewerSocketUrl } from './api'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('Activity API', () => {
  it('uses relative credentialed endpoints and verifies pairing', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ accessToken: 'short-sdk-token', account: { id: '1', username: 'user', displayName: 'User' } }))
      .mockResolvedValueOnce(json({
        account: { id: '1', username: 'user', displayName: 'User' },
        devices: [{ id: 'device-1', label: 'Gaming PC', createdAt: 10 }],
        paired: true,
        room: null
      }))
      .mockResolvedValueOnce(json({ code: 'Q7KP2M', expiresAt: 5_000 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = createActivityApi(fetcher)
    expect(await api.exchangeOAuthCode('oauth-code')).toBe('short-sdk-token')
    expect(await api.loadMe()).toMatchObject({
      user: { displayName: 'User' }, paired: true,
      devices: [{ id: 'device-1', label: 'Gaming PC', createdAt: 10 }], room: null
    })
    expect(await api.createPairing()).toEqual({ code: 'Q7KP2M', expiresAt: 5_000 })
    await api.revokeDevice('device-1')
    await api.deleteAccount()
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/oauth/token', expect.objectContaining({ credentials: 'include', method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/pairing', expect.objectContaining({ credentials: 'include', method: 'POST' }))
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/devices/device-1', expect.objectContaining({ credentials: 'include', method: 'DELETE' }))
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/me', expect.objectContaining({ credentials: 'include', method: 'DELETE' }))
  })

  it('rejects malformed responses and HTTP errors', async () => {
    await expect(createActivityApi(vi.fn().mockResolvedValue(json({ accessToken: '', account: { id: '1', username: 'u', displayName: 'U' } }))).exchangeOAuthCode('x')).rejects.toThrow('missing')
    await expect(createActivityApi(vi.fn().mockResolvedValue(json({ error: { message: 'No' } }, 401))).loadMe()).rejects.toThrow('No')
  })

  it('puts only the short-lived ticket in the WebSocket URL', () => {
    const url = viewerSocketUrl('viewer-only', new URL('https://activity.example/app'))
    expect(url).toBe('wss://activity.example/api/sync?ticket=viewer-only')
    expect(url).not.toMatch(/access|token|device|secret/i)
  })

  it('parses shared-room control-plane responses', async () => {
    const room = { id: 'room-1', name: 'Friday raid', owner: true, joinedAt: 10 }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ room, code: 'ABCD-EFGH-JKLM' }))
      .mockResolvedValueOnce(json({ room: { ...room, owner: false } }))
      .mockResolvedValueOnce(json({ code: 'WXYZ-2345-6789' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const api = createActivityApi(fetcher)
    expect(await api.createRoom('Friday raid')).toEqual({ room, code: 'ABCD-EFGH-JKLM' })
    expect(await api.joinRoom('ABCD-EFGH-JKLM')).toEqual({ ...room, owner: false })
    expect(await api.rotateRoomCode('room-1')).toBe('WXYZ-2345-6789')
    await api.closeRoom('room-1')
  })
})
