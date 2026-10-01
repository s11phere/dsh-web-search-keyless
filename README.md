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
| `engines` | `['bing','ddg']` | 引擎尝试顺序；前一个抛错、返回零条或结果全部无关才换下一个 |
| `timeoutMs` | `15000` | 单个引擎的超时 |
| `userAgent` | 桌面 Chrome UA | Bing/DDG 对空 UA 会返回空结果集，别清空 |
| `relevanceGuard` | `true` | 丢掉与 query 无关的结果；关掉就退回"静默转发降级结果"，只建议排查解析问题时临时用 |
| `minIntervalMs` | `800` | 同一引擎两次请求的最小间隔（并行 query 会排队） |
| `cooldownMs` | `300000` | 引擎遇到 403/429/传输失败后的冷却时长 |
| `debug` | `false` | 打印命中的引擎、丢弃条数与冷却事件 |

```yaml
- id: dsh-web-search-keyless
  name: 'dsh-web-search-keyless'
  config:
    engines: ['bing']
    timeoutMs: 10000
    minIntervalMs: 1500
    debug: true
```

`request.maxResults` 会作为 `count` 传给 Bing；截断本身由 seam 负责，provider 一律
返回 `truncated: false`。全部引擎失败才抛 `WebError('WEB_PROVIDER_ERROR')`，错误文本里
带每个引擎的失败原因（超时 / HTTP 状态 / 零结果 / 未知引擎 / 结果无关 / 冷却中）。

## 效果与付费路径的差异（实测）

**这不是付费搜索的等价替代。** 差异分三层，都有实测支撑：

1. **元数据反而更全**。付费路径（DeepSeek 原生搜索）经本仓库实测的 200 条结果里
   **0 条带摘要、0 条带日期**（`web_search_result` 的 snippet 来自引用片段
   `cited_text`，实际很少命中），模型只拿到标题 + URL。本插件每条都带标题、摘要、
   发布日期，模型据此更容易判断该不该 `web_fetch`。

2. **长尾查询会静默降级**。Bing 对冷门查询会返回 HTTP 200、channel 标题正确回显
   query，然后给出**完全无关**的热门内容。实测（真实查询，节流 9s/次）：

   | query | 结果 |
   |---|---|
   | `PyMuPDF latest version` | 6 条，全部相关 |
   | `docling picture caption matching nearest caption below layout model` | 8 条，全部相关 |
   | `Nougat OCR arXiv PDF math LaTeX formula accuracy` | 8 条，全部相关 |
   | `PDFFigures 2.0 mining figures from research papers…` | 失败（Bing 返回 8 条无关内容） |
   | `FigureSeer parsing result-figures research papers ECCV 2016…` | 失败（同上） |
   | `CERMINE figure caption zone classification SVM…` | 失败（同上） |

   同一批 query 走付费路径时，返回的是 dl.acm / Springer 论文页、`github.com/CeON/CERMINE`
   源码、`docs.rs` 文档这一级的深链——**冷门方法名、论文标题这类调研，付费路径明显更强**。
   所以 `relevanceGuard` 默认开着：与其让模型自信引用垃圾，不如让这次搜索**明确失败**。

3. **降级是客户端信誉问题，不是查询语义**。同一时刻直接抓 Bing 的 HTML 结果页
   （`/search?q=…`，不走 RSS）返回的同样是无关内容（实测给出 "Assistant Principal jobs
   in Georgia"），说明两个接口都在被反爬降级。短时间高频请求会显著加剧：一次约 170
   个请求的压测之后，DDG 从可用变成 403、再变成连接超时，Bing 的长尾查询全面降级。
   因此本插件默认串行 + 最小间隔 + 冷却，且失败后**不回落到付费路径**。

**结论**：命名实体、常见库/项目类查询，免费路径够用且更快；冷门方法名、论文标题、
细分算法调研，建议要么接一个为程序化调用设计的检索 API（Tavily / Brave / Exa /
Perplexity——本插件的 provider 接口与之同形，改 `backends.js` 即可），要么在 profile 里
把 `web.searchProvider` 临时切回 `deepseek-official`。

## 已知取舍

- **质量**：Bing RSS / DDG Lite 是检索结果，不是摘要；没有 `content` 字段，只有
  `sources[]`。模型拿到的是 URL + 标题 + 摘要，需要细节就自己 `web_fetch`。
- **可用性**：两个引擎都是公开页面，可能被限流或改版。任一失败会顺延到下一个，
  两个都失败就是一次工具错误——不再回落到付费路径，这是有意的。
- **条款**：Bing RSS 的版权声明限定 "personal, non-commercial use within an RSS
  aggregator"。多租户或商用请换成有正式 API 的检索后端，见上一节。

## 测试

```bash
node --test                    # 纯离线：解析器 + 相关度闸门 + 节流/冷却 + 注册
DSH_KEYLESS_LIVE=1 node --test # 额外打真实端点，验证引擎出结果
```
