# dsh-web-search-keyless

DSH 宿主插件：给 `ctx.web` 换上一个**不需要密钥、也不消耗模型回合**的搜索 provider。
Bing RSS 为主，DuckDuckGo Lite 为备，命中失败自动顺延。

## 为什么

DSH 自带的 `dsh-web-search-deepseek` 走的是 "Anthropic Messages + 原生 `web_search`
服务端工具"：DeepSeek 没有独立检索端点，所以**每搜一次就是一次完整的模型回合**，按
token 计费，而且每个 query 文本不同、前缀从第一个差异处断开，缓存几乎必然不命中。
实测一次会话里 93 个 query 就是 93 次官方 API 请求、93 次未命中缓存的输入。

真实检索本来不需要模型参与。本插件把这一层换成两个普通 HTTP GET，成本为零：

| 引擎 | 端点 | 输出 |
|---|---|---|
| `bing` | `https://www.bing.com/search?q=…&format=rss` | RSS，`<item>` 里的 title / link / description / pubDate |
| `ddg` | `https://lite.duckduckgo.com/lite/?q=…` | 表格 HTML，`a.result-link` + `td.result-snippet` + `span.timestamp` |

DDG 的 href 是 `//duckduckgo.com/l/?uddg=<encoded>` 形式的跳转壳，`unwrapDdgHref`
会解出真实地址。

## 安装

```bash
# 1) 放进插件仓库（或任意目录）
cp -a dsh-web-search-keyless /mnt/f/project/tools/plugin/

# 2) 装进 profile：自动创建 node_modules 链接并追加 dsh.profile.bundles
dsh plugin --profile web add /mnt/f/project/tools/plugin/dsh-web-search-keyless

# 3) 重启 dsh web（新增 bundle 不进热更新），刷新页面
```

`node_modules/@deepseek-ai/dsh-web` 必须指向 DSH 安装目录里的同名包，插件才能拿到
`WebError`（错误码要能被 seam 识别）。这一步在开发目录里已经建好，`cp -a` 会原样带走；
如果换了 DSH 安装路径，重建即可：

```bash
cd <本包目录>
mkdir -p node_modules/@deepseek-ai
ln -sfn "$(dirname "$(readlink -f "$(command -v dsh)")")/../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web" \
  node_modules/@deepseek-ai/dsh-web
```

## 生效方式

`cordis.patch.yml` 随包发布，包含两条：注册 loader 入口，以及把
`web.searchProvider` 指到 `keyless`。放在包里是为了让安装保持**原子**——profile 开了
`patchReload: live`，若把 provider 选择单独写进 profile 配置，保存瞬间宿主就会去解析
一个尚未注册的 provider，重启前 `web_search` 会一直报 `WEB_PROVIDER_CONFIGURED_MISSING`。

profile 自己的 `cordis.patch.yml` 在 bundle 之后应用，随时可以覆盖回去：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official   # 换回 DeepSeek 官方搜索
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `id` | `keyless` | 注册到 seam 的 provider id，供 `web.searchProvider` 引用 |
| `engines` | `['bing','ddg']` | 引擎尝试顺序；前一个抛错或返回零条才换下一个 |
| `timeoutMs` | `15000` | 单个引擎的超时 |
| `userAgent` | 桌面 Chrome UA | Bing/DDG 对空 UA 会返回空结果集，别清空 |
| `debug` | `false` | 打印每次命中的引擎与条数 |

```yaml
- id: dsh-web-search-keyless
  name: 'dsh-web-search-keyless'
  config:
    engines: ['bing']
    timeoutMs: 10000
    debug: true
```

`request.maxResults` 会作为 `count` 传给 Bing；截断本身由 seam 负责，provider 一律
返回 `truncated: false`。全部引擎失败才抛 `WebError('WEB_PROVIDER_ERROR')`，错误文本里
带每个引擎的失败原因（超时 / HTTP 状态 / 零结果 / 未知引擎）。

## 已知取舍

- **质量**：Bing RSS / DDG Lite 是检索结果，不是摘要；没有 `content` 字段，只有
  `sources[]`。模型拿到的是 URL + 标题 + 摘要，需要细节就自己 `web_fetch`。
- **可用性**：两个引擎都是公开页面，可能被限流或改版。任一失败会顺延到下一个，
  两个都失败就是一次工具错误——不再回落到付费路径，这是有意的。
- **条款**：Bing RSS 的版权声明限定 "personal, non-commercial use within an RSS
  aggregator"。多租户或商用请换成有正式 API 的检索后端（Tavily / Brave / Exa /
  Perplexity），本插件的 provider 接口与之同形，改 `backends.js` 即可。

## 测试

```bash
node --test                    # 纯离线：解析器 + 错误路径 + 注册
DSH_KEYLESS_LIVE=1 node --test # 额外打真实端点，验证两个引擎都出结果
```
