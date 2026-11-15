"""Apply the source-management UI to client.js in one precise pass.

Doing this with the edit tool across many anchors was fragile: shell quoting ate
template literals and a line-index splice truncated the file. This script works
from explicit string anchors, asserts each one is unique, and writes once.
"""
from pathlib import Path

PATH = Path('client.js')
text = PATH.read_text(encoding='utf-8')


def insert_before(anchor: str, addition: str) -> None:
    global text
    count = text.count(anchor)
    assert count == 1, f'anchor appears {count} times: {anchor[:60]!r}'
    text = text.replace(anchor, addition + anchor)


def insert_after(anchor: str, addition: str) -> None:
    global text
    count = text.count(anchor)
    assert count == 1, f'anchor appears {count} times: {anchor[:60]!r}'
    text = text.replace(anchor, anchor + addition)


# ── 1. copy ────────────────────────────────────────────────────────────────
ZH = """        sourceMustKeepOne: '至少保留一个启用的源',
        custom: '自定义',
        off: '已关闭',
        moveUp: '提高优先级',
        moveDown: '降低优先级',
        remove: '删除',
        cancel: '取消',
        customSources: '自定义搜索源',
        csAdd: '添加源',
        csEmpty: '还没有自定义源。内置的五个源可以直接开关和排序。',
        csId: 'ID（用于配置与 Cookie）',
        csLabel: '显示名称',
        csUrl: '搜索地址模板（必须含 {query}，可含 {offset}）',
        csResult: '结果块的选择器',
        csLink: '链接的选择器',
        csTitle: '标题的选择器',
        csSnippet: '摘要的选择器',
        csOffsetStart: '首页 offset 值',
        csOffsetStep: '每页 offset 增量',
        csHosts: '域（用于 Cookie，逗号分隔）',
        csSave: '保存并启用',
        csHint: '选择器支持 tag、tag.class、#id 三种基本写法。填好后调用一次搜索验证：没有解析出结果，说明选择器与目标页面不一致。',
        csErrId: 'ID 只能由字母、数字、下划线、连字符组成，且以字母或数字开头',
        csErrBuiltIn: '这个 ID 与内置源重名，请换一个',
        csErrUrl: '搜索地址必须以 http(s):// 开头，并且包含 {query}',
        csErrLabel: '显示名称不能为空',
        csErrDuplicate: '已经有同 ID 的自定义源了',
        csErrOffset: 'offset 必须是非负整数',
"""
insert_before("        sources: '本地搜索源（按顺序尝试）',\n", ZH)

EN = """        sourceMustKeepOne: 'Keep at least one source on',
        custom: 'custom',
        off: 'off',
        moveUp: 'Higher priority',
        moveDown: 'Lower priority',
        remove: 'Remove',
        cancel: 'Cancel',
        customSources: 'Custom sources',
        csAdd: 'Add source',
        csEmpty: 'No custom sources yet. The five built-in sources can be toggled and reordered directly.',
        csId: 'ID (used by config and cookies)',
        csLabel: 'Display name',
        csUrl: 'Search URL template (must contain {query}, may contain {offset})',
        csResult: 'Result block selector',
        csLink: 'Link selector',
        csTitle: 'Title selector',
        csSnippet: 'Snippet selector',
        csOffsetStart: 'First page offset',
        csOffsetStep: 'Offset step per page',
        csHosts: 'Hosts for cookies (comma separated)',
        csSave: 'Save and enable',
        csHint: 'Selectors accept tag, tag.class and #id. Run one search to verify: if nothing parses, the selectors do not match the page.',
        csErrId: 'The ID may contain letters, digits, underscore and hyphen, and must start with a letter or digit',
        csErrBuiltIn: 'That ID is a built-in source; choose another',
        csErrUrl: 'The URL must start with http(s):// and contain {query}',
        csErrLabel: 'The display name cannot be empty',
        csErrDuplicate: 'A custom source with that ID already exists',
        csErrOffset: 'offset must be a non-negative integer',
"""
insert_before("        sources: 'Local sources (tried in order)',\n", EN)

