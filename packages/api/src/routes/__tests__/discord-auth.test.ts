/**
 * [COMP:api/discord-route] — connector-secret guard on /internal/discord.
 *
 * The router fronts GET /channels, which returns every active Discord
 * bot token (the connector's restoreAll source) — so the guard must be
 * constant-time and fail closed: an empty configured secret matches
 * nothing, rather than comparing `undefined !== undefined` and waving
 * an unauthenticated caller through to the token list.
 */

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { discordRoutes } from '../discord.js'

function buildApp(connectorSecret: string) {
  const integrationStore = {
    listActiveWithCredentialsSystem: vi.fn(async () => [
      {
        channelId: 'chan-1',
        botUserId: 'bot-1',
        credentials: { bot_token: 'discord-bot-token-1' },
      },
    ]),
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/internal/discord',
    discordRoutes({
      connectorSecret,
      integrationStore,
      provider: {},
      systemPrompt: '',
      tools: new Map(),
      memoryStore: {},
      capabilityStore: {},
    } as never),
  )
  return { app, integrationStore }
}

describe('[COMP:api/discord-route] connector-secret guard', () => {
  it('401s /channels without the secret header — no token rows leave', async () => {
    const { app, integrationStore } = buildApp('s3cret')
    const res = await request(app).get('/internal/discord/channels')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('401s a wrong secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/discord/channels')
      .set('x-connector-secret', 'wrong')
    expect(res.status).toBe(401)
  })

  it('fails closed when the configured secret is empty — even an empty header loses', async () => {
    const { app, integrationStore } = buildApp('')
    const res = await request(app)
      .get('/internal/discord/channels')
      .set('x-connector-secret', '')
    expect(res.status).toBe(401)
    expect(integrationStore.listActiveWithCredentialsSystem).not.toHaveBeenCalled()
  })

  it('serves the token list to the correct secret', async () => {
    const { app } = buildApp('s3cret')
    const res = await request(app)
      .get('/internal/discord/channels')
      .set('x-connector-secret', 's3cret')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      { channelId: 'chan-1', botToken: 'discord-bot-token-1', botUserId: 'bot-1' },
    ])
  })
})
