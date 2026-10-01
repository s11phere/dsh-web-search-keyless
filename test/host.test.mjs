/**
 * Host-plugin tests: registration through a stub context, plus the fallback/error paths.
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

test('live: the registered provider returns sources', { skip: process.env.DSH_KEYLESS_LIVE !== '1' }, async () => {
  const provider = capture({})
  const result = await provider.search({ query: 'PyMuPDF latest version', maxResults: 5 })
  assert.equal(result.truncated, false)
  assert.ok(result.sources.length > 0)
  assert.ok(result.sources.length <= 5)
  assert.match(result.sources[0].url, /^https?:\/\//)

  const viaDdg = capture({ engines: ['ddg'] })
  assert.ok((await viaDdg.search({ query: 'PyMuPDF latest version', maxResults: 3 })).sources.length > 0)
})