# ── 2. the two components, before the plugin section ───────────────────────
COMPONENTS = """    // ── source management ───────────────────────────────────────────────────

    /** Built-in source ids, in their shipped order. */
    const BUILT_IN = ['bing', '360', 'baidu', 'duckduckgo', 'sogou']

    /**
     * The full source table: built-ins plus whatever the user declared.
     *
     * `enabled` is derived from `localSources`, because that array already means
     * "the sources that will be tried, in this order" — one field is the single
     * source of truth for both switching and priority, so the two can never
     * disagree.
     *
     * @param {string[]} localSources - the configured order.
     * @param {Array<{ id: string, label: string }>} customSources - declarations.
     * @returns {Array<{ id: string, label: string, custom: boolean, enabled: boolean, rank: number }>} the table.
     */
    function sourceTable(localSources, customSources) {
      /** @type {Array<{ id: string, label: string, custom: boolean }>} */
      const rows = BUILT_IN.map(id => ({ id, label: id, custom: false }))
      for (const entry of customSources) {
        if (typeof entry?.id !== 'string') continue
        rows.push({
          id: entry.id,
          label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
          custom: true,
        })
      }
      return rows.map(entry => {
        const index = localSources.indexOf(entry.id)
        return { ...entry, enabled: index !== -1, rank: index }
      })
    }

    /**
     * One source row: a switch and two arrows that move it in the try order.
     *
     * @param {object} props - row props.
     * @param {any} props.h - createElement.
     * @param {{ id: string, label: string, custom: boolean, enabled: boolean, rank: number }} props.row - the row.
     * @param {number} props.enabledCount - how many sources are on.
     * @param {number} props.enabledRank - this source's 1-based rank among enabled ones.
     * @param {boolean} props.disabled - writes blocked.
     * @param {(id: string) => void} props.onToggle - enable/disable.
     * @param {(delta: number) => void} props.onMove - change priority.
     * @param {(id: string) => void} props.onRemove - delete a custom declaration.
     * @param {(key: string) => string} props.t - translator.
     * @returns {any} the row.
     */
    function SourceRow({ h, row, enabledCount, enabledRank, disabled, onToggle, onMove, onRemove, t }) {
      // The local backend needs at least one source to search; refusing the last
      // switch-off is clearer than saving a configuration that cannot work.
      const isOnlyEnabled = row.enabled && enabledCount <= 1
      return h('div', { className: row.enabled ? 'cdf-src cdf-src-on' : 'cdf-src' },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': row.enabled ? 'true' : 'false',
          className: row.enabled ? 'cdf-src-switch cdf-src-switch-on' : 'cdf-src-switch',
          disabled: disabled || isOnlyEnabled,
          title: isOnlyEnabled ? t('sourceMustKeepOne') : undefined,
          onClick: () => onToggle(row.id),
        }, h('span', { className: 'cdf-src-knob' })),

        h('span', { className: 'cdf-src-label' }, row.label),
        row.custom ? h('span', { className: 'cdf-src-badge' }, t('custom')) : null,
        row.enabled
          ? h('span', { className: 'cdf-src-rank' }, '#' + String(enabledRank))
          : h('span', { className: 'cdf-src-rank cdf-src-rank-off' }, t('off')),

        h('span', { className: 'cdf-src-actions' },
          h('button', {
            type: 'button',
            className: 'cdf-src-arrow',
            'aria-label': t('moveUp'),
            disabled: disabled || !row.enabled || enabledRank <= 1,
            onClick: () => onMove(-1),
          }, '↑'),
          h('button', {
            type: 'button',
            className: 'cdf-src-arrow',
            'aria-label': t('moveDown'),
            disabled: disabled || !row.enabled || enabledRank >= enabledCount,
            onClick: () => onMove(1),
          }, '↓'),
          row.custom
            ? h('button', {
              type: 'button',
              className: 'cdf-src-remove',
              'aria-label': t('remove'),
              disabled,
              onClick: () => onRemove(row.id),
            }, '×')
            : null,
        ),
      )
    }

    /**
     * The editor for one custom source declaration.
     *
     * The URL template and the selectors are shown together because the
     * selectors only make sense against the page that template returns.
     *
     * @param {object} props - form props.
     * @param {any} props.h - createElement.
     * @param {Record<string, string>} props.draft - the declaration being edited.
     * @param {boolean} props.disabled - writes blocked.
     * @param {(patch: object) => void} props.onChange - field change.
     * @param {() => void} props.onSave - persist.
     * @param {() => void} props.onCancel - discard.
     * @param {string} props.error - validation message, or ''.
     * @param {(key: string) => string} props.t - translator.
     * @returns {any} the editor.
     */
    function CustomSourceForm({ h, draft, disabled, onChange, onSave, onCancel, error, t }) {
      /**
       * One labelled text field.
       *
       * @param {string} key - draft key.
       * @param {string} labelKey - copy key.
       * @param {string} placeholder - hint text.
       * @returns {any} the field.
       */
      const field = (key, labelKey, placeholder) => h('label', { className: 'cdf-cs-field' },
        h('span', { className: 'cdf-cs-label' }, t(labelKey)),
        h('input', {
          type: 'text',
          className: 'cdf-cs-input',
          value: draft[key] ?? '',
          placeholder,
          spellCheck: false,
          disabled,
          onChange: event => onChange({ [key]: event.target.value }),
        }),
      )
      return h('div', { className: 'cdf-cs' },
        h('div', { className: 'cdf-cs-row' },
          field('id', 'csId', 'mysearch'),
          field('label', 'csLabel', '我的搜索'),
        ),
        field('url', 'csUrl', 'https://example.com/search?q={query}&page={offset}'),
        h('div', { className: 'cdf-cs-row' },
          field('result', 'csResult', 'div.result'),
          field('link', 'csLink', 'a'),
        ),
        h('div', { className: 'cdf-cs-row' },
          field('title', 'csTitle', 'h3'),
          field('snippet', 'csSnippet', 'p'),
        ),
        h('div', { className: 'cdf-cs-row' },
          field('offsetStart', 'csOffsetStart', '0'),
          field('offsetStep', 'csOffsetStep', '10'),
        ),
        field('hosts', 'csHosts', 'example.com'),
        h('p', { className: 'cdf-note' }, t('csHint')),
        error === '' ? null : h('p', { className: 'cdf-note cdf-error' }, error),
        h('div', { className: 'cdf-cs-actions' },
          h('button', { type: 'button', className: 'cdf-cookie-save', disabled, onClick: onSave }, t('csSave')),
          h('button', { type: 'button', className: 'cdf-cookie-clear', disabled, onClick: onCancel }, t('cancel')),
        ),
      )
    }

"""
insert_before("    // ── plugin ──────────────────────────────────────────────────────────────", COMPONENTS)

