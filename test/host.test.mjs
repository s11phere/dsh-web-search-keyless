/**
 * Host-plugin tests: registration through a stub context, the degraded-response guard,
 * pacing/cooldown behaviour, and the fallback/error paths. The offline cases stub
 * `globalThis.fetch`, so they assert on the provider's decisions rather than the network.
 * The live section (env-gated) proves the registered provider really answers a query.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, apply, inject, name } from '../lib/host.js'

/** Run `apply` against a stub ctx and return the registered provider. */
function capture(config) {
  let provider
  const ctx = {
    web: {
      registerSearchProvider(candidate) {
        provider = candidate
        return () => {}
      },
    },
  }
  apply(ctx, config)
  return provider
}

/** Run `body` with `globalThis.fetch` replaced, restoring it afterwards. */
async function withFetch(t, impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => {
    globalThis.fetch = original
  })
}

/** A one-item Bing RSS document. */
function rss(title, link, description = '') {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing</title><item><title>${title}</title><link>${link}</link><description>${description}</description></item></channel></rss>`
}

test('declares the web injection and a stable plugin name', () => {
  assert.equal(name, 'web-search-keyless')
  assert.deepEqual(inject, ['web'])
})

test('registers a provider under the configured id', () => {
  const provider = capture({})
  assert.equal(provider.id, DEFAULTS.id)
  assert.equal(provider.available(), true)
  assert.equal(capture({ id: 'custom-keyless' }).id, 'custom-keyless')
})

test('available() is false with no engines configured', () => {
  assert.equal(capture({ engines: [] }).available(), false)
})

test('rejects an empty query with a routable WebError code', async () => {
  const provider = capture({})
  await assert.rejects(provider.search({ query: '   ' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
})

test('an unknown engine is reported without aborting the configured order', async () => {
  const provider = capture({ engines: ['nope'] })
  await assert.rejects(
    provider.search({ query: 'anything' }),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && /nope: unknown engine/.test(error.message),
  )
})

test('keeps a relevant result set', async (t) => {
  await withFetch(t, async () =>
    new Response(rss('pymupdf &middot; PyPI', 'https://pypi.org/project/pymupdf/', 'PyMuPDF is a Python PDF library.'), {
      status: 200,
    }),
  )
  const provider = capture({ engines: ['bing'], minIntervalMs: 0 })
  const result = await provider.search({ query: 'PyMuPDF latest version', maxResults: 5 })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://pypi.org/project/pymupdf/')
  assert.equal(result.truncated, false)
})

test('a silently degraded engine response fails loudly instead of forwarding garbage', async (t) => {
  // Exactly the observed Bing degradation: HTTP 200, a well-formed feed, unrelated items.
  await withFetch(t, async () =>
    new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing: FigureSeer parsing result-figures research papers ECCV 2016 caption legend</title>
       <item><title>The Best Online Music Streaming Services for 2026 - PCMag</title><link>https://www.pcmag.com/picks/best-music-streaming</link><description>Our experts tested the top music services.</description></item>
       <item><title>ProHeat Essential Upright Carpet Cleaner</title><link>https://support.bissell.com/app/products/detail/p/67399</link><description>Product support.</description></item>
       </channel></rss>`,
      { status: 200 },
    ),
  )
  const provider = capture({ engines: ['bing'], minIntervalMs: 0 })
  await assert.rejects(
    provider.search({ query: 'FigureSeer parsing result-figures research papers ECCV 2016 caption legend' }),
    (error) =>
      error.code === 'WEB_PROVIDER_ERROR' && /2 result\(s\) but none matched the query/.test(error.message),
  )
})

test('a degraded primary falls through to the next engine', async (t) => {
  let call = 0
  await withFetch(t, async () => {
    call += 1
    // bing → unrelated junk; ddg → a relevant hit for the same query.
    return call === 1
      ? new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing</title><item><title>Best Music Streaming</title><link>https://www.pcmag.com/picks/best-music-streaming</link><description>music</description></item></channel></rss>`,
          { status: 200 },
        )
      : new Response(
          `<html><body><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdl.acm.org%2Fdoi%2F10.1145%2F2910896.2910904" class='result-link'>PDFFigures 2.0 | Proceedings of the ACM</a><td class='result-snippet'>Mining figures from research papers.</td></body></html>`,
          { status: 200 },
        )
  })
  const provider = capture({ engines: ['bing', 'ddg'], minIntervalMs: 0 })
  const result = await provider.search({ query: 'PDFFigures 2.0 mining figures' })
  assert.equal(result.sources.length, 1)
  assert.match(result.sources[0].url, /dl\.acm\.org/)
})

test('a 403 puts the engine on cooldown so later queries fail fast', async (t) => {
  let calls = 0
  await withFetch(t, async () => {
    calls += 1
    return new Response('', { status: 403 })
  })
  const provider = capture({ engines: ['bing'], minIntervalMs: 0, cooldownMs: 60_000 })
  await assert.rejects(provider.search({ query: 'some long tail query' }), /HTTP 403/)
  await assert.rejects(provider.search({ query: 'another long tail query' }), /cooldown/)
  assert.equal(calls, 1, 'the second search must not touch the network while cooling down')
})

test('requests to one engine are paced, not bursted', async (t) => {
  await withFetch(t, async () =>
    new Response(rss('pymupdf · PyPI', 'https://pypi.org/project/pymupdf/', 'PyMuPDF docs'), { status: 200 }),
  )
  const provider = capture({ engines: ['bing'], minIntervalMs: 150 })
  const started = Date.now()
  await Promise.all([
    provider.search({ query: 'PyMuPDF latest version' }),
    provider.search({ query: 'PyMuPDF documentation' }),
  ])
  assert.ok(Date.now() - started >= 150, 'two back-to-back searches must be spaced by minIntervalMs')
})

