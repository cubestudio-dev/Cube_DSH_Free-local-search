# Cube_DSH_Free local search

> **给 DSH 的 `web_search` / `web_fetch` 换一个可切换的后端。** 工具名、参数、结果格式全部不变——插件只在 `ctx.web` 背后替换实现，模型侧完全无感。

官方 API 用不了的时候（没配 key、配额耗尽、服务端 5xx、超时），你不必再看着一次工具调用失败：可以切到插件自带的免费本地后端，或者让它自动兜底。本地后端直接读公开搜索结果页、自己抽正文，不需要任何密钥。

- 三选一模式：**官方 API / 本地 API / 自动切换**
- 本地后端零依赖、零密钥，搜索覆盖必应、360、百度、DuckDuckGo、搜狗
- 抓取返回**结构化正文**而不是原始 HTML
- 失败按四种情形分类（请求失败 / 被拦截 / 无法解析 / 确实无内容），错误码可被程序路由

## 安装

两种方式：从 DSH 的 Discover 装，或直接把本目录装进 profile。

### 方式一：Discover（市场 index）

本仓库自带 `market-index.json`（DSH plugin-market format 1，已用官方 `parseMarketIndex` 校验）。把它添加为 index 源即可在 Discover 里看到并安装：

```
https://cubestudio-dev.github.io/Cube_DSH_Free-local-search/market-index.json
```

入口：**设置 → 插件 → More（Experimental plugins）→ 开启 Custom plugin markets → Discover → 添加索引源**。

> `github.io` 需要先在该仓库启用 GitHub Pages（Settings → Pages → Branch: `main` / `/`）。没有启用时该地址返回 404。`raw.githubusercontent.com` 与常见 CDN 在部分网络下不可达，所以 index 不内置这些地址。

### 方式二：直接安装本目录

```
plugin_manager → install_bundle → 目标填本目录绝对路径
```

安装后在「设置 → 网页搜索后端」切换模式，默认是 `auto`。

## 三种模式

| 模式 | 行为 |
|---|---|
| `official` 官方 API | 搜索与抓取完全走 DeepSeek 官方 provider。官方不可用就直接报错，不退回本地。 |
| `local` 本地 API | 两者完全走插件自带的免费后端，不经过官方 API，不需要密钥。 |
| `auto` 自动切换（默认） | 先试官方；这一次不可用（配额、鉴权、服务端错误、超时、零结果）就在**同一次调用**里改用本地。两层都失败时，错误分别列出各自原因。 |

模式在「设置 → 网页搜索后端」里切换，写入当前 profile 的 `cordis.patch.yml`，重启后仍生效；`mode` 是 volatile 字段，切换后下一次调用即按新模式走，不需要重载插件。

## 本地后端

**搜索**：读取公开搜索结果页并解析出 URL / 标题 / 摘要。

- 默认源顺序：`bing` → `360` → `baidu` → `duckduckgo` → `sogou`，任一源拿到结果即返回；全部失败时错误里逐个列出每个源的失败原因。
- 每个源是一个纯函数适配器（`lib/sources.js`），可按 `localSources` 增删或换序，也可新增源。
- 翻页：源自己提供「下一页」链接时跟随它（必应的翻页链接携带会话令牌），否则按源的偏移参数推进；结果按 URL 跨页去重，某页没有新结果就停止。
- 请求带浏览器 UA、`Accept-Language`、`Sec-Fetch-*`。
- 缺少 URL 的结果被丢弃；零条有效结果时以分类错误失败，绝不返回空列表。

**抓取**：取回网页并抽取标题 + 正文。

- 去掉 `script/style/nav/footer/aside` 等以及 class/id 形如 `sidebar`、`comment`、`ad`、`banner` 的噪声区块（`keepNoise` 可关闭）。
- 长页面按「密度最高的连续正文窗口」选择，避免把整页模板当成正文。
- 正文按字符上限在行边界截断，返回 `truncated`；附带相关链接。
- 依赖 JS 渲染的页面抽不到正文时，以「确实无内容」失败并说明原因。

## 配置不会因更新丢失

早期版本有个坑：bundle 的 `cordis.patch.yml` 里写死了 `config: { mode: auto }`。bundle 在每次安装/更新时都会被重新展开，这个字面量就会把用户的 mode 重置；同一层又是设置页回读的来源，所以升级后看起来是「Cookie 和源顺序全没了」。

现在有三条约束保证配置属于用户：