# ── 3. page state and writers, before `disabled` ───────────────────────────
STATE = """      // ── sources: enable / disable / priority ─────────────────────────────
      // `localSources` is the single source of truth: it lists exactly the
      // enabled sources, in priority order. Toggling edits membership; moving
      // edits order. Both write the same field.
      const currentSources = ready && Array.isArray(snapshot.value?.localSources)
        ? snapshot.value.localSources.filter(entry => typeof entry === 'string')
        : [...BUILT_IN]
      const customDeclarations = ready && Array.isArray(snapshot.value?.customSources)
        ? snapshot.value.customSources.filter(entry => entry != null && typeof entry === 'object' && typeof entry.id === 'string')
        : []
      const table = sourceTable(currentSources, customDeclarations)
      const enabledCount = currentSources.length

      const draftState = React.useState(undefined)
      const draft = draftState[0]
      const setDraft = draftState[1]
      const draftErrorState = React.useState('')
      const draftError = draftErrorState[0]
      const setDraftError = draftErrorState[1]

      /**
       * Write the enabled/ordered source list.
       *
       * @param {string[]} next - the new order.
       * @returns {Promise<void>} settlement after the write.
       */
      const writeSources = async next => {
        if (disabledRef.current) return
        setFailed(false)
        try {
          const accepted = await form.set('localSources', next)
          if (!accepted) setFailed(true)
        } catch {
          setFailed(true)
        }
      }

      /**
       * Write the custom declarations.
       *
       * @param {object[]} next - the declarations.
       * @returns {Promise<void>} settlement after the write.
       */
      const writeCustom = async next => {
        if (disabledRef.current) return
        setFailed(false)
        try {
          const accepted = await form.set('customSources', next)
          if (!accepted) setFailed(true)
        } catch {
          setFailed(true)
        }
      }

      /**
       * Validate and persist the draft custom source.
       *
       * Validation mirrors the Host's so a typo is caught next to the field
       * instead of surfacing as a generic save failure.
       *
       * @returns {Promise<void>} settlement after the write.
       */
      const saveDraft = async () => {
        if (draft === undefined) return
        setDraftError('')
        const id = String(draft.id ?? '').trim()
        const label = String(draft.label ?? '').trim()
        const url = String(draft.url ?? '').trim()

        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) return setDraftError(t('csErrId'))
        if (BUILT_IN.includes(id)) return setDraftError(t('csErrBuiltIn'))
        if (!/^https?:\\/\\//i.test(url) || !url.includes('{query}')) return setDraftError(t('csErrUrl'))
        if (label === '') return setDraftError(t('csErrLabel'))
        if (customDeclarations.some(entry => entry.id === id)) return setDraftError(t('csErrDuplicate'))

        const spec = { id, label, url }
        for (const key of ['result', 'link', 'title', 'snippet', 'hosts', 'warmUp']) {
          const value = String(draft[key] ?? '').trim()
          if (value !== '') spec[key] = value
        }
        for (const key of ['offsetStart', 'offsetStep']) {
          const raw = String(draft[key] ?? '').trim()
          if (raw === '') continue
          const value = Number(raw)
          if (!Number.isInteger(value) || value < 0) return setDraftError(t('csErrOffset'))
          spec[key] = value
        }

        // Enabling the new source by default: a declaration nobody enabled does
        // nothing, which reads as a bug rather than as a choice.
        await writeCustom([...customDeclarations, spec])
        if (!currentSources.includes(id)) await writeSources([...currentSources, id])
        setDraft(undefined)
      }

"""
insert_before("      const disabled = !ready || snapshot.writable === false || pending !== undefined\n", STATE)

