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
 * 但它不是付费搜索的等价替代，两处现实约束必须由本层兜住：
 *
 *   1. **静默降级**：Bing 的 RSS 接口对长尾技术查询会返回 HTTP 200、channel 标题
 *      正确回显 query，然后给出**完全无关**的热门内容（实测论文标题查询返回音乐
 *      流媒体、地毯清洗机）。转发这种结果等于让模型自信地引用垃圾，所以引擎输出
 *      必须过一遍相关度检查（`filterRelevant`），不合格就当这次引擎失败。
 *   2. **反爬限流**：短时间大量请求会让 DDG 直接 403、Bing 进入降级态。因此同一
 *      引擎的请求串行化并保持最小间隔，遇到 403/429/传输失败则把该引擎冷却一段
 *      时间，不再继续撞击。
 *
 * 装载：profile 的 `cordis.patch.yml` 里把 `web.searchProvider` 指到本 provider 的
 * `id`（默认 `keyless`）；本插件只注册 provider，不改变 `web_search` 工具的接口。
 *
 * @module dsh-web-search-keyless
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT, ENGINES, filterRelevant } from './backends.js'

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
 * @property {boolean} [relevanceGuard] 是否丢弃与 query 无关的结果，默认开。关掉会退回
 *   "静默转发降级结果"的行为，只建议在排查解析问题时临时使用。
 * @property {number} [minIntervalMs] 同一引擎两次请求的最小间隔，默认 800ms。
 * @property {number} [cooldownMs] 引擎被 403/429/传输失败后的冷却时长，默认 5 分钟。
 * @property {boolean} [debug] 打印每次搜索命中的引擎、丢弃条数与冷却事件。
 */
export const DEFAULTS = Object.freeze({
  id: 'keyless',
  engines: ['bing', 'ddg'],
  timeoutMs: 15_000,
  userAgent: DEFAULT_USER_AGENT,
  relevanceGuard: true,
  minIntervalMs: 800,
  cooldownMs: 300_000,
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
 * 这次失败是否意味着"对面在拦我们"。
 *
 * 403/429 是明示；`TypeError` 是 `fetch` 的传输层失败（DDG 在拦掉之后会直接断连，
 * 表现为 `fetch failed`），两者都该触发冷却，否则后续 query 只会继续撞墙。
 */
function isBlockError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/\bHTTP (403|429)\b/.test(message)) return true
  return error instanceof TypeError
}

/** 可取消的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal === undefined) return
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 无密钥搜索 provider。
 *
 * 每次 `search()` 按配置顺序尝试引擎：某个引擎抛错、返回零条、或结果**全部与 query
 * 无关**都算失败并换下一个；全部失败才抛 {@link WebError}（`WEB_PROVIDER_ERROR`），
 * 错误文本逐个列出原因，便于区分超时、被拦、还是引擎降级。
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
    /** @type {Map<string, {chain: Promise<unknown>, lastAt: number, blockedUntil: number}>} */
    this.engineState = new Map()
  }

  /**
   * 本地可用性检查：本 provider 不依赖凭据，因此只要还有引擎就算可用。
   * 按 seam 契约，这里不发网络请求。
   */
  available() {
    return this.options.engines.length > 0
  }

  /** 取（并初始化）某个引擎的串行队列/节流状态。 */
  stateOf(engineId) {
    let state = this.engineState.get(engineId)
    if (state === undefined) {
      state = { chain: Promise.resolve(), lastAt: 0, blockedUntil: 0 }
      this.engineState.set(engineId, state)
    }
    return state
  }

  /**
   * 排队执行一次引擎请求：串行化 + 最小间隔 + 冷却判定。
   *
   * 并行到来的多个 query（`dsh-tool-web` 一次调用最多 4 个）会在同一引擎上排队，
   * 既降低被判定为爬虫的概率，也让限流失败不至于雪崩。
   */
  runEngine(engine, query, maxResults, signal) {
    const state = this.stateOf(engine.id)
    const task = state.chain.then(async () => {
      const now = Date.now()
      if (now < state.blockedUntil) {
        throw new Error(`engine on cooldown for another ${Math.ceil((state.blockedUntil - now) / 1000)}s`)
      }
      const wait = state.lastAt + this.options.minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait, signal)
      state.lastAt = Date.now()
      try {
        return await engine.run(query, {
          maxResults,
          timeoutMs: this.options.timeoutMs,
          userAgent: this.options.userAgent,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (isBlockError(error)) {
          state.blockedUntil = Date.now() + this.options.cooldownMs
          this.log(`${engine.label} looks blocked (${describeError(error)}); cooling down ${Math.round(this.options.cooldownMs / 1000)}s`)
        }
        throw error
      }
    })
    // 队列只关心"轮到我了吗"，失败已经由调用方从 task 上读到；吞掉链上的拒绝，
    // 否则一个失败会让后续所有请求都跟着 reject。
    state.chain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
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
        const raw = await this.runEngine(engine, query, request?.maxResults, signal)
        const judged = this.options.relevanceGuard
          ? filterRelevant(raw, query)
          : { sources: [...raw], dropped: 0 }
        if (judged.sources.length === 0) {
          failures.push(
            raw.length === 0
              ? `${engineId}: no results`
              : `${engineId}: ${raw.length} result(s) but none matched the query (anti-bot degradation)`,
          )
          continue
        }
        if (judged.dropped > 0) this.log(`${engine.label}: dropped ${judged.dropped} off-topic result(s)`)
        this.log(`${engine.label} → ${judged.sources.length} source(s) for ${JSON.stringify(query)}`)
        // seam 负责按 request.maxResults 截断并设置 truncated，provider 一律返回 false。
        return { sources: judged.sources, truncated: false }
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
