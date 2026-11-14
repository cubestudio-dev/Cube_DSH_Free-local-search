/**
 * Cube_DSH_Free local search — browser half.
 *
 * Contributes one settings page (`settings.section` id `cube-dsh-free`) whose
 * job is a three-way mode selector. Everything else about the plugin happens on
 * the Host: this page only reads and writes the one field the Host already
 * exposes, through the settings domain's own form service.
 *
 * Why `configForms.get(...)` instead of an HTTP route of our own: the settings
 * service already owns persistence into the profile patch, the schema
 * projection, live (volatile) application, and write serialization. A private
 * route would duplicate that and add an authenticated surface for one enum.
 *
 * The page appears only while the Host serves this plugin's namespace, so a
 * profile where the plugin is absent shows no trace of it.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Colours come from theme variables only.
 */
window.__ModuleLoader__.load({
  id: 'cube-dsh-free',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.cubeDshFree'
    /** The Host settings namespace this page edits (the profile row id). */
    const NAMESPACE = 'cube-dsh-free'

    // ── copy ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '网页搜索后端',
        title: '网页搜索后端',
        description: '决定 web_search 与 web_fetch 走哪一条后端链路。切换后下一次调用即生效，选择保存在当前 profile，重启后仍然有效。',
        groupLabel: '后端模式',
        'mode.official.name': '官方 API',
        'mode.official.desc': '搜索和抓取完全走 DeepSeek 官方后端。需要可用的 API Key；没有密钥时调用会直接报错，不会退回本地。',
        'mode.local.name': '本地 API',
        'mode.local.desc': '两者完全走插件自带的免费本地后端：搜索读公开结果页，抓取在本地抽正文。不经过官方 API，也不需要任何密钥。',
        'mode.auto.name': '自动切换',
        'mode.auto.desc': '先试官方；官方这一次不可用（配额、鉴权、服务端错误、超时、零结果）就在同一次调用里自动改用本地后端。两层都失败时，错误会分别说明各自的原因。',
        current: '当前模式',
        saving: '保存中…',
        readOnly: '本部署的设置为只读，无法在这里切换模式。',
        unavailable: '该插件当前未加载，暂时无法配置。',
        saveFailed: '没有写入成功，已恢复为你原来的选择。',
        'source.bing': '必应',
        'source.360': '360 搜索',
        'source.baidu': '百度',
        'source.duckduckgo': 'DuckDuckGo',
        'source.sogou': '搜狗',
        sources: '本地搜索源（按顺序尝试）',
        sourcesHint: '在 Host 的插件配置里可以调整顺序、增删来源，以及超时、页数和正文长度上限。',
        cookieTitle: '会话 Cookie',
        cookieWarmUp: '先访问首页再搜索',
        cookieWarmUpHint: '开启后每次调用先访问各搜索源首页，拿到会话 Cookie 再搜索，使请求像一次浏览会话而非冷启动。它不是绕过拦截的可靠手段——被拦截时请调整搜索源顺序。',
        cookieBrowser: '从浏览器导入',
        cookieBrowserHint: '从已安装浏览器的 Cookie 库读取这些搜索引擎域名的 Cookie，只读、仅内存、不落盘。注意：浏览器运行时会独占 Cookie 文件；新版 Chromium 的 v20 加密也无法在浏览器外解密。',
        cookieHeader: '手工 Cookie 头',
        cookieHeaderHint: '直接粘贴形如 BAIDUID=…; MUID=… 的内容。浏览器导入不可用时用这个。保存在 profile 配置里。',
        cookieCurrent: '当前',
        cookieOn: '已启用',
        cookieOff: '未启用',
        toolsNote: '模型侧的工具名、参数和结果格式都不变；本插件只是替换这两个工具背后的后端。',
      },
      en: {
        nav: 'Web search backend',
        title: 'Web search backend',
        description: 'Chooses the backend behind web_search and web_fetch. A switch applies to the next call, is saved in this profile, and survives a restart.',
        groupLabel: 'Backend mode',
        'mode.official.name': 'Official API',
        'mode.official.desc': 'Search and fetch both go to the DeepSeek official backend. Requires a usable API key; without one the call fails instead of falling back.',
        'mode.local.name': 'Local API',
        'mode.local.desc': 'Both go to the plugin\'s bundled free local backend: search reads public results pages, fetch extracts article text locally. No official API, no key.',
        'mode.auto.name': 'Automatic',
        'mode.auto.desc': 'Tries official first; when official is unusable for this call (quota, auth, server error, timeout, zero results) it falls back to the local backend inside the same call. When both fail, the error names each layer.',
        current: 'Current mode',
        saving: 'Saving…',
        readOnly: 'This deployment stores settings read-only, so the mode cannot be switched here.',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        saveFailed: 'The write was not accepted; your previous choice was restored.',
        'source.bing': 'Bing',
        'source.360': '360 Search',
        'source.baidu': 'Baidu',
        'source.duckduckgo': 'DuckDuckGo',
        'source.sogou': 'Sogou',
        sources: 'Local sources (tried in order)',
        sourcesHint: 'Order, membership, timeouts, page cap, and body limits are adjustable in the Host plugin config.',
        cookieTitle: 'Session cookies',
        cookieWarmUp: 'Visit the landing page first',
        cookieWarmUpHint: 'When on, each call visits each source\'s home page first so the search carries session cookies and looks like a browsing session rather than a cold hit. This is not a reliable way around a block — reorder the sources instead.',
        cookieBrowser: 'Import from browser',
        cookieBrowserHint: 'Reads these search engines\' cookies from an installed browser. Read-only, memory only, never stored. Note: a running browser holds the cookie file exclusively, and current Chromium v20 encryption cannot be decrypted outside the browser.',
        cookieHeader: 'Paste a Cookie header',
        cookieHeaderHint: 'Paste something like BAIDUID=…; MUID=…. Use this when a browser import is impossible. Stored in the profile config.',
        cookieCurrent: 'Current',
        cookieOn: 'on',
        cookieOff: 'off',
        toolsNote: 'Tool names, parameters, and result formats stay identical; this plugin only replaces the backend behind them.',
      },
    }

    /** Mode metadata, in display order. */
    const MODES = [
      { id: 'official', name: 'mode.official.name', desc: 'mode.official.desc' },
      { id: 'local', name: 'mode.local.name', desc: 'mode.local.desc' },
      { id: 'auto', name: 'mode.auto.name', desc: 'mode.auto.desc' },
    ]

    /** Local source ids the Host accepts, for the read-only summary line. */
    const SOURCES = ['bing', '360', 'baidu', 'duckduckgo', 'sogou']

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
.cdf-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 8px; color: var(--dsw-alias-label-primary); }
.cdf-head { display: flex; flex-direction: column; gap: 6px; }
.cdf-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.cdf-desc { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.6; }
.cdf-group { display: flex; flex-direction: column; gap: 8px; }
.cdf-group-label { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.cdf-options { display: flex; flex-direction: column; gap: 8px; }
.cdf-option {
  display: flex; align-items: flex-start; gap: 10px; width: 100%; box-sizing: border-box;
  padding: 12px 14px; text-align: start; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); color: inherit;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  font: inherit; transition: border-color 120ms ease, background 120ms ease;
}
.cdf-option:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.cdf-option:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.cdf-option[aria-checked="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.cdf-option:disabled { cursor: not-allowed; opacity: 0.6; }
.cdf-dot {
  flex: 0 0 auto; width: 16px; height: 16px; margin-top: 1px; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l2); box-sizing: border-box;
  display: grid; place-items: center;
}
.cdf-option[aria-checked="true"] .cdf-dot { border-color: var(--dsw-alias-brand-primary); }
.cdf-dot-fill { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.cdf-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cdf-name { font-size: 13px; font-weight: 550; line-height: 1.4; }
.cdf-option-desc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.55; }
.cdf-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.55; }
.cdf-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cdf-status-strong { color: var(--dsw-alias-label-primary); font-weight: 550; }
.cdf-error { color: var(--dsw-alias-state-error-primary); }
.cdf-divider { height: 1px; background: var(--dsw-alias-border-l1); }
.cdf-sources { display: flex; flex-wrap: wrap; gap: 6px; }
.cdf-chip {
  padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 1.6;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
}
`

    // ── component ───────────────────────────────────────────────────────────

    /**
     * Subscribe to one settings form's snapshot.
     * @param {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void }} form - the form controller.
     * @returns {any} the current snapshot.
     */
    function useFormSnapshot(form) {
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
      return snapshot
    }

    /**
     * The settings page.
     * @param {{ form: any, t: (key: string) => string, locale: string }} props - page inputs.
     * @returns {any} the rendered page.
     */
    function SettingsPage(props) {
      const { form, t } = props
      const snapshot = useFormSnapshot(form)
      const [pending, setPending] = React.useState(undefined)
      const [failed, setFailed] = React.useState(false)

      const ready = snapshot.status === 'ready'
      const mode = ready && typeof snapshot.value?.mode === 'string' ? snapshot.value.mode : 'auto'
      // Cookie settings are ordinary (non-volatile) config: reading them here
      // keeps the page honest about what the Host will do on the next call.
      const cookie = {
        warmUp: ready ? snapshot.value?.cookieWarmUp !== false : false,
        browser: ready && typeof snapshot.value?.cookieBrowser === 'string' ? snapshot.value.cookieBrowser : 'none',
        header: ready && typeof snapshot.value?.cookieHeader === 'string' ? snapshot.value.cookieHeader : '',
      }
      const disabled = !ready || snapshot.writable === false || pending !== undefined
      const activeMode = MODES.find(entry => entry.id === mode)
      const groupRef = React.useRef(null)

      /**
       * Write one mode.
       * @param {string} next - the mode value.
       * @returns {Promise<void>} settlement after the write.
       */
      const choose = async next => {
        if (next === mode || disabled) return
        setFailed(false)
        setPending(next)
        try {
          const accepted = await form.set('mode', next)
          if (!accepted) setFailed(true)
        } catch {
          setFailed(true)
        } finally {
          setPending(undefined)
        }
      }

      /**
       * Arrow-key navigation across the radio group, matching native radios.
       * @param {any} event - keydown event.
       * @returns {void}
       */
      const onKeyDown = event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const index = MODES.findIndex(entry => entry.id === mode)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = MODES[(index + delta + MODES.length) % MODES.length]
        void choose(next.id)
        const buttons = groupRef.current?.querySelectorAll('[role="radio"]') ?? []
        const target = [...buttons].find(button => button.dataset.mode === next.id)
        target?.focus()
      }

      return h('div', { className: 'cdf-root' },
        h('div', { className: 'cdf-head' },
          h('h2', { className: 'cdf-title' }, t('title')),
          h('p', { className: 'cdf-desc' }, t('description')),
        ),

        !ready || snapshot.writable === false
          ? h('p', { className: 'cdf-note' }, snapshot.status === 'unavailable' ? t('unavailable') : t('readOnly'))
          : null,

        h('div', { className: 'cdf-group' },
          h('p', { className: 'cdf-group-label' }, t('groupLabel')),
          h('div', {
            className: 'cdf-options',
            role: 'radiogroup',
            'aria-label': t('groupLabel'),
            ref: groupRef,
            onKeyDown,
          }, MODES.map(entry => {
            const checked = entry.id === mode
            return h('button', {
              key: entry.id,
              type: 'button',
              role: 'radio',
              'aria-checked': checked ? 'true' : 'false',
              'data-mode': entry.id,
              tabIndex: checked ? 0 : -1,
              className: 'cdf-option',
              disabled,
              onClick: () => { void choose(entry.id) },
            },
              h('span', { className: 'cdf-dot', 'aria-hidden': 'true' }, checked ? h('span', { className: 'cdf-dot-fill' }) : null),
              h('span', { className: 'cdf-text' },
                h('span', { className: 'cdf-name' }, t(entry.name)),
                h('span', { className: 'cdf-option-desc' }, t(entry.desc)),
              ),
            )
          })),
        ),

        h('div', { className: 'cdf-status' },
          h('span', null, `${t('current')}：`),
          h('span', { className: 'cdf-status-strong' }, activeMode === undefined ? mode : t(activeMode.name)),
          pending === undefined ? null : h('span', null, t('saving')),
        ),

        failed ? h('p', { className: 'cdf-note cdf-error' }, t('saveFailed')) : null,

        h('div', { className: 'cdf-divider' }),

        h('div', { className: 'cdf-group' },
          h('p', { className: 'cdf-group-label' }, t('sources')),
          h('div', { className: 'cdf-sources' }, SOURCES.map(id => h('span', { key: id, className: 'cdf-chip' }, t(`source.${id}`)))),
          h('p', { className: 'cdf-note' }, t('sourcesHint')),
        ),

        // ── session cookies ────────────────────────────────────────────────
        // Read-only summary: the values live in the Host config, and editing
        // them here would duplicate the settings domain's own field editors.
        h('div', { className: 'cdf-group' },
          h('p', { className: 'cdf-group-label' }, t('cookieTitle')),
          h('div', { className: 'cdf-sources' },
            h('span', { className: 'cdf-chip' }, `${t('cookieWarmUp')}：${cookie.warmUp ? t('cookieOn') : t('cookieOff')}`),
            h('span', { className: 'cdf-chip' }, `${t('cookieBrowser')}：${cookie.browser}`),
            h('span', { className: 'cdf-chip' }, `${t('cookieHeader')}：${cookie.header === '' ? t('cookieOff') : t('cookieOn')}`),
          ),
          h('p', { className: 'cdf-note' }, t('cookieWarmUpHint')),
          h('p', { className: 'cdf-note' }, t('cookieBrowserHint')),
          h('p', { className: 'cdf-note' }, t('cookieHeaderHint')),
        ),

        h('p', { className: 'cdf-note' }, t('toolsNote')),
      )
    }

    // ── plugin ──────────────────────────────────────────────────────────────

    /**
     * Current locale tag for the host UI.
     * @param {any} ctx - browser plugin context.
     * @returns {string} the locale id.
     */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? snapshot?.locale ?? ctx.locale?.locale
        return typeof value === 'string' ? value : 'en'
      } catch {
        return 'en'
      }
    }

    /** Required browser services. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the page while the Host serves this plugin's settings namespace.
     * @param {any} ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'cube-dsh-free: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'cube-dsh-free')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'cube-dsh-free: styles')

      // The `configForms` service owns this controller's lifetime and disposes
      // every form it handed out when the service unloads; disposing it here
      // would leave the shared cache holding a dead controller.
      const form = ctx.configForms.get(NAMESPACE)

      ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NAMESPACE,
        order: 34,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, form, t: key => t(key), locale: localeTag(ctx) }))),
      ), 'cube-dsh-free: settings page')
    }

    exports.NS = NS
    exports.NAMESPACE = NAMESPACE
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})