/**
 * Run `apply` against a stub ctx whose seam registry already holds `fallback`.
 *
 * The real seam exposes its registry as a plain `Map` at runtime (private in the types),
 * which is exactly what the provider reads for its paid fallback.
 */
function captureWithRegistry(config, fallback) {
  let provider
  const registry = new Map()
  if (fallback !== undefined) registry.set(fallback.id, fallback)
  const ctx = {
    web: {
      searchProviders: registry,
      registerSearchProvider(candidate) {
        provider = candidate
        return () => {}
      },
    },
  }
  apply(ctx, config)
  return provider
}

/** A stand-in for the registered `deepseek-official` provider. */
function fakeFallback(outcome) {
  const queries = []
  return {
    id: 'deepseek-official',
    queries,
    available: () => true,
    async search(request) {
      queries.push(request.query)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

/** A Bing response that carries valid XML but unrelated content. */
function junkRss() {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Bing: tampered</title><item><title>Free Porn Videos</title><link>https://example.com/junk</link><description>unrelated</description></item></channel></rss>`
}

test('falls back to the paid provider after every keyless engine fails', async (t) => {
  await withFetch(t, async () => new Response(junkRss(), { status: 200 }))
  const fallback = fakeFallback({ sources: [{ url: 'https://dl.acm.org/doi/10.1145/2910896.2910904' }], truncated: false })
  const provider = captureWithRegistry({ engines: ['bing', 'ddg'], minIntervalMs: 0 }, fallback)
  const result = await provider.search({ query: 'FigureSeer parsing result-figures research papers' })
  assert.equal(result.sources.length, 1)
  assert.match(result.sources[0].url, /dl\.acm\.org/)
  assert.deepEqual(fallback.queries, ['FigureSeer parsing result-figures research papers'])
})

test('does not consult the paid fallback when a keyless engine succeeds', async (t) => {
  await withFetch(t, async () =>
    new Response(rss('pymupdf · PyPI', 'https://pypi.org/project/pymupdf/', 'PyMuPDF docs'), { status: 200 }),
  )
  const fallback = fakeFallback({ sources: [{ url: 'https://paid.example/' }], truncated: false })
  const provider = captureWithRegistry({ engines: ['bing'], minIntervalMs: 0 }, fallback)
  await provider.search({ query: 'PyMuPDF latest version' })
  assert.deepEqual(fallback.queries, [], 'the paid provider must stay untouched when the free path works')
})

test('passes a fallback result through unfiltered', async (t) => {
  await withFetch(t, async () => new Response(junkRss(), { status: 200 }))
  // Deliberately shares no term with the query, mirroring DeepSeek's snippet-less results.
  const fallback = fakeFallback({ sources: [{ url: 'https://dl.acm.org/doi/x', title: 'Proceedings' }], truncated: false })
  const provider = captureWithRegistry({ engines: ['bing'], minIntervalMs: 0 }, fallback)
  const result = await provider.search({ query: 'FigureSeer parsing result-figures' })
  assert.equal(result.sources.length, 1)
})

test('reports both the keyless and the fallback failure', async (t) => {
  await withFetch(t, async () => new Response(junkRss(), { status: 200 }))
  const fallback = fakeFallback(new Error('WEB_PROVIDER_CREDENTIAL_MISSING'))
  const provider = captureWithRegistry({ engines: ['bing'], minIntervalMs: 0 }, fallback)
  await assert.rejects(
    provider.search({ query: 'FigureSeer parsing result-figures' }),
    (error) =>
      /anti-bot degradation/.test(error.message) && /fallback deepseek-official: WEB_PROVIDER_CREDENTIAL_MISSING/.test(error.message),
  )
})

test('never falls back to itself, and tolerates an empty registry', async (t) => {
  await withFetch(t, async () => new Response(junkRss(), { status: 200 }))
  const self = captureWithRegistry({ engines: ['bing'], minIntervalMs: 0, fallbackProvider: 'keyless' })
  await assert.rejects(self.search({ query: 'FigureSeer parsing result-figures' }), (error) =>
    /anti-bot degradation/.test(error.message) && !/fallback/.test(error.message),
  )
  const noRegistry = capture({ engines: ['bing'], minIntervalMs: 0 })
  await assert.rejects(noRegistry.search({ query: 'FigureSeer parsing result-figures' }), /anti-bot degradation/)
})

test('an empty fallbackProvider disables the fallback', async (t) => {
  await withFetch(t, async () => new Response(junkRss(), { status: 200 }))
  const fallback = fakeFallback({ sources: [{ url: 'https://paid.example/' }], truncated: false })
  const provider = captureWithRegistry({ engines: ['bing'], minIntervalMs: 0, fallbackProvider: '' }, fallback)
  await assert.rejects(provider.search({ query: 'FigureSeer parsing result-figures' }), /anti-bot degradation/)
  assert.deepEqual(fallback.queries, [])
})

test('live: the registered provider returns sources', { skip: process.env.DSH_KEYLESS_LIVE !== '1' }, async () => {
  const provider = capture({ engines: ['bing'] })
  const result = await provider.search({ query: 'PyMuPDF latest version', maxResults: 5 })
  assert.equal(result.truncated, false)
  assert.ok(result.sources.length > 0)
  assert.ok(result.sources.length <= 5)
  assert.match(result.sources[0].url, /^https?:\/\//)
})