1. **bundle 层不携带任何用户可调配置。** 默认值只存在于 Config schema，bundle patch 只负责挂载行和指向 provider。
2. **profile 的 `cordis.patch.yml` 是设置的落点。** 这个文件由设置服务写入，插件更新不会碰它。
3. **坏字段只损失自己。** `resolveConfig` 逐字段容错：某个值不合法时该字段回落到默认并记录到 `problems`，其余字段照常保留。旧版是首个坏字段就整份抛错，调用方一律回落默认值——一个 YAML 里忘记加引号的 `360`（被解析成数字）就能让所有设置看起来消失。

排查方法：`problems` 数组会列出哪些字段回落了以及原因。若升级后仍有字段不对，先看这里，而不是怀疑存储。

## 搜索源管理

内置五个源：必应、360、百度、DuckDuckGo、搜狗。设置页里可以**开关**和**排序**，也可以**添加自己的源**。

### 开关与优先级

这两件事由同一个字段决定：`localSources` 就是"启用的源，按优先级排列"。

```yaml
localSources: [bing, baidu, mysearch]   # 先试必应，再百度，最后自定义源
```

- **开** = 加进这个列表；**关** = 从列表移除。
- **优先级** = 在列表里的位置。第一个返回结果的源生效，后面的不再请求。
- 至少保留一个；全部关掉会让本地后端无处可搜，因此被阻止。
- 关闭某个源不会删除它的 Cookie 或自定义声明，重新启用即可恢复。

### 添加自定义源

内置源的手写解析器不适合让用户复制，所以自定义源用**声明**而不是代码。一个声明描述"去哪个地址搜、结果块长什么样"：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一标识，同时用于按源配置 Cookie。不能与内置源重名。 |
| `label` | 是 | 显示名称。 |
| `url` | 是 | 搜索地址模板，**必须含 `{query}`**，可含 `{offset}`。 |
| `result` | 否 | 结果块的选择器，默认 `div.result`。 |
| `link` | 否 | 结果链接的选择器，默认 `a`。 |
| `title` | 否 | 标题的选择器，默认 `a`。 |
| `snippet` | 否 | 摘要的选择器，默认 `p`。 |
| `offsetStart` | 否 | 首页的 offset 值，默认 `0`。 |
| `offsetStep` | 否 | 每页 offset 增量，默认 `10`。 |
| `hosts` | 否 | Cookie 域，逗号分隔；留空则从 `url` 推导。 |
| `warmUp` | 否 | 搜索前访问的首页；留空则取 `url` 的 origin。 |

选择器支持三种基本写法：`tag`、`tag.class`、`#id`。没有引入完整 CSS 引擎——结果页的标记结构用这三种就够，多一个依赖不划算。

一个可用的例子（360）：

```yaml
customSources:
  - id: my360
    label: 我的 360
    url: "https://www.so.com/s?q={query}&pn={offset}"
    result: li.res-list
    link: h3 a
    title: h3
    snippet: p.res-desc
    offsetStart: 1
    offsetStep: 1
```

### 为什么用声明而不是脚本

插件配置保存在 profile 的 YAML 里，并从设置页编辑。如果允许在那里写 JavaScript，一次配置失误就变成了在宿主进程里执行任意代码。声明只能描述一个页面，不能执行任何东西。

### 验证过的边界

- 声明在写入前就校验（id 形状、URL 协议、`{query}` 必填、ID 重名与内置源冲突），错误显示在字段旁。
- 自定义源会进入 Cookie 体系：`hosts` 推导正确时，分源 Cookie 与浏览器导入都能作用于它。
- 选择器写错时，搜索会报"没有解析出结果"并指明是哪个源，而不是静默返回空列表。

## 会话 Cookie

公开搜索源会按会话拦截匿名流量。插件因此自己维护 Cookie jar，并支持四种来源：

| 字段 | 默认 | 说明 |
|---|---|---|
| `cookiesBySource` | 空 | **按源分别为每个搜索引擎配一份 Cookie。** 键是源 id（`bing` / `360` / `baidu` / `duckduckgo` / `sogou`）。设置页里每个源一行输入框，粘贴即可。 |
| `cookieWarmUp` | true | 每源搜索前先访问一次它的首页，拿到会话 Cookie 再搜索，让请求像一次浏览会话而不是冷启动的机器人。 |
| `cookieBrowser` | none | 从已安装浏览器（edge / chrome / chromium / brave）导入这些搜索域名的 Cookie，只读、仅内存、不落盘。 |
| `cookieHeader` | 空 | 旧版的单一 Cookie 头，保留作兜底：它只会发给能识别出的那个源，不会广播给所有源。 |

