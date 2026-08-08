const sdk = vi.hoisted(() => ({
  ready: vi.fn().mockResolvedValue(undefined),
  commands: {
    authorize: vi.fn().mockResolvedValue({ code: 'authorization-code' }),
    authenticate: vi.fn().mockResolvedValue({})
  }
}))

vi.mock('@discord/embedded-app-sdk', () => ({ DiscordSDK: class { constructor() { return sdk } } }))

import { createDiscordAdapter } from './discord'

describe('Discord SDK adapter', () => {
  it('requests only identify with non-interactive authorization', async () => {
    const adapter = createDiscordAdapter('public-client-id')
    await adapter.ready()
    expect(await adapter.authorize('public-client-id')).toBe('authorization-code')
    await adapter.authenticate('short-access-token')
    expect(sdk.commands.authorize).toHaveBeenCalledWith({
      client_id: 'public-client-id', response_type: 'code', scope: ['identify'], prompt: 'none'
    })
    expect(sdk.commands.authenticate).toHaveBeenCalledWith({ access_token: 'short-access-token' })
  })
})
