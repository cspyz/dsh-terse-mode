/**
 * dsh-terse-mode — the conversation-header control.
 *
 * One compact control in the conversation header row (beside the agent-team /
 * preset / cost-details buttons): it shows the live level, switches it in one
 * click, and carries the per-level explanations plus the settings notes in a
 * popover.
 *
 * The host half (`index.js`) serves and applies it; this file only talks to it
 * over `fetch`, the same lane the installed plugin market uses.
 *
 * Plain JavaScript in the browser module format documented for client plugins
 * (`window.__ModuleLoader__.load`), so there is no build step and no
 * `@deepseek-ai/*` import — which a `link:`-installed plugin could not resolve.
 */
window.__ModuleLoader__.load({
  id: 'dsh-terse-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-terse-mode'
    const SLOT = 'conversation.session.header.actions'
    const API_PATH = 'dsh-terse-mode/api/state'
    const LEVELS = ['off', 'light', 'standard', 'strong']

    const DICTIONARIES = {
      zh: {
        label: '简洁模式',
        labelHint: '简洁模式：限制 DeepSeek 的思考强度、联网搜索和回答长度。点 ? 看每一档在做什么，以及改在哪里。',
        levelOff: '关',
        levelLight: '轻',
        levelStandard: '标准',
        levelStrong: '强',
        levelOffWhat: '关：完全不限制。思考强度跟你在模型菜单里选的一致，联网搜索开着，回答长度不限。',
        levelLightWhat: '轻：思考默认压到 low；联网默认允许；回答长度不限；只加一条“简短回答、别过度搜”的指令。',
        levelStandardWhat: '标准（推荐）：思考默认压到 low；联网默认禁止（工具也从模型眼前藏掉）；回答长度不限，只靠指令要求简短。',
        levelStrongWhat: '强：思考默认关掉；联网默认禁止；最严格的简短要求（回答尽量 120 字内）；回答长度同样不限。',
        levelDefaultsNote: '档位给的是默认值：下面的开关只要不是「跟随档位」，就以开关为准（思考强度、联网搜索）；子代理开关则完全独立于档位。',
        whatTitle: '每一档在做什么',
        effortTitle: '思考强度（覆盖档位）',
        // Labels follow the official model menu's effort names, in English, in
        // both languages: `auto` is this plugin's own "let the level decide".
        effortAuto: 'auto',
        effortOff: 'off',
        effortLow: 'low',
        effortHigh: 'high',
        effortMax: 'max',
        effortAutoWhat: '由当前档位决定：轻 / 标准 = 低，强 = 关，关（档位）= 完全不碰请求。',
        effortOffWhat: '完全关闭思考（thinking 关掉），响应最快。',
        effortLowWhat: '轻量思考：复杂任务保留一点推理，简单问题几乎不想。',
        effortHighWhat: '比档位更高的强思考——只有确实需要深思的任务才选。',
        effortMaxWhat: '最大强度，最慢也最贵，只留给真正难的问题。',
        effortReset: '注意：点档位会把这里的思考强度重置为「跟随档位」；想固定强度就先点档位、再点强度。',
        effortCurrent: '当前',
        subagentTitle: '子代理',
        subagentAllow: '允许',
        subagentDeny: '禁用',
        subagentWhatAllow: '允许派出子代理：subagent / subagent_fork / spawn_teammate / workflow 四个工具模型都能用。',
        subagentWhatDeny: '禁用子代理：这四个工具从模型眼前隐藏，模型必须自己在当前会话干完（更省 token、更难失控，但大任务不能再并行）。',
        subagentHint: '一键开关子代理（把 subagent / workflow 那类工具从模型眼前拿掉）。',
        searchTitle: '联网搜索',
        searchAllow: '允许',
        searchDeny: '禁止',
        searchAuto: '跟随档位',
        searchWhatAuto: '由当前档位决定：关 / 轻 允许联网，标准 / 强 禁止。',
        searchWhatAllow: '允许联网搜索：web_search / web_fetch 可用，需要现成事实时模型能去查。',
        searchWhatDeny: '禁止联网搜索：这两个工具从模型眼前隐藏，运行期也硬拦；需要外部事实时它会说明，而不是硬猜。',
        searchHint: '一键开关联网搜索（web_search / web_fetch）。',
        searchCurrent: '当前',
        searchFromLevel: '档位给的',
        searchByYou: '你选的',
        nav: '简洁模式',
        sectionIntro: '这里和对话页顶部的小控件是同一份设置，改哪边都会立刻生效（不分先后）。',
        effectiveTitle: '当前实际生效',
        think: '思考',
        cap: '输出上限',
        unlimited: '不限',
        search: '联网搜索',
        searchOn: '允许',
        searchOff: '禁止',
        instruction: '提示词指令',
        on: '有',
        none: '无',
        unchanged: '跟随模型菜单',
        settingsTitle: '改在哪里',
        setting1: '细项（思考强度 / 上限 / 是否允许搜索 / 自定义提示词）：插件目录里的 cordis.patch.yml，或在 profile 的 cordis.patch.yml 里按 id: terse-mode 覆盖。',
        setting2: '面板选的档位单独记在 $DSH_HOME/storages/dsh-terse-mode/level.json，优先于 patch；删掉它即回到 patch 的档位。',
        setting3: '点档位或改配置立即生效；改插件代码（index.js / lib / client.js）要重启一次 DSH。',
        capNote: '档位是上限、只降不升：即便你在模型菜单里选得更高，也会被压到档位值。对所有会话生效，包括子 agent。四个档位都不设输出上限。',
        help: '说明与设置',
        close: '关闭',
        offline: '未连上宿主',
        offlineHint: '面板没连上宿主：宿主半侧还是旧模块，重启一次 DeepSeek Harness 即可。',
        cause: '原始报错',
        retry: '重试',
        saving: '切换中…',
      },
      en: {
        label: 'Terse mode',
        labelHint: 'Terse mode: caps DeepSeek reasoning effort, web search and answer length. Click ? for what each level does and where to change it.',
        levelOff: 'Off',
        levelLight: 'Light',
        levelStandard: 'Std',
        levelStrong: 'Strong',
        levelOffWhat: 'Off: no limits. Reasoning effort follows your model-menu choice, web search stays on, answers are uncapped.',
        levelLightWhat: 'Light: reasoning effort defaults to low; web search defaults to allowed; answers uncapped; one “be brief, do not over-search” instruction.',
        levelStandardWhat: 'Std (recommended): reasoning effort defaults to low; web search defaults to disabled (and hidden from the model); answers uncapped, brevity comes from the instruction only.',
        levelStrongWhat: 'Strong: reasoning off by default; web search disabled by default; strictest brevity wording (aim under ~120 words); answers still uncapped.',
        levelDefaultsNote: 'A level only supplies defaults: the switches below win whenever they are not on “auto” (reasoning effort, web search), and the subagent switch is independent of the level entirely.',
        whatTitle: 'What each level does',
        effortTitle: 'Reasoning effort (overrides the level)',
        effortAuto: 'auto',
        effortOff: 'off',
        effortLow: 'low',
        effortHigh: 'high',
        effortMax: 'max',
        effortAutoWhat: 'Decided by the level: light / standard = low, strong = off, off level = the request is never touched.',
        effortOffWhat: 'Thinking disabled entirely — the fastest.',
        effortLowWhat: 'Light reasoning: a little for hard tasks, almost none for simple ones.',
        effortHighWhat: "The model's high effort, above the levels — pick it only when you really want deliberation.",
        effortMaxWhat: 'Maximum effort: slowest and most expensive, for genuinely hard problems only.',
        effortReset: 'Note: clicking a level resets this to “Follow level”; pick a level first, then an effort, to pin one.',
        effortCurrent: 'now',
        subagentTitle: 'Subagents',
        subagentAllow: 'allow',
        subagentDeny: 'disabled',
        subagentWhatAllow: 'Subagents allowed: the model may use subagent / subagent_fork / spawn_teammate / workflow.',
        subagentWhatDeny: 'Subagents disabled: those four tools are hidden from the model, so it must do the work in this session (cheaper and calmer, but no parallel fan-out).',
        subagentHint: 'One click switches subagents off (hides the subagent / workflow tools from the model).',
        searchTitle: 'Web search',
        searchAllow: 'allowed',
        searchDeny: 'disabled',
        searchAuto: 'Follow level',
        searchWhatAuto: 'Decided by the level: off / light allow search, standard / strong disable it.',
        searchWhatAllow: 'Web search allowed: web_search / web_fetch are available when the answer needs current facts.',
        searchWhatDeny: 'Web search disabled: both tools are hidden from the model and blocked at call time; it will say it cannot look things up instead of guessing.',
        searchHint: 'One click switches web search on or off (web_search / web_fetch).',
        searchCurrent: 'now',
        searchFromLevel: 'from the level',
        searchByYou: 'your choice',
        nav: 'Terse mode',
        sectionIntro: 'The same settings as the conversation-header control: changes here apply immediately, in either place.',
        effectiveTitle: 'Currently in effect',
        think: 'effort',
        cap: 'answer cap',
        unlimited: 'unlimited',
        search: 'web search',
        searchOn: 'allowed',
        searchOff: 'disabled',
        instruction: 'prompt instruction',
        on: 'yes',
        none: 'no',
        unchanged: 'follows the model menu',
        settingsTitle: 'Where to change it',
        setting1: 'Fine-grained knobs (effort / cap / search / custom instruction): cordis.patch.yml in the plugin directory, or override row id: terse-mode in your profile cordis.patch.yml.',
        setting2: 'The level chosen here is stored separately in $DSH_HOME/storages/dsh-terse-mode/level.json and wins over the patch; delete that file to fall back.',
        setting3: 'Switching a level or editing config applies immediately; editing plugin code (index.js / lib / client.js) needs one DSH restart.',
        capNote: 'A level is a ceiling, never a raise: a higher model-menu choice is still capped. Applies to every session, subagents included. No level caps output length.',
        help: 'Help and settings',
        close: 'Close',
        offline: 'host not connected',
        offlineHint: 'The panel cannot reach the host: its host half is still the old module. Restart DeepSeek Harness once.',
        cause: 'Error',
        retry: 'Retry',
        saving: 'Switching…',
      },
    }

    /** The host locale service, when this client tree has one. */
    let hostTranslate
    const builtIn = () => ((typeof navigator === 'object' && /^zh/i.test(navigator.language ?? '')) ? DICTIONARIES.zh : DICTIONARIES.en)
    const t = (key) => {
      try {
        const value = hostTranslate?.(key)
        if (typeof value === 'string' && value.length > 0) return value
      } catch { /* fall back to the built-in dictionary */ }
      return builtIn()[key] ?? key
    }

    const LEVEL_LABEL = { off: 'levelOff', light: 'levelLight', standard: 'levelStandard', strong: 'levelStrong' }
    const LEVEL_WHAT = { off: 'levelOffWhat', light: 'levelLightWhat', standard: 'levelStandardWhat', strong: 'levelStrongWhat' }
    const labelOf = (level) => t(LEVEL_LABEL[level] ?? level)

    /** The reasoning-effort pills: [value, labelKey, explanationKey]. */
    const EFFORT_CHOICES = [
      ['auto', 'effortAuto', 'effortAutoWhat'],
      ['off', 'effortOff', 'effortOffWhat'],
      ['low', 'effortLow', 'effortLowWhat'],
      ['high', 'effortHigh', 'effortHighWhat'],
      ['max', 'effortMax', 'effortMaxWhat'],
    ]

    /**
     * Where the host answers, in the order worth trying.
     *
     * The Desktop window is `dsh-app://app/`, but its injected `<base>` points
     * at the host's http origin — so anything derived from the base is a
     * *cross-origin* request from the page and dies as "Failed to fetch" (the
     * host adds no CORS headers). The page's own origin is same-origin, and the
     * shell's protocol handler forwards those requests to the host with the
     * session cookie, which is the lane built for exactly this.
     */
    function apiCandidates() {
      const urls = []
      try {
        if (location?.origin) urls.push(new URL(`/${API_PATH}`, location.origin).toString())
      } catch { /* opaque origin */ }
      try {
        urls.push(new URL(API_PATH, document.baseURI).toString())
      } catch { /* fall through */ }
      // The page transport's origin, for a shell that serves nothing but a
      // static document and expects an absolute host URL.
      const transport = globalThis.__DSH_TRANSPORT__
      const streamBaseUrl = transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : undefined
      if (streamBaseUrl !== undefined) {
        try { urls.push(new URL(`/${API_PATH}`, streamBaseUrl).toString()) } catch { /* malformed transport */ }
      }
      urls.push(`/${API_PATH}`)
      return [...new Set(urls)]
    }

    /** The page environment, so a failure line says what was tried from where. */
    function environment() {
      let origin = '?'
      let base = '?'
      try { origin = location?.origin ?? '?' } catch { /* opaque */ }
      try { base = document.baseURI } catch { /* opaque */ }
      return `origin=${origin} base=${base}`
    }

    /** The candidate that last answered; tried first from then on. */
    let activeUrl
    /** Which verb answered: the panel posts (see `readState`) once that works. */
    let readsByPost = false

    /** One request to one URL; returns the parsed body or throws. */
    const once = async (url, init) => {
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...init,
      })
      const text = await response.text()
      let body
      try {
        body = text.length === 0 ? undefined : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status} (non-JSON body)`)
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}${body?.error ? ` ${body.error}` : ''}`)
      if (body === undefined) throw new Error('HTTP 200 with an empty body')
      return body
    }

    /**
     * Read the host state.
     *
     * The Desktop shell's request forwarder is unreliable for GET — its body
     * handling rejects a GET — while POSTs arrive normally, so an empty POST is
     * tried first once we know that lane works. GET stays as the fallback for a
     * plain Web mount where the opposite is true.
     */
    const readState = async () => {
      const candidates = apiCandidates()
      const order = activeUrl === undefined ? candidates : [activeUrl, ...candidates.filter((url) => url !== activeUrl)]
      const failures = []
      const attempts = readsByPost
        ? order.map((url) => [url, { method: 'POST', body: '{}' }])
        : [...order.map((url) => [url, undefined]), ...order.map((url) => [url, { method: 'POST', body: '{}' }])]
      for (const [url, init] of attempts) {
        try {
          const body = await once(url, init)
          activeUrl = url
          readsByPost = init !== undefined
          return body
        } catch (error) {
          failures.push(`${init === undefined ? 'GET' : 'POST'} ${url} → ${error?.message ?? error}`)
        }
      }
      throw new Error(failures.join(' | '))
    }

    const fetchState = async (init) => {
      if (init?.method === 'POST') {
        const candidates = apiCandidates()
        const order = activeUrl === undefined ? candidates : [activeUrl, ...candidates.filter((url) => url !== activeUrl)]
        const failures = []
        for (const url of order) {
          try {
            const body = await once(url, init)
            activeUrl = url
            return body
          } catch (error) {
            failures.push(`${url} → ${error?.message ?? error}`)
          }
        }
        throw new Error(failures.join(' | '))
      }
      return readState()
    }

    // ---------------------------------------------------------------- store --
    // The header control and the Settings page are two views of one host state,
    // so they share it: one fetch, one retry loop, one in-flight flag, and a
    // change made in either place shows up in the other immediately.
    const store = {
      state: null,
      error: null,
      detail: null,
      busy: false,
      listeners: new Set(),
    }

    const publish = (patch) => {
      Object.assign(store, patch)
      for (const listener of [...store.listeners]) {
        try { listener() } catch { /* a broken view must not stop the others */ }
      }
    }

    /** Read the host state; keeps the real failure reason for diagnostics. */
    const load = async () => {
      try {
        const next = await fetchState()
        publish({ state: next, error: null, detail: null })
        return true
      } catch (failure) {
        publish({ detail: `${environment()} · ${String(failure?.message ?? failure)}`, error: t('offlineHint') })
        return false
      }
    }

    /** POST one change; optimistic, and reverted with a reason on failure. */
    const mutate = async (body, optimistic) => {
      if (store.busy) return
      const previous = store.state
      publish({ busy: true, error: null, state: { ...(store.state ?? {}), ...optimistic } })
      try {
        const next = await fetchState({ method: 'POST', body: JSON.stringify(body) })
        publish({ state: next, error: null, detail: null })
      } catch (failure) {
        publish({ state: previous, detail: `${environment()} · ${String(failure?.message ?? failure)}`, error: t('offlineHint') })
      } finally {
        publish({ busy: false })
      }
    }

    const chooseLevel = (level) => {
      if (store.busy || store.state?.level === level) return
      // The host resets the explicit effort **and** the explicit search choice on
      // a level click, so the optimistic state has to mirror that.
      void mutate({ level }, { level, reasoningChoice: 'auto', searchChoice: 'auto' })
    }

    const chooseEffort = (value) => {
      if (store.busy || store.state?.reasoningChoice === value) return
      void mutate({ reasoningEffort: value }, { reasoningChoice: value })
    }

    /** The web-search switch: `auto` follows the level, `allow`/`deny` are explicit. */
    const chooseSearch = (value) => {
      if (store.busy || (store.state?.searchChoice ?? 'auto') === value) return
      void mutate({ search: value }, { searchChoice: value })
    }

    /** What the search switch currently *means*, explicit choice or level default. */
    const searchState = (state) => (state?.searchChoice && state.searchChoice !== 'auto'
      ? state.searchChoice
      : (state?.effective?.search ?? 'deny'))

    const chooseSubagents = (value) => {
      if (store.busy || (store.state?.subagents ?? 'allow') === value) return
      void mutate({ subagents: value }, { subagents: value })
    }

    /**
     * Views subscribe here. The first subscriber starts the retry loop: a
     * failure backs off (2s, 5s, 15s, 30s) and every window focus re-reads, so a
     * panel that mounted before its host was ready heals itself.
     */
    let retries = 0
    let retryTimer
    const kick = () => {
      if (store.listeners.size === 0) return
      void (async () => {
        const ok = await load()
        if (ok || retries >= 4) {
          retries = 0
          return
        }
        const delays = [2000, 5000, 15000, 30000]
        const delay = delays[Math.min(retries, delays.length - 1)]
        retries += 1
        retryTimer = setTimeout(kick, delay)
        // A browser timer is a number; Node's is an object. Unref'ing keeps the
        // smoke test's process from being held open by a 30s retry.
        retryTimer?.unref?.()
      })()
    }

    const onFocus = () => { if (store.listeners.size > 0) void load() }
    const onVisibility = () => { if (!document.hidden && store.listeners.size > 0) void load() }
    let watching = false
    const watch = () => {
      if (watching) return
      watching = true
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
    }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        watch()
        store.listeners.add(force)
        if (store.state === null && store.error === null) kick()
        return () => {
          store.listeners.delete(force)
          if (store.listeners.size === 0) {
            clearTimeout(retryTimer)
            retries = 0
          }
        }
      }, [])
      return store
    }

    const TOKEN = {
      label: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8b93a1)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      layer1: 'var(--dsw-alias-bg-layer-1, #fff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      brand: 'var(--dsw-alias-brand-primary, #4f6ef7)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
      shadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(31,35,40,.16))',
    }

    function TerseModeControl() {
      const { state, error, detail, busy } = useStore()
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const box = React.useRef(null)
      const helpButton = React.useRef(null)

      // The popover is positioned from the button's viewport rect, because the
      // header row is not ours to restyle and a clipped absolute box would hide
      // the very explanations this control exists to show.
      React.useEffect(() => {
        if (!open) {
          setAnchor(null)
          return undefined
        }
        const update = () => {
          const rect = helpButton.current?.getBoundingClientRect()
          if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [open])

      // Dismiss the popover the way a menu should.
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => { if (!box.current?.contains(event.target)) setOpen(false) }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      /** POST one change; optimistic, and reverted with a reason on failure. */
      const post = mutate

      const choose = chooseLevel

      const chooseEffort = (value) => {
        if (busy || state?.reasoningChoice === value) return
        void post({ reasoningEffort: value }, { reasoningChoice: value })
      }

      const toggleSubagents = () => {
        const next = (state?.subagents ?? 'allow') === 'deny' ? 'allow' : 'deny'
        if (busy) return
        void post({ subagents: next }, { subagents: next })
      }

      /** The header switch flips the effective state and makes it explicit. */
      const toggleSearch = () => {
        if (busy) return
        const next = searchState(state) === 'deny' ? 'allow' : 'deny'
        void post({ search: next }, { searchChoice: next })
      }

      const levels = state?.levels ?? LEVELS
      const effective = state?.effective
      const effortText = effective
        ? (effective.reasoningEffort ? labelOf(effective.reasoningEffort) : t('unchanged'))
        : t('unchanged')
      const searchText = effective?.search === 'deny' ? t('searchOff') : t('searchOn')
      const searchNow = searchState(state)
      const searchChoiceNow = state?.searchChoice ?? 'auto'
      const summary = effective
        ? `${t('think')} ${effortText} · ${t('cap')} ${effective.maxTokens ?? t('unlimited')} · ${t('search')} ${searchText}`
        : ''

      const segment = (level) => {
        const on = state?.level === level
        return h('button', {
          key: level,
          type: 'button',
          'aria-pressed': on ? 'true' : 'false',
          disabled: busy,
          onClick: () => choose(level),
          // Every level explains itself on hover.
          title: t(LEVEL_WHAT[level] ?? level),
          'data-level': level,
          style: {
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '20px',
            padding: '1px 8px',
            border: 'none',
            borderRadius: '6px',
            cursor: busy ? 'default' : 'pointer',
            background: on ? TOKEN.layer1 : 'transparent',
            color: on ? TOKEN.label : TOKEN.secondary,
            fontWeight: on ? 600 : 400,
            boxShadow: on ? 'var(--dsw-shadow-lv1, 0 1px 2px rgba(31,35,40,.12))' : 'none',
            transition: 'background .12s ease,color .12s ease',
          },
        }, labelOf(level))
      }

      const whatRow = (level) => {
        const on = state?.level === level
        return h('div', {
          key: level,
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            padding: '5px 8px',
            borderRadius: '8px',
            background: on ? TOKEN.layer2 : 'transparent',
          },
        }, [
          h('span', {
            key: 'name',
            style: {
              flexShrink: 0,
              minWidth: '36px',
              fontWeight: on ? 600 : 500,
              color: on ? TOKEN.label : TOKEN.secondary,
            },
          }, labelOf(level)),
          h('span', { key: 'what', style: { color: TOKEN.secondary } }, t(LEVEL_WHAT[level] ?? level)),
        ])
      }

      const detailRow = (label, value) => h('div', {
        key: label,
        style: { display: 'flex', gap: '8px', justifyContent: 'space-between', padding: '1px 0' },
      }, [
        h('span', { key: 'k', style: { color: TOKEN.tertiary } }, label),
        h('span', { key: 'v', style: { color: TOKEN.label } }, value),
      ])

      const retryButton = (key) => h('button', {
        key,
        type: 'button',
        onClick: () => { void load() },
        style: {
          marginTop: '6px',
          border: `1px solid ${TOKEN.border}`,
          background: 'transparent',
          color: TOKEN.label,
          borderRadius: '6px',
          padding: '2px 8px',
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        },
      }, t('retry'))

      const popover = open && anchor !== null ? h('div', {
        key: 'popover',
        role: 'dialog',
        'aria-label': t('help'),
        style: {
          position: 'fixed',
          top: `${anchor.top}px`,
          right: `${anchor.right}px`,
          zIndex: 60,
          width: 'min(388px, 86vw)',
          maxHeight: 'min(70vh, 520px)',
          overflowY: 'auto',
          padding: '10px 12px',
          borderRadius: '10px',
          border: `1px solid ${TOKEN.border}`,
          background: TOKEN.layer1,
          boxShadow: TOKEN.shadow,
          color: TOKEN.label,
          fontSize: '12px',
          lineHeight: '18px',
          textAlign: 'left',
          cursor: 'default',
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
        }, [
          h('strong', { key: 'title', style: { flex: 1, fontSize: '13px' } }, `${t('label')} · ${t('whatTitle')}`),
          h('button', {
            key: 'close',
            type: 'button',
            'aria-label': t('close'),
            onClick: () => setOpen(false),
            style: {
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: TOKEN.tertiary,
              font: 'inherit',
              fontSize: '14px',
              lineHeight: '16px',
              padding: '0 2px',
            },
          }, '×'),
        ]),
        ...levels.map(whatRow),
        h('div', { key: 'defaults', style: { color: TOKEN.tertiary, marginTop: '6px' } }, t('levelDefaultsNote')),
        h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '4px' } }, t('capNote')),
        h('div', {
          key: 'effortSection',
          style: { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${TOKEN.border}` },
        }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '4px' } }, t('effortTitle')),
          h('div', {
            key: 'pills',
            role: 'group',
            'aria-label': t('effortTitle'),
            style: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
          }, EFFORT_CHOICES.map(([value, labelKey, whatKey]) => {
            const on = (state?.reasoningChoice ?? 'auto') === value
            return h('button', {
              key: value,
              type: 'button',
              'aria-pressed': on ? 'true' : 'false',
              disabled: busy,
              title: t(whatKey),
              'data-effort': value,
              onClick: () => chooseEffort(value),
              style: {
                font: 'inherit',
                fontSize: '12px',
                lineHeight: '18px',
                padding: '2px 9px',
                borderRadius: '999px',
                cursor: busy ? 'default' : 'pointer',
                border: `1px solid ${on ? TOKEN.brand : TOKEN.border}`,
                background: on ? TOKEN.layer2 : 'transparent',
                color: on ? TOKEN.brand : TOKEN.secondary,
                fontWeight: on ? 600 : 400,
              },
            }, t(labelKey))
          })),
          h('div', { key: 'now', style: { color: TOKEN.tertiary, marginTop: '4px' } }, `${t('effortCurrent')}: ${effortText}`),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '2px' } }, t('effortReset')),
        ]),
        h('div', {
          key: 'subagentSection',
          style: { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${TOKEN.border}` },
        }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '4px' } }, t('subagentTitle')),
          h('div', { key: 'pills', style: { display: 'flex', gap: '4px' } }, ['allow', 'deny'].map((value) => {
            const on = (state?.subagents ?? 'allow') === value
            return h('button', {
              key: value,
              type: 'button',
              'aria-pressed': on ? 'true' : 'false',
              disabled: busy,
              title: t(value === 'deny' ? 'subagentWhatDeny' : 'subagentWhatAllow'),
              'data-subagents': value,
              onClick: () => { void post({ subagents: value }, { subagents: value }) },
              style: {
                font: 'inherit',
                fontSize: '12px',
                lineHeight: '18px',
                padding: '2px 9px',
                borderRadius: '999px',
                cursor: busy ? 'default' : 'pointer',
                border: `1px solid ${on ? (value === 'deny' ? TOKEN.error : TOKEN.brand) : TOKEN.border}`,
                background: on ? TOKEN.layer2 : 'transparent',
                color: on ? (value === 'deny' ? TOKEN.error : TOKEN.brand) : TOKEN.secondary,
                fontWeight: on ? 600 : 400,
              },
            }, t(value === 'deny' ? 'subagentDeny' : 'subagentAllow'))
          })),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '4px' } }, t((state?.subagents ?? 'allow') === 'deny' ? 'subagentWhatDeny' : 'subagentWhatAllow')),
        ]),
        h('div', {
          key: 'searchSection',
          style: { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${TOKEN.border}` },
        }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '4px' } }, t('searchTitle')),
          h('div', { key: 'pills', style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, ['auto', 'allow', 'deny'].map((value) => {
            const on = searchChoiceNow === value
            const accent = value === 'deny' ? TOKEN.error : TOKEN.brand
            return h('button', {
              key: value,
              type: 'button',
              'aria-pressed': on ? 'true' : 'false',
              disabled: busy,
              title: t(value === 'auto' ? 'searchWhatAuto' : (value === 'deny' ? 'searchWhatDeny' : 'searchWhatAllow')),
              'data-search-choice': value,
              onClick: () => { if (busy) return; void post({ search: value }, { searchChoice: value }) },
              style: {
                font: 'inherit',
                fontSize: '12px',
                lineHeight: '18px',
                padding: '2px 9px',
                borderRadius: '999px',
                cursor: busy ? 'default' : 'pointer',
                border: `1px solid ${on ? accent : TOKEN.border}`,
                background: on ? TOKEN.layer2 : 'transparent',
                color: on ? accent : TOKEN.secondary,
                fontWeight: on ? 600 : 400,
              },
            }, t(value === 'auto' ? 'searchAuto' : (value === 'deny' ? 'searchDeny' : 'searchAllow')))
          })),
          h('div', { key: 'now', style: { color: TOKEN.tertiary, marginTop: '4px' } },
            `${t('searchCurrent')}: ${searchText}（${t(searchChoiceNow === 'auto' ? 'searchFromLevel' : 'searchByYou')}）`),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '2px' } }, t(searchChoiceNow === 'auto' ? 'searchWhatAuto' : (searchNow === 'deny' ? 'searchWhatDeny' : 'searchWhatAllow'))),
        ]),
        h('div', {
          key: 'effective',
          style: { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${TOKEN.border}` },
        }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '2px' } }, t('effectiveTitle')),
          ...(effective ? [
            detailRow(t('think'), effortText),
            detailRow(t('cap'), effective.maxTokens === null || effective.maxTokens === undefined ? t('unlimited') : String(effective.maxTokens)),
            detailRow(t('search'), searchText),
            detailRow(t('instruction'), effective.instruction ? t('on') : t('none')),
          ] : [
            h('div', { key: 'none', style: { color: TOKEN.error } }, error ?? t('offline')),
            detail
              ? h('div', { key: 'detail', style: { color: TOKEN.tertiary, marginTop: '2px', wordBreak: 'break-all' } }, `${t('cause')}: ${detail}`)
              : null,
            retryButton('retry'),
          ]),
        ]),
        h('div', {
          key: 'settings',
          style: { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${TOKEN.border}` },
        }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '2px' } }, t('settingsTitle')),
          h('div', { key: 's1', style: { color: TOKEN.secondary, marginBottom: '4px' } }, t('setting1')),
          h('div', { key: 's2', style: { color: TOKEN.secondary, marginBottom: '4px' } }, t('setting2')),
          h('div', { key: 's3', style: { color: TOKEN.secondary } }, t('setting3')),
        ]),
      ]) : null

      return h('div', {
        ref: box,
        'data-plugin': 'dsh-terse-mode',
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          lineHeight: '20px',
          color: TOKEN.secondary,
          whiteSpace: 'nowrap',
        },
      }, [
        h('span', { key: 'label', title: t('labelHint'), style: { color: TOKEN.tertiary, cursor: 'help' } }, t('label')),
        h('span', {
          key: 'segments',
          role: 'group',
          'aria-label': t('label'),
          style: {
            display: 'inline-flex',
            gap: '2px',
            padding: '1px',
            border: `1px solid ${TOKEN.border}`,
            borderRadius: '8px',
            background: TOKEN.layer2,
          },
        }, levels.map(segment)),
        // One click toggles the subagent lane: hiding the four creation tools is
        // the difference between "the agent delegates everything" and "it does
        // the work here".
        h('button', {
          key: 'subagents',
          type: 'button',
          'aria-pressed': (state?.subagents ?? 'allow') === 'deny' ? 'true' : 'false',
          disabled: busy,
          title: t((state?.subagents ?? 'allow') === 'deny' ? 'subagentWhatDeny' : 'subagentWhatAllow'),
          'data-subagents': state?.subagents ?? 'allow',
          onClick: () => toggleSubagents(),
          style: {
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '1px 7px',
            borderRadius: '999px',
            cursor: busy ? 'default' : 'pointer',
            border: `1px solid ${(state?.subagents ?? 'allow') === 'deny' ? TOKEN.error : TOKEN.border}`,
            background: 'transparent',
            color: (state?.subagents ?? 'allow') === 'deny' ? TOKEN.error : TOKEN.tertiary,
            whiteSpace: 'nowrap',
          },
        }, (state?.subagents ?? 'allow') === 'deny' ? `${t('subagentTitle')}·${t('subagentDeny')}` : t('subagentTitle')),
        // The web-search switch: same one-click shape, and it shows the
        // *effective* state even while the level is what decides.
        h('button', {
          key: 'search',
          type: 'button',
          'aria-pressed': searchNow === 'deny' ? 'true' : 'false',
          disabled: busy,
          title: t(searchChoiceNow === 'auto' ? 'searchWhatAuto' : (searchNow === 'deny' ? 'searchWhatDeny' : 'searchWhatAllow')),
          'data-search': searchNow,
          'data-search-choice': searchChoiceNow,
          onClick: () => toggleSearch(),
          style: {
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '18px',
            padding: '1px 7px',
            borderRadius: '999px',
            cursor: busy ? 'default' : 'pointer',
            border: `1px solid ${searchNow === 'deny' ? TOKEN.error : TOKEN.border}`,
            background: 'transparent',
            color: searchNow === 'deny' ? TOKEN.error : TOKEN.tertiary,
            whiteSpace: 'nowrap',
          },
        }, searchNow === 'deny' ? `${t('searchTitle')}·${t('searchDeny')}` : t('searchTitle')),
        h('button', {
          key: 'help',
          ref: helpButton,
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': t('help'),
          title: error ?? (busy ? t('saving') : (summary || t('help'))),
          onClick: () => setOpen((was) => !was),
          style: {
            border: `1px solid ${open ? TOKEN.brand : TOKEN.border}`,
            background: open ? TOKEN.layer2 : 'transparent',
            color: open ? TOKEN.brand : TOKEN.secondary,
            borderRadius: '999px',
            width: '18px',
            height: '18px',
            lineHeight: '16px',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '12px',
            fontWeight: 700,
            flexShrink: 0,
          },
        }, '?'),
        error ? h('span', {
          key: 'error',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 },
        }, [
          h('button', {
            key: 'retry',
            type: 'button',
            role: 'status',
            // Clicking it retries, so a stale failure is one gesture to clear.
            title: `${error}${detail ? ` [${detail}]` : ''}`,
            onClick: () => { void load() },
            style: {
              color: TOKEN.error,
              background: 'transparent',
              border: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: '12px',
              lineHeight: '20px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              textDecoration: 'underline dotted',
            },
          }, `${t('offline')} · ${t('retry')}`),
          // The raw reason stays on screen: without it the only way to tell a
          // blocked fetch from a 404 is a devtools session. Show the HEAD of the
          // text (it starts with the environment and the first URL tried) —
          // right-to-left truncation would hide exactly the useful part.
          detail ? h('span', {
            key: 'why',
            title: detail,
            style: {
              color: TOKEN.tertiary,
              fontSize: '11px',
              lineHeight: '14px',
              maxWidth: '460px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              textAlign: 'left',
            },
          }, detail) : null,
        ]) : null,
        popover,
      ])
    }

    // ------------------------------------------------------- settings page --
    /**
     * The Settings section: the same three controls in a roomy form, plus what
     * each level does and where the values live.
     */
    function TerseModeSettings() {
      const { state, error, detail, busy } = useStore()
      const effective = state?.effective
      const effortText = effective
        ? (effective.reasoningEffort ? labelOf(effective.reasoningEffort) : t('unchanged'))
        : t('unchanged')
      const searchText = effective?.search === 'deny' ? t('searchOff') : t('searchOn')
      // The search switch's current *meaning*, and whether it is explicit. Both
      // must be computed here as well as in the header control: the Settings
      // section renders from the same state, and referencing the header's locals
      // threw a ReferenceError that the Settings shell swallowed as a blank page.
      const searchNow = searchState(state)
      const searchChoiceNow = state?.searchChoice ?? 'auto'

      const bigPill = (key, label, active, onClick, title, accent) => h('button', {
        key,
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        disabled: busy,
        title,
        onClick,
        style: {
          font: 'inherit',
          fontSize: '13px',
          lineHeight: '26px',
          padding: '0 14px',
          borderRadius: '8px',
          cursor: busy ? 'default' : 'pointer',
          border: `1px solid ${active ? (accent ?? TOKEN.brand) : TOKEN.border}`,
          background: active ? TOKEN.layer2 : 'transparent',
          color: active ? (accent ?? TOKEN.brand) : TOKEN.secondary,
          fontWeight: active ? 600 : 400,
        },
      }, label)

      const row = (label, value) => h('div', {
        key: label,
        style: { display: 'flex', gap: '10px', justifyContent: 'space-between', maxWidth: '420px', padding: '2px 0' },
      }, [
        h('span', { key: 'k', style: { color: TOKEN.tertiary } }, label),
        h('span', { key: 'v', style: { color: TOKEN.label } }, value),
      ])

      return h('div', {
        'data-plugin': 'dsh-terse-mode-settings',
        style: { color: TOKEN.label, fontSize: '13px', lineHeight: '20px' },
      }, [
        h('div', { key: 'title', style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, t('nav')),
        h('div', { key: 'intro', style: { color: TOKEN.secondary, marginBottom: '12px' } }, t('sectionIntro')),

        h('div', { key: 'levels', style: { marginBottom: '14px' } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '6px' } }, t('whatTitle')),
          h('div', { key: 'pills', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, (state?.levels ?? LEVELS).map((level) => bigPill(
            level,
            labelOf(level),
            state?.level === level,
            () => chooseLevel(level),
            t(LEVEL_WHAT[level] ?? level),
          ))),
          h('div', { key: 'list', style: { marginTop: '8px' } }, (state?.levels ?? LEVELS).map((level) => h('div', {
            key: level,
            style: {
              display: 'flex',
              gap: '10px',
              padding: '4px 8px',
              borderRadius: '8px',
              background: state?.level === level ? TOKEN.layer2 : 'transparent',
            },
          }, [
            h('span', { key: 'n', style: { minWidth: '48px', color: state?.level === level ? TOKEN.label : TOKEN.secondary, fontWeight: state?.level === level ? 600 : 400 } }, labelOf(level)),
            h('span', { key: 'w', style: { color: TOKEN.secondary } }, t(LEVEL_WHAT[level] ?? level)),
          ]))),
          h('div', { key: 'defaults', style: { color: TOKEN.tertiary, marginTop: '6px', maxWidth: '620px' } }, t('levelDefaultsNote')),
        ]),

        h('div', { key: 'effort', style: { marginBottom: '14px', paddingTop: '12px', borderTop: `1px solid ${TOKEN.border}` } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '6px' } }, t('effortTitle')),
          h('div', { key: 'pills', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, EFFORT_CHOICES.map(([value, labelKey, whatKey]) => bigPill(
            value,
            t(labelKey),
            (state?.reasoningChoice ?? 'auto') === value,
            () => chooseEffort(value),
            t(whatKey),
          ))),
          h('div', { key: 'now', style: { color: TOKEN.tertiary, marginTop: '6px' } }, `${t('effortCurrent')}: ${effortText}`),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '2px' } }, t('effortReset')),
        ]),

        h('div', { key: 'subagents', style: { marginBottom: '14px', paddingTop: '12px', borderTop: `1px solid ${TOKEN.border}` } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '6px' } }, t('subagentTitle')),
          h('div', { key: 'pills', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, [
            bigPill('allow', t('subagentAllow'), (state?.subagents ?? 'allow') === 'allow', () => chooseSubagents('allow'), t('subagentWhatAllow')),
            bigPill('deny', t('subagentDeny'), (state?.subagents ?? 'allow') === 'deny', () => chooseSubagents('deny'), t('subagentWhatDeny'), TOKEN.error),
          ]),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '6px' } }, t((state?.subagents ?? 'allow') === 'deny' ? 'subagentWhatDeny' : 'subagentWhatAllow')),
        ]),

        h('div', { key: 'search', style: { marginBottom: '14px', paddingTop: '12px', borderTop: `1px solid ${TOKEN.border}` } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '6px' } }, t('searchTitle')),
          h('div', { key: 'pills', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } }, [
            bigPill('auto', t('searchAuto'), searchChoiceNow === 'auto', () => chooseSearch('auto'), t('searchWhatAuto')),
            bigPill('allow', t('searchAllow'), searchChoiceNow === 'allow', () => chooseSearch('allow'), t('searchWhatAllow')),
            bigPill('deny', t('searchDeny'), searchChoiceNow === 'deny', () => chooseSearch('deny'), t('searchWhatDeny'), TOKEN.error),
          ]),
          h('div', { key: 'now', style: { color: TOKEN.tertiary, marginTop: '6px' } },
            `${t('searchCurrent')}: ${searchText}（${t(searchChoiceNow === 'auto' ? 'searchFromLevel' : 'searchByYou')}）`),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '2px' } }, t(searchChoiceNow === 'auto' ? 'searchWhatAuto' : (searchNow === 'deny' ? 'searchWhatDeny' : 'searchWhatAllow'))),
        ]),

        h('div', { key: 'effective', style: { paddingTop: '12px', borderTop: `1px solid ${TOKEN.border}` } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '4px' } }, t('effectiveTitle')),
          ...(effective ? [
            row(t('think'), effortText),
            row(t('cap'), effective.maxTokens === null || effective.maxTokens === undefined ? t('unlimited') : String(effective.maxTokens)),
            row(t('search'), searchText),
            row(t('instruction'), effective.instruction ? t('on') : t('none')),
          ] : [
            h('div', { key: 'none', style: { color: TOKEN.error } }, error ?? t('offline')),
            detail ? h('div', { key: 'detail', style: { color: TOKEN.tertiary, marginTop: '2px', wordBreak: 'break-all' } }, `${t('cause')}: ${detail}`) : null,
            h('button', {
              key: 'retry',
              type: 'button',
              onClick: () => { void load() },
              style: {
                marginTop: '6px',
                border: `1px solid ${TOKEN.border}`,
                background: 'transparent',
                color: TOKEN.label,
                borderRadius: '6px',
                padding: '2px 10px',
                font: 'inherit',
                fontSize: '12px',
                cursor: 'pointer',
              },
            }, t('retry')),
          ]),
        ]),

        h('div', { key: 'where', style: { marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${TOKEN.border}` } }, [
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginBottom: '4px' } }, t('settingsTitle')),
          h('div', { key: 's1', style: { color: TOKEN.secondary, marginBottom: '4px', maxWidth: '620px' } }, t('setting1')),
          h('div', { key: 's2', style: { color: TOKEN.secondary, marginBottom: '4px', maxWidth: '620px' } }, t('setting2')),
          h('div', { key: 's3', style: { color: TOKEN.secondary, maxWidth: '620px' } }, t('setting3')),
          h('div', { key: 'note', style: { color: TOKEN.tertiary, marginTop: '6px', maxWidth: '620px' } }, t('capNote')),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Optional: the host's locale service, when this client tree has one.
        try {
          ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-terse-mode:locale')
          const bound = ctx.locale.bind(NS)
          hostTranslate = (key) => bound(key)
        } catch { /* the built-in two-language dictionary still covers the UI */ }

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'terse-mode',
          order: 20,
        }, TerseModeControl))

        // The Settings page: same state, roomier form. `settings.section` is the
        // ledger the shipped Settings shell projects into its navigation.
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'terse-mode',
            order: 40,
            label: () => t('nav'),
            locale: NS,
          }, TerseModeSettings))
        } catch { /* a build without the Settings shell still gets the header control */ }
      },
    }
  },
})