# the writers are declared before `disabled`, so they read it through a ref
insert_after(
    "      const enabledCount = currentSources.length\n",
    "\n      // The writers below are called from event handlers, so they must read the\n"
    "      // current writability rather than close over the first render's value.\n"
    "      const disabledRef = React.useRef(false)\n",
)
insert_after(
    "      const disabled = !ready || snapshot.writable === false || pending !== undefined\n",
    "      disabledRef.current = disabled\n",
)

# ── 4. the sources block ───────────────────────────────────────────────────
OLD_SOURCES = """        h('div', { className: 'cdf-group' },
          h('p', { className: 'cdf-group-label' }, t('sources')),
          h('div', { className: 'cdf-sources' }, SOURCES.map(id => h('span', { key: id, className: 'cdf-chip' }, t(`source.${id}`)))),
          h('p', { className: 'cdf-note' }, t('sourcesHint')),
        ),
"""

NEW_SOURCES = """        h('div', { className: 'cdf-group' },
          h('p', { className: 'cdf-group-label' }, t('sources')),
          h('p', { className: 'cdf-note' }, t('sourcesHint')),

          // Priority order is the order of `localSources`: the first source that
          // answers wins, so this list IS the priority.
          h('div', { className: 'cdf-src-list' },
            table.map(row => h(SourceRow, {
              key: row.id,
              h,
              row,
              enabledCount,
              enabledRank: row.enabled ? row.rank + 1 : 0,
              disabled,
              t,
              onToggle: id => {
                const next = row.enabled
                  ? currentSources.filter(entry => entry !== id)
                  : [...currentSources, id]
                void writeSources(next)
              },
              onMove: delta => {
                const order = currentSources.slice()
                const from = order.indexOf(row.id)
                const to = from + delta
                if (from === -1 || to < 0 || to >= order.length) return
                const moved = order.splice(from, 1)[0]
                order.splice(to, 0, moved)
                void writeSources(order)
              },
              // Removing a declaration also drops it from the order, otherwise
              // the order would point at a source that no longer exists.
              onRemove: id => {
                void writeCustom(customDeclarations.filter(entry => entry.id !== id))
                if (currentSources.includes(id)) {
                  void writeSources(currentSources.filter(entry => entry !== id))
                }
              },
            })),
          ),

          // ── custom sources ────────────────────────────────────────────────
          h('div', { className: 'cdf-cs-head' },
            h('p', { className: 'cdf-group-label' }, t('customSources')),
            draft === undefined
              ? h('button', {
                type: 'button',
                className: 'cdf-cs-add',
                disabled,
                onClick: () => setDraft({ id: '', label: '', url: '', offsetStart: '0', offsetStep: '10' }),
              }, t('csAdd'))
              : null,
          ),
          draft === undefined
            ? null
            : h(CustomSourceForm, {
              h,
              draft,
              disabled,
              error: draftError,
              onChange: patch => setDraft({ ...draft, ...patch }),
              onSave: () => { void saveDraft() },
              onCancel: () => setDraft(undefined),
              t,
            }),
          customDeclarations.length === 0 && draft === undefined
            ? h('p', { className: 'cdf-note' }, t('csEmpty'))
            : null,
        ),
"""
assert text.count(OLD_SOURCES) == 1, 'sources block not unique'
text = text.replace(OLD_SOURCES, NEW_SOURCES)

