/**
 * dsh-keep-awake — client half (web settings page).
 *
 * Registers the "Keep Awake 防休眠" section in the web settings panel and
 * polls the host's /dsh-keep-awake/state route every 3 seconds.
 *
 * i18n: dictionaries are registered with the framework locale service under
 * namespace `keep-awake` (zh + en). The active locale follows the system /
 * browser by default and can be overridden in DSH's own locale settings;
 * the component re-renders on `locale` snapshot changes, and the nav label
 * is a thunk re-read by the shell.
 */
window.__ModuleLoader__.load({
  id: 'dsh-keep-awake',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const STATE_ROUTE = '/dsh-keep-awake/state'
    const CONFIG_ROUTE = '/dsh-keep-awake/config'
    const POLL_MS = 3000
    const LOCALE_NS = 'keep-awake'

    const MESSAGES = {
      zh: {
        section: '防休眠',
        status: '状态',
        'badge.on': '保持唤醒中',
        'badge.grace': '宽限中 {s}s',
        'badge.off': '待机',
        'badge.disabled': '已停用',
        'badge.connError': '连接错误',
        'badge.helperError': '保持唤醒（助手异常）',
        'rows.runningAgents': '运行中的 agent',
        'rows.backgroundJobs': '后台任务（subagent / 命令等）',
        'rows.wakeLock': '唤醒锁',
        'wakeLock.held': '持有中',
        'wakeLock.released': '未持有',
        'rows.helper': '防休眠助手',
        'helper.on': '运行中 (pid {pid})',
        'helper.starting': '启动中',
        'helper.error': '异常',
        'helper.off': '未启动',
        'heading.settings': '设置',
        'setting.enabled': '启用防休眠',
        'setting.grace': '全部结束后宽限',
        'setting.preventDisplay': '同时阻止屏幕关闭',
        'setting.manualHold': '手动保持',
        'manualHold.on': '手动保持中（点击取消）',
        'manualHold.off': '手动保持唤醒',
        'grace.15': '15 秒',
        'grace.30': '30 秒',
        'grace.60': '1 分钟',
        'grace.120': '2 分钟',
        'grace.300': '5 分钟',
      },
      en: {
        section: 'Keep Awake',
        status: 'Status',
        'badge.on': 'Keeping awake',
        'badge.grace': 'Grace {s}s',
        'badge.off': 'Standby',
        'badge.disabled': 'Disabled',
        'badge.connError': 'Connection error',
        'badge.helperError': 'Awake (helper error)',
        'rows.runningAgents': 'Running agents',
        'rows.backgroundJobs': 'Background jobs (subagents / commands)',
        'rows.wakeLock': 'Wake lock',
        'wakeLock.held': 'Held',
        'wakeLock.released': 'Not held',
        'rows.helper': 'Keep-awake helper',
        'helper.on': 'running (pid {pid})',
        'helper.starting': 'starting',
        'helper.error': 'error',
        'helper.off': 'off',
        'heading.settings': 'Settings',
        'setting.enabled': 'Enabled',
        'setting.grace': 'Grace period after everything finishes',
        'setting.preventDisplay': 'Also keep the display on',
        'setting.manualHold': 'Manual hold',
        'manualHold.on': 'Manual hold active (click to release)',
        'manualHold.off': 'Hold awake manually',
        'grace.15': '15 s',
        'grace.30': '30 s',
        'grace.60': '1 min',
        'grace.120': '2 min',
        'grace.300': '5 min',
      },
    }

    const GRACES = [
      { key: 'grace.15', ms: 15000 },
      { key: 'grace.30', ms: 30000 },
      { key: 'grace.60', ms: 60000 },
      { key: 'grace.120', ms: 120000 },
      { key: 'grace.300', ms: 300000 },
    ]

    const styles = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { flex: 1, color: 'var(--dsw-alias-label-secondary)' },
      dim: { opacity: 0.65, fontSize: 12 },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.7, marginTop: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      badgeBase: {
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        whiteSpace: 'nowrap',
      },
      badgeOn: { color: 'var(--dsw-state-success-primary)' },
      badgeGrace: { color: 'var(--dsw-state-warn-label)' },
      badgeOff: { color: 'var(--dsw-alias-label-tertiary)' },
      badgeErr: { color: 'var(--dsw-state-error-primary)' },
      error: {
        color: 'var(--dsw-state-error-primary)',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        padding: '4px 8px',
        font: 'inherit',
      },
      button: {
        minHeight: 32,
        padding: '0 13px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 16,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
      },
      checkbox: { width: 16, height: 16, accentColor: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
    }

    function interpolate(template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function platformLabel(state) {
      if (state === 'win32') return 'Windows'
      if (state === 'darwin') return 'macOS'
      if (state === 'linux') return 'Linux'
      return String(state ?? '?')
    }

    function helperText(state, t) {
      if (state === null) return '—'
      const pf = platformLabel(state.platform)
      if (state.helperState === 'on') return `${pf} · ${t('helper.on', { pid: state.helperPid })}`
      if (state.helperState === 'starting') return `${pf} · ${t('helper.starting')}`
      if (state.helperState === 'error') return `${pf} · ${t('helper.error')}`
      return `${pf} · ${t('helper.off')}`
    }

    function fetchState() {
      return fetch(STATE_ROUTE, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    }

    function createSection(t) {
      function Section() {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState('')
        const [, bump] = React.useReducer((x) => x + 1, 0)

        const refresh = () => {
          fetchState()
            .then((s) => {
              setState(s)
              setError('')
            })
            .catch((e) => setError(String(e && e.message ? e.message : e)))
        }

        React.useEffect(() => {
          refresh()
          const timer = setInterval(refresh, POLL_MS)
          return () => clearInterval(timer)
        }, [])

        const setCfg = (patch) => {
          fetch(CONFIG_ROUTE, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ section: patch }),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((s) => setState(s))
            .catch((e) => setError(String(e && e.message ? e.message : e)))
        }

        let badge = [t('badge.off'), styles.badgeOff]
        if (error !== '') {
          badge = [t('badge.connError'), styles.badgeErr]
        } else if (state !== null) {
          if (!state.enabled) {
            badge = [t('badge.disabled'), styles.badgeOff]
          } else if (state.active) {
            badge = state.helperState === 'error'
              ? [t('badge.helperError'), styles.badgeErr]
              : [t('badge.on'), styles.badgeOn]
          } else if (state.graceRemainingMs > 0) {
            // activity is gone but the grace window is running and the helper
            // still holds the lock — the countdown belongs here, not under
            // `active` (which is already false by the time grace is armed)
            badge = [t('badge.grace', { s: Math.ceil(state.graceRemainingMs / 1000) }), styles.badgeGrace]
          } else {
            badge = [t('badge.off'), styles.badgeOff]
          }
        }

        const graceOptions = GRACES.map((g) =>
          h('option', { key: String(g.ms), value: String(g.ms) }, t(g.key)),
        )
        const graceValue = state !== null ? String(state.graceMs) : '60000'

        return h(
          'div',
          { style: styles.panel },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('status')),
            h('span', { style: { ...styles.badgeBase, ...badge[1] } }, badge[0]),
          ),
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, ...styles.dim } }, t('rows.runningAgents')),
              h('span', null, state !== null ? String(state.runningAgents) : '—'),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, ...styles.dim } }, t('rows.backgroundJobs')),
              h('span', null, state !== null ? String(state.liveJobs) : '—'),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, ...styles.dim } }, t('rows.wakeLock')),
              h(
                'span',
                null,
                state !== null ? (state.holdingWakeLock ? t('wakeLock.held') : t('wakeLock.released')) : '—',
              ),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, ...styles.dim } }, t('rows.helper')),
              h('span', null, helperText(state, t)),
            ),
          ),
          state !== null && state.helperError !== null && state.helperError !== ''
            ? h('div', { style: styles.error }, state.helperError)
            : null,
          error !== '' ? h('div', { style: styles.error }, error) : null,
          h('div', { style: styles.heading }, t('heading.settings')),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('setting.enabled')),
            h('input', {
              type: 'checkbox',
              style: styles.checkbox,
              checked: state !== null ? state.enabled : true,
              onChange: (e) => setCfg({ enabled: e.target.checked }),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('setting.grace')),
            h(
              'select',
              { style: styles.input, value: graceValue, onChange: (e) => setCfg({ graceMs: Number(e.target.value) }) },
              graceOptions,
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('setting.preventDisplay')),
            h('input', {
              type: 'checkbox',
              style: styles.checkbox,
              checked: state !== null ? state.preventDisplaySleep : false,
              onChange: (e) => setCfg({ preventDisplaySleep: e.target.checked }),
            }),
          ),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, t('setting.manualHold')),
            h(
              'button',
              {
                style: styles.button,
                onClick: () => setCfg({ manualHold: state === null || !state.manualHold }),
              },
              state !== null && state.manualHold ? t('manualHold.on') : t('manualHold.off'),
            ),
          ),
        )
      }
      return Section
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const locale = ctx.get('locale')

      if (locale !== undefined) {
        try {
          ctx.effect(() => {
            const disposes = [
              locale.register(LOCALE_NS, 'zh', MESSAGES.zh),
              locale.register(LOCALE_NS, 'en', MESSAGES.en),
            ]
            return () => {
              for (const d of disposes) d()
            }
          })
        } catch (e) {
          console.warn('keep-awake: locale registration failed', e)
        }
      }

      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => interpolate(MESSAGES.zh[key] ?? key, params)

      const Section = createSection(t)

      // Subscribe to locale changes once per Section mount.
      function LocaleAwareSection() {
        const [, bump] = React.useReducer((x) => x + 1, 0)
        React.useEffect(() => {
          if (locale === undefined) return undefined
          return locale.subscribe(() => bump())
        }, [])
        return h(Section)
      }

      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'keep-awake',
        order: 160,
        label: () => t('section'),
      }, LocaleAwareSection))
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
