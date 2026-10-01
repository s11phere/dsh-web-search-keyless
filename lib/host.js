/**
 * host.js — dsh-web-search-keyless 的宿主半部。
 *
 * 一个 **不需要任何密钥、也不消耗任何模型回合** 的 `ctx.web` 搜索 provider：
 * Bing RSS 为主、DuckDuckGo Lite 为备，二者都是普通 HTTP GET，命中失败就顺延。
 *
 * 为什么存在：DSH 自带的 `dsh-web-search-deepseek` 每搜一次就是一次完整的模型回合
 * （DeepSeek 没有独立检索端点），按 token 计费且几乎必然未命中前缀缓存。真实检索
 * 本来不需要模型参与，本插件把这一层替换成纯 HTTP 抓取，成本为零。
 *
 * 装载：profile 的 `cordis.patch.yml` 里把 `web.searchProvider` 指到本 provider 的
 * `id`（默认 `keyless`）；本插件只注册 provider，不改变 `web_search` 工具的接口。
 *
 * @module dsh-web-search-keyless
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT, ENGINES } from './backends.js'

/** 插件名（也是 loader 行 id 的建议值）。 */
export const name = 'web-search-keyless'

/**
 * 需要 `web` 服务就绪后再 apply：本插件的唯一职责就是往服务里注册一个 provider。
 */
export const inject = ['web']

/**
 * 默认配置。
 *
 * @typedef {object} KeylessSearchConfig
 * @property {string} [id] 注册到 web seam 的 provider id，供 `web.searchProvider` 引用。
 * @property {string[]} [engines] 引擎顺序，取 `backends.js` 的 `ENGINES` 键；默认先 Bing 后 DDG。
 * @property {number} [timeoutMs] 单个引擎的超时，默认 15s。
 * @property {string} [userAgent] 请求 UA；Bing/DDG 对空 UA 会返回空结果集。
 * @property {boolean} [debug] 打印每次搜索命中的引擎与条数。
 */
export const DEFAULTS = Object.freeze({
  id: 'keyless',
  engines: ['bing', 'ddg'],
  timeoutMs: 15_000,
  userAgent: DEFAULT_USER_AGENT,
  debug: false,
})

/** 把一个值安全地变成可读的错误文本。 */
function describeError(error) {
  if (error instanceof Error) {
    const reason = error.cause instanceof Error ? ` (${error.cause.message})` : ''
    return `${error.message}${reason}`
  }
  return String(error)
}

/**
 * 无密钥搜索 provider。
 *
 * `search()` 按配置顺序尝试引擎：某个引擎抛出或返回零条就换下一个；全部失败才抛
 * {@link WebError}（`WEB_PROVIDER_ERROR`），错误文本带每个引擎的失败原因，便于定位
 * 是超时、被限流还是页面结构变了。
 */
class KeylessSearchProvider {
  /**
   * @param {Required<KeylessSearchConfig>} options 已合并默认值的配置。
   * @param {(...args: unknown[]) => void} log debug 日志。
   */
  constructor(options, log) {
    this.options = options
    this.log = log
    /** @type {string} */
    this.id = options.id
  }

  /**
   * 本地可用性检查：本 provider 不依赖凭据，因此只要还有引擎就算可用。
   * 按 seam 契约，这里不发网络请求。
   */
  available() {
    return this.options.engines.length > 0
  }

  /**
   * 跑一次搜索。
   *
   * @param {{query: string, maxResults?: number}} request
   * @param {AbortSignal} [signal] 调用方的取消信号。
   * @returns {Promise<{sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated: false}>}
   */
  async search(request, signal) {
    const query = String(request?.query ?? '').trim()
    if (query === '') throw new WebError('keyless web search needs a non-empty query', 'WEB_PROVIDER_ERROR')
    const failures = []
    for (const engineId of this.options.engines) {
      const engine = ENGINES[engineId]
      if (engine === undefined) {
        failures.push(`${engineId}: unknown engine`)
        continue
      }
      try {
        const sources = await engine.run(query, {
          maxResults: request?.maxResults,
          timeoutMs: this.options.timeoutMs,
          userAgent: this.options.userAgent,
          ...(signal === undefined ? {} : { signal }),
        })
        if (sources.length === 0) {
          failures.push(`${engineId}: no results`)
          continue
        }
        this.log(`${engine.label} → ${sources.length} source(s) for ${JSON.stringify(query)}`)
        // seam 负责按 request.maxResults 截断并设置 truncated，provider 一律返回 false。
        return { sources, truncated: false }
      } catch (error) {
        failures.push(`${engineId}: ${describeError(error)}`)
      }
    }
    throw new WebError(
      `keyless web search failed for ${JSON.stringify(query)} — ${failures.join('; ')}`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

/**
 * 插件入口：把 provider 注册进 `ctx.web`。
 *
 * @param {import('cordis').Context} ctx 宿主插件上下文。
 * @param {KeylessSearchConfig} [config] profile 里覆盖的配置。
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  if (!Array.isArray(options.engines)) options.engines = [...DEFAULTS.engines]
  const log = (...args) => {
    if (options.debug) console.log('[dsh-web-search-keyless]', ...args)
  }
  const provider = new KeylessSearchProvider(options, log)
  ctx.web.registerSearchProvider(provider)
  log(`registered search provider "${provider.id}" with engines [${options.engines.join(', ')}]`)
}
