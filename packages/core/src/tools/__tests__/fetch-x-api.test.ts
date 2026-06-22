import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { xApiFetchProvider } from '../base/fetch-x-api.js'

const STATUS_URL = 'https://x.com/jack/status/20'
const PROFILE_URL = 'https://x.com/jack'

function mockFetch(json: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => json })
  globalThis.fetch = fn as unknown as typeof globalThis.fetch
  return fn
}

describe('[COMP:tools/fetch] X API fetch provider', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    process.env.TWITTER_BEARER_TOKEN = 'test-bearer'
  })

  afterEach(() => {
    delete process.env.TWITTER_BEARER_TOKEN
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  describe('canHandle', () => {
    it('handles x.com / twitter.com status permalinks when the bearer token is set', () => {
      expect(xApiFetchProvider.canHandle(STATUS_URL)).toBe(true)
      expect(xApiFetchProvider.canHandle('https://twitter.com/jack/status/20')).toBe(true)
    })

    it('declines when the bearer token is missing', () => {
      delete process.env.TWITTER_BEARER_TOKEN
      expect(xApiFetchProvider.canHandle(STATUS_URL)).toBe(false)
    })

    it('declines non-permalink X URLs (profiles/search) so the stack falls through to xAI', () => {
      expect(xApiFetchProvider.canHandle(PROFILE_URL)).toBe(false)
      expect(xApiFetchProvider.canHandle('https://x.com/search?q=foo')).toBe(false)
    })

    it('declines non-X hosts', () => {
      expect(xApiFetchProvider.canHandle('https://example.com/a/status/20')).toBe(false)
    })
  })

  describe('fetch', () => {
    it('renders verbatim text, author, quoted post, media alt-text and metrics', async () => {
      mockFetch({
        data: {
          id: '20',
          text: 'short truncated body…',
          author_id: 'u1',
          created_at: '2006-03-21T20:50:14.000Z',
          note_tweet: { text: 'the full long-form post text' },
          public_metrics: {
            like_count: 5,
            retweet_count: 2,
            reply_count: 1,
            quote_count: 0,
            impression_count: 99,
          },
          referenced_tweets: [{ type: 'quoted', id: '19' }],
          attachments: { media_keys: ['m1'] },
        },
        includes: {
          users: [
            { id: 'u1', username: 'jack', name: 'jack' },
            { id: 'u2', username: 'biz' },
          ],
          tweets: [{ id: '19', text: 'the quoted post', author_id: 'u2' }],
          media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/x.jpg', alt_text: 'a cat' }],
        },
      })

      const result = await xApiFetchProvider.fetch(STATUS_URL)
      expect(result).not.toBeNull()
      expect(result!.source).toBe('x-api')
      expect(result!.title).toBe('X post by @jack')
      // prefers note_tweet over the truncated top-level text
      expect(result!.content).toContain('the full long-form post text')
      expect(result!.content).not.toContain('truncated')
      expect(result!.content).toContain('@jack:')
      expect(result!.content).toContain('Quoting @biz: the quoted post')
      expect(result!.content).toContain('a cat')
      expect(result!.content).toContain('5 likes')
      // reads are flat-rate, no per-call cost
      expect(result!.externalCost).toBeUndefined()
    })

    it('sends the bearer token and tweet id in the request', async () => {
      const fn = mockFetch({
        data: { id: '20', text: 'hi', author_id: 'u1' },
        includes: { users: [{ id: 'u1', username: 'jack' }] },
      })
      await xApiFetchProvider.fetch(STATUS_URL)
      const [calledUrl, init] = fn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
      expect(String(calledUrl)).toContain('/2/tweets/20')
      expect(init.headers.Authorization).toBe('Bearer test-bearer')
    })

    it('throws on a non-2xx response so the stack can fall through to xAI', async () => {
      mockFetch({}, false, 429)
      await expect(xApiFetchProvider.fetch(STATUS_URL)).rejects.toThrow(/429/)
    })

    it('throws when the API returns no post (deleted/protected)', async () => {
      mockFetch({ errors: [{ detail: 'Could not find tweet' }] })
      await expect(xApiFetchProvider.fetch(STATUS_URL)).rejects.toThrow(/no post/)
    })
  })
})
