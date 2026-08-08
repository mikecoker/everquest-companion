import { DiscordSDK } from '@discord/embedded-app-sdk'

export interface DiscordAdapter {
  ready(): Promise<void>
  authorize(clientId: string): Promise<string>
  authenticate(accessToken: string): Promise<void>
}

class EmbeddedDiscordAdapter implements DiscordAdapter {
  readonly #sdk: DiscordSDK

  constructor(private readonly clientId: string) {
    this.#sdk = new DiscordSDK(clientId)
  }

  async ready(): Promise<void> {
    await this.#sdk.ready()
  }

  async authorize(clientId: string): Promise<string> {
    const result = await this.#sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      scope: ['identify'],
      prompt: 'none'
    })
    return result.code
  }

  async authenticate(accessToken: string): Promise<void> {
    await this.#sdk.commands.authenticate({ access_token: accessToken })
  }
}

export function createDiscordAdapter(clientId: string): DiscordAdapter {
  return new EmbeddedDiscordAdapter(clientId)
}