### 为什么按源分开

一个 Cookie 头只对一个域名有意义。把百度的 `BAIDUID` 发给必应，轻则被忽略，重则被判定为伪造会话。各家依赖的名字也不同：

| 源 | 特征 Cookie 名 |
|---|---|
| 百度 | `BAIDUID` `BDUSS` `STOKEN` `PSTM` `ZFY` |
| 搜狗 | `SUID` `SUV` `SNUID` `IPLOC` `PPUV` |
| 必应 | `MUID` `_EDGE_S` `SRCHHPGUSR` `_U` |
| 360 | `QiHooGUID` `QH_SESSION_ID` `__guid` |
| DuckDuckGo | `vqd` `dcr` |

### 自动识别来源

设置页每个输入框会实时显示这段 Cookie 属于哪个引擎。粘贴到任意一格都行——插件按 Cookie 名判断归属并归位到对应的源。

判据是上面的特征名，命中最多者胜。**两个源命中数相同时拒绝判定**，而不是猜：把会话挂到错误的域名上会产生一个「看起来已登录、其实没有」的请求，比不配置更糟。

也接受从 DevTools 直接复制的 `Cookie: …` 整行，以及文本里带域名（如 `www.sogou.com`）的情况。

**Cookie 确实会发到服务端**：已用 httpbin 回显验证，`Cookie: CUBE_PROBE=yes-123` 出现在请求头里；分源隔离也由测试覆盖——百度的 cookie 不会被发到必应的请求上。

### 关于「预热是否解决拦截」——修正说明

早先我观察到百度冷请求返回「百度安全验证」、预热后恢复正常结果，据此写下了"实测可恢复"。多次重复测试后，**这个结论不成立**：同一时段内冷请求也连续返回了正常结果。百度（以及必应）的限流是按出口 IP 与风险评分波动的，单次观察不能归因于预热。

准确的表述是：**预热 + Cookie 能保证请求携带会话，在源要求会话时才可能改变结果；它不是绕过拦截的可靠手段。** 遇到「被拦截」时，正确做法是调整 `localSources` 顺序或换一个源，而不是期待 Cookie 解决。

### 浏览器导入的真实边界

这些是实测结论，不是推测：

- **浏览器运行时会独占 Cookie 文件**，读和复制都会 EBUSY。已在本机复现（Edge 40 个进程）。关闭浏览器后可读。
- **新版 Chromium 的 Cookie 值用 v20（App-Bound）加密**，密钥只能由浏览器进程解开，**在浏览器外无法解密**。本机 Chrome 库即为此格式，插件如实报告而不伪造解密。
- 只有旧的 `v10`/`v11` 格式可以通过 Windows DPAPI（系统自带 .NET 接口）解开。

因此实践中 **`cookieWarmUp` 是默认开启的安全做法**（不需要碰浏览器，只是在搜索前多一次首页请求），`cookiesBySource` 是手工配置时的首选，`cookieBrowser` 与 `cookieHeader` 是它的补充。

### 必应翻页

必应的 `first=11/21` 在免登录会话下不生效，**携带 Cookie 后仍未改变**（已用 Cookie jar、完整 Chrome 客户端提示头、跟随重定向分别验证）。代码按规范实现 `first=1,11,21` 并优先跟随页面自身「下一页」链接，检测到无新结果即停止，不会重复抓同一页。360 的翻页正常（实测 6→13 条）。

## 失败分类

四种情况用稳定错误码区分，可在工具错误元数据里路由：

| 情况 | 错误码 |
|---|---|
| 请求失败（DNS/TLS/连接/超时/5xx） | `CUBE_WEB_REQUEST_FAILED` |
| 被拦截（401/403/429、验证码、拦截页） | `CUBE_WEB_BLOCKED` |
| HTML 无法解析（非 HTML、编码不可解、二进制） | `CUBE_WEB_UNPARSABLE` |
| 确实无内容（解析成功但无结果 / 无正文） | `CUBE_WEB_EMPTY` |
| 自动切换下两层都失败 | `CUBE_WEB_BOTH_FAILED` |

## 配置

