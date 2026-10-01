/**
 * Parser and fallback tests.
 *
 * The parser tests are offline and use fixtures shaped exactly like the live pages
 * (Bing RSS items, DDG Lite result tables). Set `DSH_KEYLESS_LIVE=1` to additionally
 * exercise the real endpoints — that part fails loudly if the network is unavailable.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bingUrl,
  ddgUrl,
  decodeEntities,
  normalizeText,
  parseBingRss,
  parseDdgLite,
  runBing,
  runDdg,
  unwrapDdgHref,
} from '../lib/backends.js'

const BING_FIXTURE = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel><title>Bing: pymupdf</title>
<item><title>pymupdf &middot; PyPI</title><link>https://pypi.org/project/pymupdf/</link><description>PyMuPDF is a high-performance Python library &amp; PDF engine.</description><pubDate>Wed, 30 Sep 2026 03:30:00 GMT</pubDate></item>
<item><title><![CDATA[Releases · pymupdf/PyMuPDF]]></title><link>https://github.com/pymupdf/PyMuPDF/releases</link><description>Release notes for <b>PyMuPDF</b>.</description></item>
<item><title>no link</title><description>dropped</description></item>
<item><title>duplicate</title><link>https://pypi.org/project/pymupdf/</link><description>dup</description></item>
<item><title>Downloads</title><link>https://pymupdf.readthedocs.io/en/latest/about.html</link><description>Docs.</description><pubDate>not a date</pubDate></item>
</channel></rss>`

const DDG_FIXTURE = `<html><body><table>
<tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpypi.org%2Fproject%2Fpymupdf%2F&amp;rut=abc" class='result-link'>pymupdf &middot; PyPI</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'><b>PyMuPDF</b> is a high-performance Python library.</td></tr>
<tr><td>&nbsp;</td><td><span class='link-text'>pypi.org/project/pymupdf/</span> <span class='timestamp'>2026-08-06T00:00:00.0000000</span></td></tr>
<tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://github.com/pymupdf/PyMuPDF" class='result-link'>GitHub - pymupdf/PyMuPDF</a></td></tr>
<tr><td>&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fno-uddg-check" class='result-link'>Third</a></td></tr>
</table></body></html>`

test('normalizeText decodes entities and strips markup', () => {
  assert.equal(decodeEntities('a &amp; b &#65; &#x42; &unknown;'), 'a & b A B &unknown;')
  assert.equal(normalizeText('<b>PyMuPDF</b> is &amp; fast\n  now'), 'PyMuPDF is & fast now')
})

test('parseBingRss keeps valid items and drops malformed ones', () => {
  const sources = parseBingRss(BING_FIXTURE)
  assert.deepEqual(
    sources.map((s) => s.url),
    [
      'https://pypi.org/project/pymupdf/',
      'https://github.com/pymupdf/PyMuPDF/releases',
      'https://pymupdf.readthedocs.io/en/latest/about.html',
    ],
  )
  assert.equal(sources[0].title, 'pymupdf · PyPI')
  assert.equal(sources[0].snippet, 'PyMuPDF is a high-performance Python library & PDF engine.')
  assert.equal(sources[0].publishedAt, '2026-09-30T03:30:00.000Z')
  assert.equal(sources[1].title, 'Releases · pymupdf/PyMuPDF')
  // an unparseable pubDate is omitted rather than invented
  assert.equal(sources[2].publishedAt, undefined)
  assert.equal(Object.hasOwn(sources[2], 'publishedAt'), false)
})

test('parseBingRss honors maxResults', () => {
  assert.equal(parseBingRss(BING_FIXTURE, 2).length, 2)
})

test('unwrapDdgHref resolves wrapped and direct hrefs', () => {
  assert.equal(
    unwrapDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fpypi.org%2Fproject%2Fpymupdf%2F&rut=abc'),
    'https://pypi.org/project/pymupdf/',
  )
  assert.equal(unwrapDdgHref('https://github.com/pymupdf/PyMuPDF'), 'https://github.com/pymupdf/PyMuPDF')
  assert.equal(unwrapDdgHref('//duckduckgo.com/l/?rut=abc'), '')
  assert.equal(unwrapDdgHref('not a url'), '')
})

test('parseDdgLite pairs each link with its own snippet', () => {
  const sources = parseDdgLite(DDG_FIXTURE)
  assert.deepEqual(
    sources.map((s) => s.url),
    ['https://pypi.org/project/pymupdf/', 'https://github.com/pymupdf/PyMuPDF', 'https://example.com/no-uddg-check'],
  )
  assert.equal(sources[0].title, 'pymupdf · PyPI')
  assert.equal(sources[0].snippet, 'PyMuPDF is a high-performance Python library.')
  assert.equal(sources[0].publishedAt, '2026-08-06T00:00:00.000Z')
  // the second result has no snippet row; it must not borrow the first result's
  assert.equal(Object.hasOwn(sources[1], 'snippet'), false)
})

test('url builders encode the query', () => {
  assert.match(bingUrl('a b & c', 5), /q=a\+b\+%26\+c/)
  assert.match(bingUrl('a b & c', 5), /format=rss/)
  assert.match(bingUrl('a b & c', 5), /count=5/)
  assert.match(ddgUrl('a b'), /q=a\+b/)
})

test('live: real endpoints answer with sources', { skip: process.env.DSH_KEYLESS_LIVE !== '1' }, async () => {
  const bing = await runBing('PyMuPDF latest version', { maxResults: 5 })
  assert.ok(bing.length > 0, 'Bing RSS returned no sources')
  assert.match(bing[0].url, /^https?:\/\//)
  const ddg = await runDdg('PyMuPDF latest version', { maxResults: 5 })
  assert.ok(ddg.length > 0, 'DDG Lite returned no sources')
  assert.match(ddg[0].url, /^https?:\/\//)
})
