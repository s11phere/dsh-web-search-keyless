/**
 * backends.js — keyless search engines and their pure parsers.
 *
 * Two engines, no credentials, no model turn:
 *   - Bing RSS   (`format=rss`) returns a small, well-formed RSS document.
 *   - DuckDuckGo Lite (table HTML) is the fallback; its hrefs are redirect-wrapped
 *     through `//duckduckgo.com/l/?uddg=<encoded>`, so `unwrapDdgHref` resolves them.
 *
 * The parsers are pure (`parseBingRss` / `parseDdgLite`) so they can be tested without
 * network access; `runBing` / `runDdg` are the thin fetch wrappers.
 *
 * @module dsh-web-search-keyless/backends
 */

/** Desktop UA: Bing and DDG both answer a bare `node` UA with an empty result set. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Named HTML entities worth decoding in titles/snippets; numeric forms are handled generally. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  middot: '·',
}

/** Decode numeric and the common named HTML entities. Unknown entities pass through. */
export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#[Xx]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/** Drop tags, decode entities, collapse whitespace. */
export function normalizeText(input) {
  return decodeEntities(String(input ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Read the first `<tag>…</tag>` body from a fragment, unwrapping CDATA. */
function firstTag(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  if (match === null) return ''
  return match[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
}

/** Normalize a date-ish string to ISO-8601, or `undefined` when it is not parseable. */
function toIso(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return undefined
  // DDG emits 7 fractional digits (`…T00:00:00.0000000`), which Date.parse rejects.
  let candidate = raw.replace(/(\.\d{3})\d+/, '$1')
  // DDG's timestamp carries no zone; reading it as local time would make the output
  // depend on the host's TZ, so pin it to UTC instead of leaving it ambiguous.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(candidate)) candidate = `${candidate}Z`
  const parsed = Date.parse(candidate)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString()
}

/**
 * Build one source, omitting absent optional fields rather than inventing empty ones.
 *
 * @param {{url: string, title?: string, snippet?: string, publishedAt?: string}} fields
 * @returns {{url: string, title?: string, snippet?: string, publishedAt?: string}}
 */
function source(fields) {
  const out = { url: fields.url }
  if (fields.title) out.title = fields.title
  if (fields.snippet) out.snippet = fields.snippet
  if (fields.publishedAt) out.publishedAt = fields.publishedAt
  return out
}

//#region Bing RSS

/** Bing's RSS surface: the same index as the HTML page, in a parseable document. */
export const BING_ENDPOINT = 'https://www.bing.com/search'

/**
 * @param {string} query
 * @param {number} [maxResults] passed as `count` so the payload stays small
 * @returns {string} the request URL
 */
export function bingUrl(query, maxResults) {
  const url = new URL(BING_ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'rss')
  if (Number.isInteger(maxResults) && maxResults > 0) {
    url.searchParams.set('count', String(Math.min(maxResults, 50)))
  }
  return url.toString()
}

/**
 * Parse a Bing RSS document into portable sources.
 *
 * @param {string} xml the RSS body
 * @param {number} [maxResults] stop after this many accepted sources
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
export function parseBingRss(xml, maxResults) {
  const sources = []
  const seen = new Set()
  for (const match of String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const url = normalizeText(firstTag(block, 'link'))
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    sources.push(
      source({
        url,
        title: normalizeText(firstTag(block, 'title')),
        snippet: normalizeText(firstTag(block, 'description')),
        publishedAt: toIso(normalizeText(firstTag(block, 'pubDate'))),
      }),
    )
    if (Number.isInteger(maxResults) && maxResults > 0 && sources.length >= maxResults) break
  }
  return sources
}

//#endregion

//#region DuckDuckGo Lite

/** The table-only DDG front end: tiny HTML, no JavaScript, stable class names. */
export const DDG_ENDPOINT = 'https://lite.duckduckgo.com/lite/'

/**
 * @param {string} query
 * @returns {string} the request URL
 */
export function ddgUrl(query) {
  const url = new URL(DDG_ENDPOINT)
  url.searchParams.set('q', query)
  return url.toString()
}

/**
 * Resolve a DDG Lite href to its real destination.
 *
 * @param {string} href the raw attribute value (`//duckduckgo.com/l/?uddg=…` or a direct URL)
 * @returns {string} the absolute target URL, or `''` when it cannot be resolved
 */
export function unwrapDdgHref(href) {
  let candidate = decodeEntities(String(href ?? '')).trim()
  if (candidate === '') return ''
  if (candidate.startsWith('//')) candidate = `https:${candidate}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return ''
  }
  if (!/(^|\.)duckduckgo\.com$/i.test(parsed.hostname)) return parsed.toString()
  if (!parsed.pathname.startsWith('/l/')) return ''
  const target = parsed.searchParams.get('uddg')
  if (target === null || target === '') return ''
  try {
    return new URL(target).toString()
  } catch {
    return ''
  }
}

/**
 * Parse a DDG Lite result page into portable sources.
 *
 * Each result is one `<a class='result-link'>` followed by sibling rows carrying the
 * snippet and the crawl timestamp; the window between two links bounds the lookup so a
 * missing snippet cannot borrow the next result's.
 *
 * @param {string} html the page body
 * @param {number} [maxResults] stop after this many accepted sources
 * @returns {Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>}
 */
export function parseDdgLite(html, maxResults) {
  const text = String(html ?? '')
  const matches = [...text.matchAll(/<a\b[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/gi)]
  const sources = []
  const seen = new Set()
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const tag = match[0].match(/^<a\b[^>]*>/i)?.[0] ?? ''
    const href = tag.match(/\bhref\s*=\s*(['"])([\s\S]*?)\1/i)?.[2] ?? ''
    const url = unwrapDdgHref(href)
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const end = match.index + match[0].length
    const next = index + 1 < matches.length ? matches[index + 1].index : end + 3000
    const window = text.slice(end, Math.max(next, end))
    const title = normalizeText(match[0].replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, ''))
    const snippet = normalizeText(
      window.match(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '',
    )
    const stamp = window.match(/<span\b[^>]*class=['"]timestamp['"][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''
    sources.push(source({ url, title, snippet, publishedAt: toIso(normalizeText(stamp)) }))
    if (Number.isInteger(maxResults) && maxResults > 0 && sources.length >= maxResults) break
  }
  return sources
}

//#endregion

//#region transport

/**
 * Fetch a text resource with a timeout and the caller's cancellation signal.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, userAgent?: string, signal?: AbortSignal, accept?: string}} [options]
 * @returns {Promise<{status: number, ok: boolean, body: string, url: string}>}
 */
export async function fetchText(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  const signals = options.signal === undefined ? [timer.signal] : [options.signal, timer.signal]
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
      },
      signal: AbortSignal.any(signals),
    })
    const body = await response.text()
    return { status: response.status, ok: response.ok, body, url: response.url }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * @param {string} query
 * @param {{maxResults?: number, timeoutMs?: number, userAgent?: string, signal?: AbortSignal}} options
 */
export async function runBing(query, options = {}) {
  const response = await fetchText(bingUrl(query, options.maxResults), {
    ...options,
    accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseBingRss(response.body, options.maxResults)
}

/**
 * @param {string} query
 * @param {{maxResults?: number, timeoutMs?: number, userAgent?: string, signal?: AbortSignal}} options
 */
export async function runDdg(query, options = {}) {
  const response = await fetchText(ddgUrl(query), options)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseDdgLite(response.body, options.maxResults)
}

/** Engine registry, in fallback order as configured. */
export const ENGINES = {
  bing: { id: 'bing', label: 'Bing RSS', run: runBing },
  ddg: { id: 'ddg', label: 'DuckDuckGo Lite', run: runDdg },
}

//#endregion
