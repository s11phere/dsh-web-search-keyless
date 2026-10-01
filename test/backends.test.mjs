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
  filterRelevant,
  normalizeText,
  parseBingRss,
  parseDdgLite,
  queryTerms,
  runBing,
  runDdg,
  strongTerms,
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

test('queryTerms drops stopwords and keeps CJK bigrams', () => {
  assert.deepEqual(queryTerms('How to use the PyMuPDF latest version'), ['pymupdf', 'latest', 'version'])
  assert.deepEqual(queryTerms('图表标题抽取'), ['图表', '表标', '标题', '题抽', '抽取'])
  assert.deepEqual(queryTerms('图 表 标题 抽取'), ['图', '表', '标题', '抽取'])
  assert.deepEqual(queryTerms('the of and'), [])
  assert.deepEqual(queryTerms('   '), [])
})

test('strongTerms drops domain-generic vocabulary, falling back when nothing is left', () => {
  // "research"/"papers"/"caption" cannot serve as evidence for this query…
  assert.deepEqual(strongTerms('FigureSeer parsing result-figures research papers ECCV 2016 caption legend'), [
    'figureseer',
    'parsing',
    'result-figures',
    'result',
    'eccv',
    '2016',
    'legend',
  ])
  // …but a query made only of generic words still gets judged on them.
  assert.deepEqual(strongTerms('pdf caption extraction'), ['pdf', 'caption', 'extraction'])
})

test('filterRelevant rejects a silently degraded result set', () => {
  // The exact failure observed from Bing RSS for a long-tail paper-title query.
  const junk = [
    { url: 'https://www.pcmag.com/picks/best-music-streaming', title: 'The Best Online Music Streaming Services for 2026', snippet: 'Our experts tested the top services.' },
    { url: 'https://support.bissell.com/app/products/detail/p/67399', title: 'ProHeat Essential Upright Carpet Cleaner', snippet: 'Product support.' },
    { url: 'https://www.yale.edu/', title: 'Yale University', snippet: 'A research university.' },
  ]
  const judged = filterRelevant(junk, 'FigureSeer parsing result-figures research papers ECCV 2016 caption legend')
  assert.equal(judged.sources.length, 0)
  assert.equal(judged.dropped, 3)
})

test('filterRelevant keeps a short legitimate query matched by one distinctive term', () => {
  const good = [
    { url: 'https://pypi.org/project/pymupdf/', title: 'pymupdf · PyPI', snippet: 'PyMuPDF is a high-performance Python library.' },
    { url: 'https://example.com/unrelated', title: 'Cooking with cast iron', snippet: 'A recipe blog.' },
  ]
  const judged = filterRelevant(good, 'PyMuPDF latest version')
  assert.equal(judged.sources.length, 1)
  assert.match(judged.sources[0].url, /pypi\.org/)
  assert.equal(judged.dropped, 1)
})

test('filterRelevant requires two terms when neither is distinctive', () => {
  // "fid" and "score" are short and generic; a page matching only one is not evidence.
  const sources = [
    { url: 'https://example.com/a', title: 'FID explained', snippet: 'A metric.' },
    { url: 'https://example.com/b', title: 'FID score explained', snippet: 'A metric.' },
  ]
  assert.equal(filterRelevant(sources, 'fid score').sources.length, 1)
})

test('filterRelevant is disabled for a query with no judgeable terms', () => {
  const sources = [{ url: 'https://example.com/x', title: 'x' }]
  assert.equal(filterRelevant(sources, 'the of and').sources.length, 1)
})

test('live: real endpoints answer with sources', { skip: process.env.DSH_KEYLESS_LIVE !== '1' }, async () => {
  const bing = await runBing('PyMuPDF latest version', { maxResults: 5 })
  assert.ok(bing.length > 0, 'Bing RSS returned no sources')
  assert.match(bing[0].url, /^https?:\/\//)
  const ddg = await runDdg('PyMuPDF latest version', { maxResults: 5 })
  assert.ok(ddg.length > 0, 'DDG Lite returned no sources')
  assert.match(ddg[0].url, /^https?:\/\//)
})