# ── 5. CSS ─────────────────────────────────────────────────────────────────
CSS = """.cdf-src-list { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 16px; }
.cdf-src {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-l2, transparent);
}
.cdf-src-on { border-color: var(--dsw-alias-brand-primary, #e8b53f); }
.cdf-src-switch {
  position: relative; width: 34px; height: 20px; flex: none;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; cursor: pointer; padding: 0;
}
.cdf-src-switch-on { background: var(--dsw-alias-brand-primary, #e8b53f); border-color: transparent; }
.cdf-src-switch:disabled { opacity: 0.4; cursor: not-allowed; }
.cdf-src-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--dsw-alias-text-l3);
  transition: transform 140ms ease;
}
.cdf-src-switch-on .cdf-src-knob { transform: translateX(14px); background: #0a1020; }
.cdf-src-label { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; }
.cdf-src-badge {
  font-size: 10px; padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-text-l3);
}
.cdf-src-rank { font-size: 11px; color: var(--dsw-alias-text-l3); font-variant-numeric: tabular-nums; }
.cdf-src-rank-off { opacity: 0.6; }
.cdf-src-actions { display: flex; gap: 4px; }
.cdf-src-arrow, .cdf-src-remove {
  width: 26px; height: 26px; padding: 0; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-text-l2);
  font-size: 13px; line-height: 1;
}
.cdf-src-arrow:disabled, .cdf-src-remove:disabled { opacity: 0.3; cursor: not-allowed; }
.cdf-src-arrow:not(:disabled):hover { background: rgba(232,181,63,0.12); }
.cdf-src-remove:not(:disabled):hover { background: rgba(224,85,85,0.12); color: #e05555; }
.cdf-cs-head { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.cdf-cs-add {
  font-size: 12px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-brand-primary, #e8b53f);
  background: transparent; color: var(--dsw-alias-brand-primary, #e8b53f);
}
.cdf-cs-add:disabled { opacity: 0.4; cursor: not-allowed; }
.cdf-cs { display: flex; flex-direction: column; gap: 10px; margin: 10px 0 14px; padding: 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); }
.cdf-cs-row { display: flex; gap: 10px; }
.cdf-cs-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.cdf-cs-label { font-size: 11px; color: var(--dsw-alias-text-l3); }
.cdf-cs-input {
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
  padding: 7px 9px; border-radius: 7px;
  color: var(--dsw-alias-text-l1);
  background: var(--dsw-alias-bg-l1, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
}
.cdf-cs-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #e8b53f); }
.cdf-cs-actions { display: flex; gap: 8px; }
"""
insert_before(".cdf-divider { height: 1px;", CSS)

PATH.write_text(text, encoding='utf-8')
print('client.js updated:', len(text.splitlines()), 'lines')