`cordis.patch.yml` 里 `cube-dsh-free` 行的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `official` / `local` / `auto` |
| `officialSearchProvider` | `deepseek-official` | 官方搜索 provider id（或 `deepseek-search-api`） |
| `officialFetchProvider` | `http` | 官方抓取 provider id（或 `deepseek-fetch-api`） |
| `localSources` | 五个源 | 启用的源，按优先级排列（见「搜索源管理」） |
| `customSources` | 空 | 自定义源声明（见「搜索源管理」） |
| `localMaxPages` | 2 | 每源最多翻页数 |
| `localTimeoutMs` / `localFetchTimeoutMs` | 15000 / 25000 | 请求超时 |
| `localMaxBytes` | 3000000 | 响应字节上限 |
| `localFetchMaxChars` | 60000 | 返回正文上限 |
| `localMaxLinks` | 20 | 相关链接上限 |
| `keepNoise` | false | 保留导航/侧栏/页脚 |
| `cookieWarmUp` | true | 搜索前先访问源首页拿会话 Cookie |
| `cookieBrowser` | none | 从浏览器导入 Cookie（edge/chrome/chromium/brave） |
| `cookieHeader` | 空 | 旧版单一 Cookie 头，只发给能识别出的源 |
| `cookiesBySource` | 空 | 按源配置的 Cookie |

## 结构

```
package.json          # dsh.bundle + dsh.client 声明
cordis.patch.yml      # 挂载插件行，并把 web 的两个 provider 指向它
index.js              # Host：注册两个组合 provider
client.js             # Client：设置页（三选一 + Cookie 状态）
lib/config.js         # Config schema 与解析
lib/provider.js       # 三种模式的分派与自动切换
lib/search.js         # 本地搜索（分层、翻页、去重）
lib/fetch.js          # 本地抓取（抽取、截断、链接）
lib/sources.js        # 各搜索源适配器
lib/transport.js      # HTTP、编码、上限、状态分类
lib/cookies.js        # Cookie jar、预热、手工头
lib/browser-cookies.js# 浏览器 Cookie 库读取
lib/html.js           # 无依赖 HTML 扫描与正文抽取
lib/errors.js         # 失败分类与错误类
```

## 设计取舍

**为什么注册一个组合 provider，而不是按模式切换 provider id。** seam 在每次调用时按 id 解析 provider。如果按模式改指向，`auto` 在单次调用内就不可能实现，而且 seam 报出的可用性会随模式漂移。注册一个固定 id（`cube-dsh-free`）、在内部按模式分派，选择才是稳定的，兜底逻辑也留在插件自己的执行路径里。

**为什么不重新实现官方层。** 插件通过 seam 自己的注册表拿到已注册的 `deepseek-official` / `http` 并直接调用，于是部署里配的密钥、端点、账号登录、错误码全部自动继承，不会因为插件而失真。

**为什么本地后端不引第三方库。** profile 插件的 `node_modules` 只装它自己的依赖，harness 的包在插件里不可 import。与其 vendor 一个解析库，不如写一个只做抽取所需的小扫描器：没有供应链，也没有版本漂移。

**为什么失败要分四类。** 调用方的处置方式不同：请求失败值得重试，被拦截要换源，无法解析说明源改版了，确实无内容则是查询本身没结果。混成一个 `Error` 就没法路由。

## 已知限制

- **必应翻页在免登录会话下不前进**：`first=11/21` 会被忽略，携带 Cookie 后仍未改变（分别用 Cookie jar、完整 Chrome 客户端提示头、跟随重定向验证过）。代码按规范实现并优先跟随页面自身的「下一页」链接，检测到无新结果即停止，不会重复抓同一页。360 的翻页正常。
- **浏览器 Cookie 导入常不可用**：浏览器运行时会独占 Cookie 文件（EBUSY）；新版 Chromium 的 cookie 值用 v20 App-Bound 加密，只能在浏览器进程内解密。插件会如实报告原因，不伪造解密路径。`cookieWarmUp` 与 `cookieHeader` 不依赖浏览器。
- **Cookie 不能用来绕过拦截**：它只保证请求携带会话，不保证源放行。被拦截时请调整 `localSources` 顺序。
- **依赖 JS 渲染的页面**抽不到正文，会以「确实无内容」失败并说明原因，不使用无头浏览器。

## 开发

零构建：直接改 `.js`。安装到 profile 时是链接方式，重载即生效。

```bash
node --check index.js client.js    # 语法检查
```

无运行时依赖；`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-web` 是 peer，由 DSH 安装提供。

## 许可证

[MIT](LICENSE) © 2026 cubestudio-dev

