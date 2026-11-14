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
    // react-dom lives in the same browser module table the plugin market uses.
    // Look it up softly: a host build that cannot resolve it keeps the inline
    // popover rather than losing the whole control.
    const ReactDOM = (() => {
      try { return require('react-dom') } catch { return null }
    })()

    const NS = 'dsh-terse-mode'
    const SLOT = 'conversation.session.header.actions'
    /** Lets the trigger point at the popover (`aria-controls`). */
    const POPOVER_ID = 'dsh-terse-mode-popover'
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
        effortNone: 'none',
        effortOff: 'off',
        effortLow: 'low',
        effortHigh: 'high',
        effortMax: 'max',
        effortAutoWhat: '由当前档位决定：轻 / 标准 = 低，强 = 关，关（档位）= 完全不碰请求。',
        effortNoneWhat: '完全不碰请求的思考参数：发什么由模型菜单决定，插件不改。',
        effortOffWhat: '完全关闭思考（thinking 关掉），响应最快。',
        effortLowWhat: '轻量思考：复杂任务保留一点推理，简单问题几乎不想。',
        effortHighWhat: '比档位更高的强思考——只有确实需要深思的任务才选。',
        effortMaxWhat: '最大强度，最慢也最贵，只留给真正难的问题。',
        subagentTitle: '子代理',
        subagentAllow: '允许',
        subagentDeny: '禁用',
        subagentWhatAllow: '允许派出子代理：subagent / subagent_fork / spawn_teammate / workflow 四个工具模型都能用。',
        subagentWhatDeny: '禁用子代理：这四个工具从模型眼前隐藏，模型必须自己在当前会话干完（更省 token、更难失控，但大任务不能再并行）。',
        searchTitle: '联网搜索',
        searchAllow: '允许',
        searchDeny: '禁止',
        searchAuto: '跟随档位',
        searchWhatAuto: '由当前档位决定：关 / 轻 允许联网，标准 / 强 禁止。',
        searchWhatAllow: '允许联网搜索：web_search / web_fetch 可用，需要现成事实时模型能去查。',
        searchWhatDeny: '禁止联网搜索：这两个工具从模型眼前隐藏，运行期也硬拦；需要外部事实时它会说明，而不是硬猜。',
        nav: '简洁模式',
        sectionIntro: '这里和对话页顶部的小控件是同一份设置，改哪边都会立刻生效（不分先后）。',
        effectiveTitle: '当前实际生效',
        effectiveUnknown: '暂无生效数据',
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
        levelUnknown: '未知档位',
        setting1: '细项（思考强度 / 上限 / 是否允许搜索 / 自定义提示词）：插件目录里的 cordis.patch.yml，或在 profile 的 cordis.patch.yml 里按 id: terse-mode 覆盖。',
        setting2: '面板选的档位单独记在 $DSH_HOME/storages/dsh-terse-mode/level.json，优先于 patch；删掉它即回到 patch 的档位。',
        setting3: '点档位或改配置立即生效；改插件代码（index.js / lib / client.js）要重启一次 DSH。',
        capNote: '档位是上限、只降不升：即便你在模型菜单里选得更高，也会被压到档位值。对所有会话生效，包括子 agent。四个档位都不设输出上限。',
        help: '说明与设置',
        close: '关闭',
        offline: '未连上宿主',
        offlineHint: '面板没连上宿主：宿主半侧还是旧模块，重启一次 DeepSeek Harness 即可。',
        hintForbidden: '宿主拒绝了来源校验：请从 DSH 桌面端或 dsh web 的页面里打开面板。',
        hintNotFound: '宿主没有挂上这条路由：通常是插件刚更新，重启一次 DeepSeek Harness。',
        hintTimeout: '请求超时：宿主可能正忙，稍后重试；持续出现请查看 plugin.log。',
        hintBadBody: '宿主返回的不是状态数据：可能有转发层改写了响应，重启后再看。',
        cause: '原始报错',
        retry: '重试',
        saving: '切换中…',
        // Short one-liners for the level row and the level cards.
        levelOffShort: '完全不介入，跟没装一样',
        levelLightShort: '思考压一档，联网照常，只要求别啰嗦',
        levelStandardShort: '不想太多、不联网、话更少',
        levelStrongShort: '几乎不想、不联网、答案压到最短',
        recommended: '推荐',
        levelsSub: '点一行即可切换',
        adjustTitle: '单独调整',
        adjustSub: '显示当前生效值，右边标明来源',
        subagentLineAllow: '复杂任务可以拆开并行，更花 token',
        subagentLineDeny: '只能在本会话里干完，更省 token',
        searchLineAuto: '由档位决定：关 / 轻 允许，标准 / 强 禁止',
        searchLineAllow: '可以查最新信息，回答会带来源',
        searchLineDeny: '查不到就直说，不会编',
        fromPatch: '配置文件固定',
        fromLevelShort: '档位给的',
        followAgain: '改为跟随档位',
        instrOn: '提示词已注入',
        instrOff: '提示词未生效（见日志）',
        instrByPolicy: '按当前档位不使用提示词',
        toolsHidden: '已隐藏',
        toolsCountUnit: '个工具',
        sessionsLine: '已对 {n} 个会话生效',
        advancedTitle: '高级',
        advancedSub: '改动立即生效',
        capFollow: '跟随档位',
        capCustom: '自定义',
        capHint: '正整数：超过就截断；不限时只由提示词引导',
        instrDefault: '用默认',
        instrSave: '保存',
        instrPlaceholder: '留空则用档位自带的「简短回答」指令',
        allModels: '对所有模型生效',
        allModelsHint: '默认只压 DeepSeek 路由，开启后对其他 provider 也设强度',
        toggleOn: '开',
        toggleOff: '关',
        instrAuto: '默认',
        instrNone: '关闭',
        instrCustomState: '自定义',
        lockedFollow: '此项由 cordis.patch.yml 固定，面板改不回来',
        unknownToolsLine: '这些工具名在本宿主上没找到',
        firstRun: '已默认启用「标准」档：不想太多、不联网、话更短。下面随时可以改，改完立刻生效。',
        fieldCap: '输出上限',
        fieldInstr: '提示词指令',
        fieldHidden: '被隐藏的工具',
        fieldStore: '面板选择存在',
        fieldPatch: '细项写在',
        fieldWhen: '生效时机',
        whenValue: '改配置立即生效，改代码需重启一次',
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
        levelDefaultsNote: 'A level only supplies defaults: anything not on “follow level” stays as you set it, and switching levels does not clear it.',
        whatTitle: 'What each level does',
        effortTitle: 'Reasoning effort (overrides the level)',
        effortAuto: 'auto',
        effortNone: 'none',
        effortOff: 'off',
        effortLow: 'low',
        effortHigh: 'high',
        effortMax: 'max',
        effortAutoWhat: 'Decided by the level: light / standard = low, strong = off, off level = the request is never touched.',
        effortNoneWhat: "Leave the request's reasoning parameter untouched — whatever the model menu sends.",
        effortOffWhat: 'Thinking disabled entirely — the fastest.',
        effortLowWhat: 'Light reasoning: a little for hard tasks, almost none for simple ones.',
        effortHighWhat: "The model's high effort, above the levels — pick it only when you really want deliberation.",
        effortMaxWhat: 'Maximum effort: slowest and most expensive, for genuinely hard problems only.',
        subagentTitle: 'Subagents',
        subagentAllow: 'allow',
        subagentDeny: 'disabled',
        subagentWhatAllow: 'Subagents allowed: the model may use subagent / subagent_fork / spawn_teammate / workflow.',
        subagentWhatDeny: 'Subagents disabled: those four tools are hidden from the model, so it must do the work in this session (cheaper and calmer, but no parallel fan-out).',
        searchTitle: 'Web search',
        searchAllow: 'allowed',
        searchDeny: 'disabled',
        searchAuto: 'Follow level',
        searchWhatAuto: 'Decided by the level: off / light allow search, standard / strong disable it.',
        searchWhatAllow: 'Web search allowed: web_search / web_fetch are available when the answer needs current facts.',
        searchWhatDeny: 'Web search disabled: both tools are hidden from the model and blocked at call time; it will say it cannot look things up instead of guessing.',
        nav: 'Terse mode',
        sectionIntro: 'The same settings as the conversation-header control: changes here apply immediately, in either place.',
        effectiveTitle: 'Currently in effect',
        effectiveUnknown: 'No effective data yet',
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
        levelUnknown: 'unknown level',
        setting1: 'Fine-grained knobs (effort / cap / search / custom instruction): cordis.patch.yml in the plugin directory, or override row id: terse-mode in your profile cordis.patch.yml.',
        setting2: 'The level chosen here is stored separately in $DSH_HOME/storages/dsh-terse-mode/level.json and wins over the patch; delete that file to fall back.',
        setting3: 'Switching a level or editing config applies immediately; editing plugin code (index.js / lib / client.js) needs one DSH restart.',
        capNote: 'A level is a ceiling, never a raise: a higher model-menu choice is still capped. Applies to every session, subagents included. No level caps output length.',
        help: 'Help and settings',
        close: 'Close',
        offline: 'host not connected',
        offlineHint: 'The panel cannot reach the host: its host half is still the old module. Restart DeepSeek Harness once.',
        hintForbidden: 'The host rejected the request origin: open the panel from the desktop app or the dsh web page.',
        hintNotFound: 'The host has no such route yet — usually a fresh plugin update; restart DeepSeek Harness once.',
        hintTimeout: 'The request timed out: the host may be busy. Retry, and check plugin.log if it keeps happening.',
        hintBadBody: 'The host answered with something that is not panel state: a proxy may be rewriting it. Restart and retry.',
        cause: 'Error',
        retry: 'Retry',
        saving: 'Switching…',
        levelOffShort: 'no limits at all, as if it were not installed',
        levelLightShort: 'reasoning one notch down, search stays on, just stop rambling',
        levelStandardShort: 'does not over-think, does not search, says less',
        levelStrongShort: 'barely thinks, no search, shortest answers',
        recommended: 'recommended',
        levelsSub: 'click a row to switch',
        adjustTitle: 'Adjust individually',
        adjustSub: 'shows the value in effect, tagged with its source',
        subagentLineAllow: 'hard tasks can fan out; costs more tokens',
        subagentLineDeny: 'must finish in this session; saves tokens',
        searchLineAuto: 'decided by the level: off / light allow, standard / strong block',
        searchLineAllow: 'can look things up; answers can cite sources',
        searchLineDeny: 'says it cannot look it up instead of guessing',
        fromPatch: 'fixed by config',
        fromLevelShort: 'from the level',
        followAgain: 'follow the level again',
        lockedFollow: 'this one is fixed by cordis.patch.yml — the panel cannot change it back',
        instrOn: 'prompt instruction injected',
        instrOff: 'prompt instruction NOT active (see log)',
        instrByPolicy: 'no prompt instruction at this level',
        toolsHidden: 'hidden',
        toolsCountUnit: 'tools',
        sessionsLine: '{n} sessions affected',
        advancedTitle: 'Advanced',
        advancedSub: 'changes apply immediately',
        capFollow: 'Follow level',
        capCustom: 'Custom',
        capHint: 'a positive integer truncates; unlimited is steered by the prompt only',
        instrDefault: 'Use default',
        instrSave: 'Save',
        instrPlaceholder: 'leave empty to use the level’s own brevity instruction',
        allModels: 'Apply to every model',
        allModelsHint: 'by default only DeepSeek routes are clamped',
        toggleOn: 'on',
        toggleOff: 'off',
        instrAuto: 'level default',
        instrNone: 'disabled',
        instrCustomState: 'custom',
        unknownToolsLine: 'these tool names were not found on this host',
        firstRun: '“Standard” is on by default: less thinking, no web search, shorter answers. Everything below can be changed any time.',
        fieldCap: 'answer cap',
        fieldInstr: 'prompt instruction',
        fieldHidden: 'hidden tools',
        fieldStore: 'panel choice stored in',
        fieldPatch: 'fine-grained knobs in',
        fieldWhen: 'when it applies',
        whenValue: 'config changes apply at once; code changes need a restart',
      },
    }

    /**
     * One-time introduction: the panel has no other way to say "this is on by
     * default, and here is where you change it". Stored per browser profile.
     */
    const FIRST_RUN_KEY = 'dsh-terse-mode:first-run'
    const firstRunPending = () => {
      try { return localStorage.getItem(FIRST_RUN_KEY) !== '1' } catch { return false }
    }
    const markFirstRunDone = () => {
      try { localStorage.setItem(FIRST_RUN_KEY, '1') } catch { /* storage may be unavailable */ }
    }

    /** The host locale service, when this client tree has one. */
    let hostTranslate
    const isChinese = () => typeof navigator === 'object' && /^zh/i.test(navigator.language ?? '')
    const builtIn = () => (isChinese() ? DICTIONARIES.zh : DICTIONARIES.en)
    const t = (key) => {
      try {
        const value = hostTranslate?.(key)
        if (typeof value === 'string' && value.length > 0) return value
      } catch { /* fall back to the built-in dictionary */ }
      return builtIn()[key] ?? key
    }

    const LEVEL_LABEL = { off: 'levelOff', light: 'levelLight', standard: 'levelStandard', strong: 'levelStrong' }
    const LEVEL_WHAT = { off: 'levelOffWhat', light: 'levelLightWhat', standard: 'levelStandardWhat', strong: 'levelStrongWhat' }
    /**
     * An unknown level renders as "unknown", never as its raw value:
     * a host that adds a fifth level would otherwise print `turbo` where the
     * panel shows a name, and the raw value is already in the button's `title`.
     */
    const labelOf = (level) => {
      if (typeof level !== 'string') return t('levelUnknown')
      const key = LEVEL_LABEL[level]
      return key === undefined ? t('levelUnknown') : t(key)
    }

    /**
     * The host's `levels` list, narrowed to the strings React can render.
     *
     * `state?.levels ?? LEVELS` only covered null/undefined: a string reached
     * `.map` and threw, an array of objects hit React's "objects are not valid
     * as a child" — both took the header control and the Settings section down
     * together. Anything unusable falls back to the built-in four levels.
     */
    const asLevels = (value) => {
      const list = Array.isArray(value) ? value.filter((level) => typeof level === 'string' && level.length > 0) : []
      return list.length > 0 ? list : LEVELS
    }

    /**
     * Reasoning-effort ids → [labelKey, explanationKey].
     *
     * The order shown is the host's (`state.reasoningChoices`) when it sends one;
     * this map only supplies the copy, plus the fallback order. Hard-coding the
     * list here is what let the host add `none` while the panel showed five
     * options and could not highlight it.
     */
    const EFFORT_META = {
      auto: ['effortAuto', 'effortAutoWhat'],
      none: ['effortNone', 'effortNoneWhat'],
      off: ['effortOff', 'effortOffWhat'],
      low: ['effortLow', 'effortLowWhat'],
      high: ['effortHigh', 'effortHighWhat'],
      max: ['effortMax', 'effortMaxWhat'],
    }
    const EFFORT_VALUES = ['auto', 'none', 'off', 'low', 'high', 'max']
    const SEARCH_META = {
      auto: ['searchAuto', 'searchWhatAuto'],
      allow: ['searchAllow', 'searchWhatAllow'],
      deny: ['searchDeny', 'searchWhatDeny'],
    }
    const SUBAGENT_META = {
      allow: ['subagentAllow', 'subagentWhatAllow'],
      deny: ['subagentDeny', 'subagentWhatDeny'],
    }

    /** The host's list when it sends a usable one, the built-in order otherwise. */
    const choiceValues = (declared, fallback) => {
      const list = Array.isArray(declared) ? declared.filter((value) => typeof value === 'string' && value.length > 0) : []
      return list.length > 0 ? list : fallback
    }

    /**
     * The same list with some ids removed — `auto` is no longer a button, it is
     * the trailing link (see `sourceSuffix`), because the switch has to show the
     * value a level click produced.
     */
    const valuesWithFallback = (declared, fallback, drop = []) => {
      const list = choiceValues(declared, fallback).filter((value) => !drop.includes(value))
      return list.length > 0 ? list : fallback.filter((value) => !drop.includes(value))
    }

    /** A control plus the chip/link that says which layer supplied its value. */
    const withSource = (control, suffix) => h('div', {
      key: 'control',
      style: { display: 'flex', alignItems: 'center', gap: UI.gap.md, flexWrap: 'wrap' },
    }, [control, suffix])

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

    /**
     * A request that never settles used to leave `busy` true forever, which
     * disabled every control in both views with no way back but a reload.
     */
    const REQUEST_TIMEOUT_MS = 10_000

    /**
     * A 200 is only a success if the body actually carries the state's identity.
     * A forwarder can answer 200 with `{"error":...}`; accepting that stored a
     * garbage state, cleared the error and stopped the retry loop (F11). `levels`
     * is deliberately not required here — `asLevels` already forgives a bad list.
     */
    const isState = (body) => body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.level === 'string'

    /** One request to one URL; returns the parsed body or throws. */
    const once = async (url, init) => {
      // Not all sandboxes expose AbortController; without one the request is
      // still attempted, it just cannot be cancelled.
      const aborter = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = aborter === undefined ? undefined : setTimeout(() => aborter.abort(), REQUEST_TIMEOUT_MS)
      timer?.unref?.()
      try {
        let response
        try {
          response = await fetch(url, {
            headers: { accept: 'application/json', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...init,
            ...(aborter === undefined ? {} : { signal: aborter.signal }),
          })
        } catch (error) {
          if (aborter?.signal.aborted) throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS} ms`)
          throw error
        }
        const text = await response.text()
        let body
        try {
          body = text.length === 0 ? undefined : JSON.parse(text)
        } catch {
          throw new Error(`HTTP ${response.status} (non-JSON body)`)
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}${body?.error ? ` ${body.error}` : ''}`)
        if (body === undefined) throw new Error('HTTP 200 with an empty body')
        if (!isState(body)) throw new Error('HTTP 200 with an unexpected state shape')
        return body
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
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
            // A successful write proves the POST lane works, so later reads can
            // skip the all-GET-first attempt that the Desktop shell rejects.
            readsByPost = true
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

    // Every read/write takes a ticket, and only a response at least as new as
    // the last applied one may publish. Without this a slow background read
    // (window focus) landed after a click and put the old level back.
    let requestSeq = 0
    let appliedSeq = 0
    const claim = () => (requestSeq += 1)
    const applyIfFresh = (seq, patch) => {
      if (seq < appliedSeq) return false
      appliedSeq = seq
      publish(patch)
      return true
    }

    /**
     * Read the host state; keeps the real failure reason for diagnostics.
     *
     * One read at a time: a focus event, a visibility change and the retry loop
     * could all fire while the first GET was still hanging, and each one walked
     * the whole candidate-URL list again (four requests apiece on the desktop
     * shell, where GET is refused first).
     */
    /**
     * The advice that matches the failure.
     *
     * Every failure used to say "restart DeepSeek Harness", which is wrong for the
     * two most common ones (403 from the origin check, 404 from a route the host
     * half never registered) and useless when the request simply timed out.
     */
    const hintFor = (failure) => {
      const text = String(failure?.message ?? failure)
      if (/HTTP 403/.test(text)) return t('hintForbidden')
      if (/HTTP 404/.test(text)) return t('hintNotFound')
      if (/timed out/.test(text)) return t('hintTimeout')
      if (/unexpected state shape|non-JSON|empty body/.test(text)) return t('hintBadBody')
      return t('offlineHint')
    }

    let inFlightRead
    const load = () => {
      if (inFlightRead !== undefined) return inFlightRead
      inFlightRead = (async () => {
        const seq = claim()
        try {
          const next = await fetchState()
          applyIfFresh(seq, { state: next, error: null, detail: null })
          return true
        } catch (failure) {
          applyIfFresh(seq, { detail: `${environment()} · ${String(failure?.message ?? failure)}`, error: hintFor(failure) })
          return false
        } finally {
          inFlightRead = undefined
        }
      })()
      return inFlightRead
    }

    /** POST one change; optimistic, and reverted with a reason on failure. */
    const mutate = async (body, optimistic) => {
      if (store.busy) return
      const seq = claim()
      const previous = store.state
      publish({ busy: true, error: null, state: { ...(store.state ?? {}), ...optimistic } })
      try {
        const next = await fetchState({ method: 'POST', body: JSON.stringify(body) })
        applyIfFresh(seq, { state: next, error: null, detail: null })
      } catch (failure) {
        // Roll back only the keys this click wrote: replacing the whole state
        // with the pre-click snapshot also threw away a fresher background read.
        if (seq >= appliedSeq) {
          appliedSeq = seq
          const revert = {}
          for (const key of Object.keys(optimistic)) revert[key] = previous?.[key]
          publish({
            state: { ...(store.state ?? {}), ...revert },
            detail: `${environment()} · ${String(failure?.message ?? failure)}`,
            error: hintFor(failure),
          })
        }
      } finally {
        publish({ busy: false })
      }
    }

    const chooseLevel = (level) => {
      if (store.busy || store.state?.level === level) return
      // Only the level moves: the host keeps the explicit effort and search
      // choices, so the optimistic state must not pretend otherwise.
      void mutate({ level }, { level })
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
    const searchState = (state) => {
      if (state?.searchChoice && state.searchChoice !== 'auto') return state.searchChoice
      // Unknown is not "deny": guessing contradicted the level default and the
      // popover's own readout whenever `effective` was missing (F6).
      return state?.effective?.search
    }

    const chooseSubagents = (value) => {
      if (store.busy || (store.state?.subagents ?? 'allow') === value) return
      void mutate({ subagents: value }, { subagents: value })
    }

    /** Advanced knobs. They behave exactly like the level switches. */
    const chooseMaxTokens = (value) => {
      if (store.busy || (store.state?.maxTokensChoice ?? 0) === value) return
      void mutate({ maxTokens: value }, { maxTokensChoice: value })
    }

    const chooseInstruction = (value) => {
      if (store.busy || (store.state?.instructionChoice ?? 'auto') === value) return
      void mutate({ instruction: value }, { instructionChoice: value })
    }

    const chooseApplyToAllModels = (value) => {
      if (store.busy || (store.state?.applyToAllModelsChoice ?? false) === value) return
      void mutate({ applyToAllModels: value }, { applyToAllModelsChoice: value })
    }

    /**
     * Views subscribe here. The first subscriber starts the retry loop: a
     * failure backs off (2s, 5s, 15s, 30s) and every window focus re-reads, so a
     * panel that mounted before its host was ready heals itself.
     *
     * The backoff used to give up after four attempts, which left a panel
     * permanently offline when the host needed longer than 30s — the only way
     * back was a window refocus. It now keeps trying at the 30s floor, and every
     * pending timer lives in one set so an unmount cannot orphan one.
     */
    let retries = 0
    const retryTimers = new Set()
    const stopRetries = () => {
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
    }
    const kick = () => {
      if (store.listeners.size === 0) return
      void (async () => {
        const ok = await load()
        if (ok) {
          retries = 0
          return
        }
        const delays = [2000, 5000, 15000, 30000]
        const delay = delays[Math.min(retries, delays.length - 1)]
        retries += 1
        if (store.listeners.size === 0) return
        const timer = setTimeout(() => {
          retryTimers.delete(timer)
          kick()
        }, delay)
        retryTimers.add(timer)
        // A browser timer is a number; Node's is an object. Unref'ing keeps the
        // smoke test's process from being held open by a 30s retry.
        timer?.unref?.()
      })()
    }

    const onFocus = () => { if (store.listeners.size > 0) void load() }
    const onVisibility = () => { if (!document.hidden && store.listeners.size > 0) void load() }

    // Reference-counted: the listeners used to be added once and never removed,
    // so they outlived every view that asked for them.
    let watchers = 0
    const watch = () => {
      watchers += 1
      if (watchers > 1) return
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
    }
    const unwatch = () => {
      watchers = Math.max(0, watchers - 1)
      if (watchers > 0) return
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }

    function useStore() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        watch()
        store.listeners.add(force)
        if (store.state === null && store.error === null) kick()
        return () => {
          store.listeners.delete(force)
          unwatch()
          if (store.listeners.size === 0) {
            stopRetries()
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
      borderSoft: 'var(--dsw-alias-border-l1, #eef0f3)',
      layer1: 'var(--dsw-alias-bg-layer-1, #fff)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
      brand: 'var(--dsw-alias-brand-primary, #4f6ef7)',
      // The selected segment is a solid block in the *label* colour, which is
      // what the host's own segmented controls use. The brand accent made this
      // row read as a foreign widget next to them. Filling with the label colour
      // and writing in the layer colour inverts correctly in a dark theme too.
      solid: 'var(--dsw-alias-label-primary, #1f2328)',
      solidText: 'var(--dsw-alias-bg-layer-1, #fff)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
      shadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(31,35,40,.16))',
    }

    /**
     * Size scale.
     *
     * Colours came from host variables, but every font size, radius and gap was
     * typed inline — the same control could read 12px in the popover and 13px in
     * Settings, and "选中长什么样" needed learning twice. The primitives below
     * use these and nothing else.
     */
    const UI = {
      font: { xs: '11px', sm: '12px', md: '13px', lg: '14px' },
      line: { xs: '15px', sm: '18px', md: '20px', lg: '22px' },
      radius: { sm: '6px', md: '8px', lg: '10px', pill: '999px' },
      gap: { xs: '2px', sm: '4px', md: '8px', lg: '12px' },
      control: { sm: '26px', md: '28px' },
    }

    // --------------------------------------------------------- primitives --
    /**
     * The one-line reading of the live policy, shared by both views.
     *
     * Both views used to compute this separately, which is how a missing
     * `effective` ended up rendering "disabled" in one place and "allowed" in
     * the other.
     */
    const describeEffective = (state) => {
      const effective = state?.effective
      if (!effective) {
        return { known: false, effort: t('unchanged'), cap: t('unchanged'), search: t('unchanged'), instruction: t('unchanged') }
      }
      return {
        known: true,
        // `reasoningEffort: null` means "leave the request alone", which reads as
        // the model menu deciding — not as `off`.
        effort: effective.reasoningEffort ? labelOf(effective.reasoningEffort) : t('unchanged'),
        cap: effective.maxTokens === null || effective.maxTokens === undefined ? t('unlimited') : String(effective.maxTokens),
        search: effective.search === 'deny' ? t('searchOff') : t('searchOn'),
        instruction: effective.instruction ? t('on') : t('none'),
      }
    }

    /**
     * The real state of the prompt instruction.
     *
     * `off` when the policy does not want one at all (level off, or
     * `instruction: none`), `error` when one should be mounted but is not, `on`
     * otherwise. Reporting "not active" for `off` was a false alarm: nothing was
     * supposed to be registered in the first place.
     */
    const instructionState = (state) => {
      const health = state?.health
      if (health === undefined) return state?.effective?.instruction ? 'on' : 'off'
      if (health.expected === false) return 'off'
      return health.instruction ? 'on' : 'error'
    }

    const instructionText = (state) => {
      const status = instructionState(state)
      if (status === 'off') return t('instrByPolicy')
      return status === 'error' ? t('instrOff') : t('instrOn')
    }

    /**
     * "fixed by the config file", or undefined.
     *
     * Only the patch layer is reported: tagging everything the user just clicked
     * with "yours" is noise, but a value the panel cannot change has to look
     * different from one it can (clicking "follow the level" on a pinned value
     * looked like a dead button).
     */
    const sourceTag = (state, field) => (state?.sources?.[field] === 'patch' ? t('fromPatch') : undefined)

    /**
     * Where the shown value came from, next to the switch.
     *
     * `档位给的` when the level decides, a link to release the pin when the user
     * picked it, and a plain chip when the config file fixes it (the link would
     * do nothing: clearing the pin just lets the patch value back in).
     */
    const sourceSuffix = (state, field, onFollow) => {
      const source = state?.sources?.[field]
      if (source === 'patch') {
        return h('span', {
          key: 'src',
          title: t('lockedFollow'),
          style: { fontSize: UI.font.xs, color: TOKEN.tertiary, background: TOKEN.layer2, borderRadius: UI.radius.pill, padding: '0 7px' },
        }, t('fromPatch'))
      }
      if (source === 'panel') {
        return h('button', {
          key: 'src',
          type: 'button',
          onClick: onFollow,
          style: {
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: UI.font.xs,
            color: TOKEN.tertiary,
            textDecoration: 'underline dotted',
          },
        }, t('followAgain'))
      }
      if (source === undefined) return null
      return h('span', {
        key: 'src',
        style: { fontSize: UI.font.xs, color: TOKEN.tertiary },
      }, t('fromLevelShort'))
    }

    const LEVEL_SHORT = {
      off: 'levelOffShort',
      light: 'levelLightShort',
      standard: 'levelStandardShort',
      strong: 'levelStrongShort',
    }
    const shortOf = (level) => {
      const key = LEVEL_SHORT[level]
      return key === undefined ? '' : t(key)
    }

    /**
     * One option inside a segmented control.
     *
     * The selected option is a solid block in the primary label colour — the
     * treatment the host's own segmented controls use. Everything is a button
     * with `aria-pressed`, so a screen reader still gets the state.
     */
    const optionButton = (spec) => h('button', {
      key: spec.key,
      type: 'button',
      'aria-pressed': spec.on ? 'true' : 'false',
      'aria-disabled': spec.busy || spec.locked ? 'true' : 'false',
      title: spec.title,
      ...(spec.data ?? {}),
      onClick: () => { if (!spec.busy && !spec.locked) spec.onClick?.() },
      style: {
        font: 'inherit',
        fontSize: spec.small ? UI.font.sm : UI.font.md,
        lineHeight: spec.small ? UI.line.sm : UI.line.md,
        height: spec.small ? UI.control.sm : UI.control.md,
        padding: '0 10px',
        border: 'none',
        borderRadius: UI.radius.md,
        background: spec.on ? TOKEN.solid : 'transparent',
        color: spec.on ? TOKEN.solidText : TOKEN.secondary,
        fontWeight: spec.on ? 600 : 400,
        cursor: spec.busy || spec.locked ? 'default' : 'pointer',
        flex: spec.grow ? '1 1 0' : 'none',
        minWidth: spec.small ? undefined : '44px',
        // A label must never break mid-word when the row is tight; the track
        // wraps instead (see `wrap` on `segment`).
        whiteSpace: 'nowrap',
        opacity: spec.busy ? 0.6 : (spec.locked ? 0.45 : 1),
        transition: 'background .12s ease, color .12s ease',
      },
    }, spec.label)

    /** The bordered track a group of `optionButton`s sits in. */
    const segment = (key, options, { label, grow, wrap } = {}) => h('div', {
      key,
      role: 'group',
      'aria-label': label,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: UI.gap.xs,
        padding: UI.gap.xs,
        border: `1px solid ${TOKEN.border}`,
        borderRadius: UI.radius.lg,
        background: TOKEN.layer1,
        width: grow ? '100%' : undefined,
        flexWrap: wrap ? 'wrap' : undefined,
      },
    }, options)

    /**
     * A label + control + one-line explanation, the shape every knob uses.
     *
     * `stack` puts the control on its own line: the six effort options do not fit
     * beside the label at 380px, and letting the track shrink wrapped "跟随档位"
     * onto two lines inside its button.
     */
    const controlRow = (key, label, control, hint, stack) => h('div', { key, style: { marginTop: UI.gap.lg } }, [
      stack
        ? h('div', { key: 'l', style: { color: TOKEN.tertiary, marginBottom: UI.gap.sm } }, label)
        : null,
      h('div', { key: 'top', style: { display: 'flex', alignItems: 'center', gap: UI.gap.md } }, [
        stack ? null : h('span', { key: 'l', style: { width: '56px', flexShrink: 0, color: TOKEN.tertiary } }, label),
        stack ? h('div', { key: 'c', style: { minWidth: 0 } }, control) : control,
      ]),
      hint ? h('div', { key: 'h', style: { color: TOKEN.tertiary, marginTop: '4px' } }, hint) : null,
    ])

    /**
     * A collapsible block.
     *
     * A native `<details>` is the obvious tool, but React sets `open` as an
     * attribute and every re-render would fight the user's toggle, so this keeps
     * the flag itself and draws its own glyph.
     */
    function Collapse({ title, sub, open: initiallyOpen, children }) {
      const [open, setOpen] = React.useState(!!initiallyOpen)
      return h('div', {
        style: { marginTop: UI.gap.lg, paddingTop: UI.gap.md, borderTop: `1px solid ${TOKEN.borderSoft}` },
      }, [
        h('button', {
          key: 'head',
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((was) => !was),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            width: '100%',
            border: 'none',
            background: 'transparent',
            padding: 0,
            font: 'inherit',
            color: TOKEN.tertiary,
            textAlign: 'left',
            cursor: 'pointer',
          },
        }, [
          h('span', { key: 'g', style: { fontSize: '10px', lineHeight: '14px' } }, open ? '▾' : '▸'),
          h('span', { key: 't', style: { flex: 1 } }, title),
          sub ? h('span', { key: 's', style: { fontSize: '11px' } }, sub) : null,
        ]),
        open ? h('div', { key: 'body', style: { paddingTop: '6px' } }, children) : null,
      ])
    }

    // ------------------------------------------------------------- portal --
    /**
     * The one container the popover portals into: created on first use, kept for
     * the life of the page, and re-appended on every mount so it stays last among
     * `document.body`'s children.
     *
     * Why this exists: the header row is not ours. A `position: fixed` box left
     * inside it inherits the row's stacking context, and the host's own layers go
     * up to `z-index: 1100` — so the popover painted underneath the conversation
     * and read as "clicking ? does nothing". The plugin market's layers use this
     * same lane for the same reason.
     */
    let portalHost = null
    const portalContainer = () => {
      // Guarded: a view-level test double, or a host that renders this module
      // outside a real DOM, gets the inline popover instead of a crash.
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
      if (portalHost === null) {
        portalHost = document.createElement('div')
        portalHost.setAttribute('data-dsh-terse-mode-portal', '')
      }
      return portalHost
    }
    // Layout effect in the browser (so the container is attached before paint),
    // whichever effect the host's React build exposes.
    const useMountEffect = React.useLayoutEffect ?? React.useEffect
    function usePortalHost() {
      const host = portalContainer()
      useMountEffect(() => {
        if (!host || typeof document === 'undefined' || !document.body) return undefined
        document.body.appendChild(host)
        return undefined
      }, [host])
      return host
    }

    function TerseModeControl() {
      const { state, error, detail, busy } = useStore()
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const box = React.useRef(null)
      const helpButton = React.useRef(null)
      const popoverBox = React.useRef(null)
      const portalHostNode = usePortalHost()

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
        const onDown = (event) => {
          const target = event.target
          // The popover no longer lives inside `box`, so it has to be checked
          // separately — otherwise the first click inside it dismisses it.
          if (box.current?.contains(target) || popoverBox.current?.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // Shown until the popover has been opened once; marked on close so the
      // reader actually gets to read it.
      const [firstRun, setFirstRun] = React.useState(firstRunPending)
      const opened = React.useRef(false)
      React.useEffect(() => {
        if (open) {
          opened.current = true
        } else if (opened.current) {
          opened.current = false
          setFirstRun(false)
          markFirstRunDone()
        }
      }, [open])

      // Focus follows the popover: in when it opens, back to the trigger when it
      // closes. Guarded by `wasOpen` so the first render does not steal focus.
      const wasOpen = React.useRef(false)
      React.useEffect(() => {
        if (open) {
          wasOpen.current = true
          popoverBox.current?.focus?.()
        } else if (wasOpen.current) {
          wasOpen.current = false
          helpButton.current?.focus?.()
        }
      }, [open])

      // `mutate`, `chooseLevel` and `chooseEffort` are module-level on purpose:
      // the component-local copies this used to keep drifted from them (one
      // guarded on `store.busy`, the other on the render-time `busy`).
      const post = mutate
      const choose = chooseLevel

      const levels = asLevels(state?.levels)
      const effective = state?.effective
      const view = describeEffective(state)
      const searchNow = searchState(state)
      const searchChoiceNow = state?.searchChoice ?? 'auto'
      const subagentNow = state?.subagents ?? 'allow'
      const effortNow = state?.reasoningChoice ?? 'auto'
      // Tool names the policy hides, counted from the policy — `health.sessions`
      // is how many sessions the deny list reached, which is a different number.
      const hiddenCount = (effective?.search === 'deny' ? 2 : 0)
        + (subagentNow === 'deny'
          ? (Array.isArray(state?.subagentTools) && state.subagentTools.length > 0 ? state.subagentTools.length : 4)
          : 0)
      // The switches live in the popover now, so this hover readout is where
      // their state can still be checked without opening it.
      const summary = effective
        ? `${t('think')} ${view.effort} · ${t('cap')} ${view.cap} · ${t('search')} ${view.search} · ${t('subagentTitle')} ${subagentNow === 'deny' ? t('subagentDeny') : t('subagentAllow')}`
        : ''

      /** The four levels, as a segmented control. Used twice (header + popover). */
      const levelSegment = (grow) => segment('level-bar', levels.map((level) => optionButton({
        key: level,
        label: labelOf(level),
        on: state?.level === level,
        // Every level explains itself on hover.
        title: t(LEVEL_WHAT[level] ?? level),
        data: { 'data-level': level },
        busy,
        grow,
        onClick: () => choose(level),
      })), { label: t('label'), grow })

      // The switches show the value *in effect*, not "follow the level", so a
      // level click visibly moves the block: 强 → 联网「禁止」, 轻 → 「允许」.
      // Which layer supplied it is the chip or link next to the switch.
      const effortShown = effective ? (effective.reasoningEffort ?? 'none') : undefined
      const searchShown = effective ? (searchNow ?? effective.search) : undefined

      const effortGroup = segment('effort', valuesWithFallback(state?.reasoningChoices, EFFORT_VALUES, ['auto']).map((value) => optionButton({
        key: value,
        label: t(EFFORT_META[value]?.[0] ?? value),
        on: effortShown === value,
        title: t(EFFORT_META[value]?.[1] ?? value),
        data: { 'data-effort': value },
        busy,
        small: true,
        onClick: () => chooseEffort(value),
      })), { label: t('effortTitle'), wrap: true })

      const subagentGroup = segment('subagents', choiceValues(state?.subagentChoices, ['allow', 'deny']).map((value) => optionButton({
        key: value,
        label: t(SUBAGENT_META[value]?.[0] ?? value),
        on: subagentNow === value,
        title: t(SUBAGENT_META[value]?.[1] ?? value),
        data: { 'data-subagents': value },
        busy,
        small: true,
        onClick: () => { void post({ subagents: value }, { subagents: value }) },
      })), { label: t('subagentTitle') })

      const searchGroup = segment('search', valuesWithFallback(state?.searchChoices, ['auto', 'allow', 'deny'], ['auto']).map((value) => optionButton({
        key: value,
        label: t(SEARCH_META[value]?.[0] ?? value),
        on: searchShown === value,
        title: t(SEARCH_META[value]?.[1] ?? value),
        data: { 'data-search-choice': value },
        busy,
        small: true,
        onClick: () => { void post({ search: value }, { searchChoice: value }) },
      })), { label: t('searchTitle') })

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
        ref: popoverBox,
        role: 'dialog',
        'aria-label': t('help'),
        style: {
          position: 'fixed',
          top: `${anchor.top}px`,
          right: `${anchor.right}px`,
          zIndex: 1200,
          width: 'min(380px, 88vw)',
          maxHeight: 'min(74vh, 560px)',
          overflowY: 'auto',
          padding: '12px 14px',
          borderRadius: '12px',
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
          h('strong', { key: 'title', style: { flex: 1, fontSize: UI.font.lg } }, t('label')),
          // The controls stay clickable while a request is in flight (see
          // `optionButton`), so this line is the only "saving" feedback.
          busy ? h('span', { key: 'saving', style: { fontSize: UI.font.xs, color: TOKEN.tertiary } }, t('saving')) : null,
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
        firstRun
          ? h('div', {
            key: 'first-run',
            style: {
              marginBottom: '8px',
              padding: '8px 10px',
              borderRadius: '8px',
              background: TOKEN.layer2,
              color: TOKEN.secondary,
            },
          }, t('firstRun'))
          : null,
        levelSegment(true),
        h('div', { key: 'now', style: { marginTop: '8px', color: TOKEN.tertiary } }, [
          h('strong', { key: 'l', style: { color: TOKEN.label, fontWeight: 600 } }, labelOf(state?.level)),
          state?.level === 'standard' ? h('span', { key: 'r' }, ` · ${t('recommended')}`) : null,
          h('span', { key: 's' }, ` · ${shortOf(state?.level)}`),
        ]),
        controlRow('effort', t('effortTitle'), withSource(effortGroup, sourceSuffix(state, 'reasoningEffort', () => chooseEffort('auto'))), t(EFFORT_META[effortNow]?.[1] ?? 'effortAutoWhat'), true),
        controlRow('subagents', t('subagentTitle'), subagentGroup, t(subagentNow === 'deny' ? 'subagentLineDeny' : 'subagentLineAllow')),
        controlRow('search', t('searchTitle'), withSource(searchGroup, sourceSuffix(state, 'search', () => chooseSearch('auto'))), t(searchChoiceNow === 'auto' ? 'searchLineAuto' : (searchNow === 'deny' ? 'searchLineDeny' : 'searchLineAllow'))),

        h(Collapse, {
          key: 'effective',
          title: t('effectiveTitle'),
          open: true,
        }, effective ? [
          h('div', { key: 'grid', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 14px' } }, [
            detailRow(t('think'), view.effort),
            detailRow(t('cap'), view.cap),
            detailRow(t('search'), view.search),
            detailRow(t('subagentTitle'), subagentNow === 'deny' ? t('subagentDeny') : t('subagentAllow')),
          ]),
          h('div', { key: 'health', style: { marginTop: '4px', color: TOKEN.tertiary, fontSize: '11px' } }, [
            instructionText(state),
            state?.health && state.health.sessions ? ` · ${t('sessionsLine').replace('{n}', String(state.health.sessions))}` : null,
            hiddenCount ? ` · ${t('toolsHidden')} ${hiddenCount} ${t('toolsCountUnit')}` : null,
          ]),
        ] : [
          h('div', { key: 'none', style: { color: error ? TOKEN.error : TOKEN.tertiary } }, error ?? t('effectiveUnknown')),
          // The raw reason stays here rather than in the header row: it is a
          // paragraph, and the header is one line of toolbar.
          detail ? h('div', { key: 'detail', style: { color: TOKEN.tertiary, marginTop: '2px', wordBreak: 'break-all' } }, `${t('cause')}: ${detail}`) : null,
          error ? retryButton('retry') : null,
        ]),

        // Key must not collide with the level bar above: two siblings sharing a
        // key make React's reconciliation undefined, and inside the portal the
        // orphaned copies are never cleaned up — the bar multiplied on every
        // render until the popover was a column of them.
        h(Collapse, { key: 'what-levels', title: t('whatTitle') }, [
          ...levels.map(whatRow),
          h('div', { key: 'defaults', style: { color: TOKEN.tertiary, marginTop: '6px' } }, t('levelDefaultsNote')),
        ]),

        h(Collapse, { key: 'advanced', title: t('advancedTitle'), sub: t('advancedSub') }, [
          h('div', { key: 's1', style: { color: TOKEN.secondary, marginBottom: '4px' } }, t('setting1')),
          h('div', { key: 's2', style: { color: TOKEN.secondary, marginBottom: '4px' } }, t('setting2')),
          h('div', { key: 's3', style: { color: TOKEN.secondary, marginBottom: '4px' } }, t('setting3')),
          h('div', { key: 'note', style: { color: TOKEN.tertiary } }, t('capNote')),
        ]),
      ]) : null

      // Rendered through the portal when react-dom is available, so neither the
      // header's stacking context nor its clipping can reach the popover.
      const popoverLayer = popover && ReactDOM && portalHostNode
        ? ReactDOM.createPortal(popover, portalHostNode)
        : popover

      return h('div', {
        ref: box,
        'data-plugin': 'dsh-terse-mode',
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          lineHeight: '22px',
          color: TOKEN.secondary,
          whiteSpace: 'nowrap',
        },
      }, [
        h('span', { key: 'label', title: t('labelHint'), style: { color: TOKEN.secondary, cursor: 'help' } }, t('label')),
        levelSegment(false),
        // The two switches live in the popover now. The header keeps the level
        // and a single entry point, so the row reads as one decision instead of
        // seven equally weighted buttons.
        h('button', {
          key: 'help',
          ref: helpButton,
          type: 'button',
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          'aria-controls': POPOVER_ID,
          'aria-label': t('help'),
          title: error ?? (busy ? t('saving') : (summary || t('help'))),
          onClick: () => setOpen((was) => !was),
          style: {
            // No resting border: an entry point should not compete with the level
            // blocks for attention. It only gains a surface while open.
            border: `1px solid ${open ? TOKEN.border : 'transparent'}`,
            background: open ? TOKEN.layer2 : 'transparent',
            color: open ? TOKEN.label : TOKEN.tertiary,
            borderRadius: '8px',
            boxSizing: 'border-box',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            lineHeight: 1,
            padding: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '16px',
            fontWeight: 500,
            flexShrink: 0,
          },
        }, '⋯'),
        // One line only: the raw reason is a paragraph and lives in the popover
        // (it used to be laid into this row with `word-break: break-all`, which
        // pushed the toolbar apart).
        error ? h('button', {
          key: 'retry',
          type: 'button',
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
        }, `${t('offline')} · ${t('retry')}`) : null,
        popoverLayer,
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
      const view = describeEffective(state)
      // Same normalisation as the header: a string or an array of objects here
      // used to take the whole Settings section down.
      const levels = asLevels(state?.levels)
      const effortNow = state?.reasoningChoice ?? 'auto'
      const searchChoiceNow = state?.searchChoice ?? 'auto'
      const subagentNow = state?.subagents ?? 'allow'
      const searchNow = searchState(state)
      // The switches show the value in effect (so a level click moves them); the
      // chip/link beside each switch says which layer supplied it.
      const effortShown = effective ? (effective.reasoningEffort ?? 'none') : undefined
      const searchShown = effective ? (searchNow ?? effective.search) : undefined
      // What the policy actually hides, not what the button says it hides.
      const hiddenCount = (effective?.search === 'deny' ? 2 : 0)
        + (subagentNow === 'deny'
          ? (Array.isArray(state?.subagentTools) && state.subagentTools.length > 0 ? state.subagentTools.length : 4)
          : 0)

      const cardStyle = {
        border: `1px solid ${TOKEN.border}`,
        borderRadius: UI.radius.lg,
        background: TOKEN.layer1,
        padding: `${UI.gap.lg} 14px`,
        marginBottom: UI.gap.md,
      }

      /** Section heading, with the one-line explainer the old list used to carry. */
      const heading = (key, title, sub) => h('div', {
        key,
        style: { display: 'flex', alignItems: 'baseline', gap: UI.gap.md, margin: `20px 0 ${UI.gap.md}` },
      }, [
        h('h3', { key: 't', style: { margin: 0, fontSize: UI.font.md, fontWeight: 600, color: TOKEN.label } }, title),
        sub ? h('span', { key: 's', style: { fontSize: UI.font.sm, color: TOKEN.tertiary } }, sub) : null,
      ])

      /** A read-only fact; `value` may be a string or a node. */
      const row = (key, label, value, source) => h('div', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: UI.gap.md, padding: '2px 0' },
      }, [
        h('span', { key: 'k', style: { width: '76px', flexShrink: 0, color: TOKEN.tertiary } }, label),
        h('span', { key: 'v', style: { color: TOKEN.label, minWidth: 0, wordBreak: 'break-word' } }, value),
        source ? h('span', {
          key: 's',
          style: { flexShrink: 0, fontSize: UI.font.xs, color: TOKEN.tertiary, background: TOKEN.layer2, borderRadius: UI.radius.pill, padding: '0 7px' },
        }, source) : null,
      ])

      const sourceChip = (field) => {
        const text = sourceTag(state, field)
        if (text === undefined) return null
        return h('span', {
          key: 'tag',
          style: { fontSize: '11px', color: TOKEN.tertiary, background: TOKEN.layer2, borderRadius: '999px', padding: '0 7px' },
        }, text)
      }

      /**
       * One level, as a card.
       *
       * The old page drew four buttons and then four rows repeating the same
       * sentences; this is one row that both explains and selects.
       */
      const levelCard = (level) => {
        const on = state?.level === level
        return h('button', {
          key: level,
          type: 'button',
          'data-level': level,
          'aria-pressed': on ? 'true' : 'false',
          'aria-disabled': busy ? 'true' : 'false',
          title: t(LEVEL_WHAT[level] ?? level),
          onClick: () => { if (!busy) chooseLevel(level) },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: UI.gap.md,
            width: '100%',
            marginBottom: UI.gap.sm,
            padding: '10px 14px',
            borderRadius: UI.radius.lg,
            background: on ? TOKEN.layer2 : TOKEN.layer1,
            border: `1px solid ${on ? TOKEN.solid : TOKEN.border}`,
            boxShadow: on ? `inset 0 0 0 1px ${TOKEN.solid}` : 'none',
            font: 'inherit',
            textAlign: 'left',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.7 : 1,
          },
        }, [
          h('span', { key: 'n', style: { width: '44px', flexShrink: 0, fontWeight: on ? 600 : 500 } }, labelOf(level)),
          level === 'standard'
            ? h('span', {
              key: 'b',
              style: {
                flexShrink: 0,
                fontSize: '11px',
                lineHeight: '17px',
                padding: '0 7px',
                borderRadius: '999px',
                border: `1px solid ${TOKEN.border}`,
                background: TOKEN.layer1,
                color: TOKEN.secondary,
              },
            }, t('recommended'))
            : null,
          h('span', { key: 'd', style: { flex: 1, minWidth: 0, color: TOKEN.secondary } }, shortOf(level)),
          h('span', {
            key: 'r',
            style: {
              width: '15px',
              height: '15px',
              flexShrink: 0,
              borderRadius: '50%',
              border: `1.5px solid ${on ? TOKEN.solid : TOKEN.tertiary}`,
              background: on ? TOKEN.solid : 'transparent',
              boxShadow: on ? `inset 0 0 0 3px ${TOKEN.layer2}` : 'none',
            },
          }),
        ])
      }

      // ---- advanced editors -------------------------------------------------
      // Drafts are local until committed: a POST per keystroke would fight the
      // 10s request timeout and rewrite level.json on every character.
      const [capDraft, setCapDraft] = React.useState('')
      const [instrDraft, setInstrDraft] = React.useState('')
      const capNow = state?.maxTokensChoice ?? 0
      const instrNow = state?.instructionChoice ?? 'auto'
      const allNow = state?.applyToAllModelsChoice ?? false
      const unknownTools = Array.isArray(state?.unknownTools) ? state.unknownTools : []
      const hiddenNames = [
        ...(effective?.search === 'deny' ? ['web_search', 'web_fetch'] : []),
        ...(subagentNow === 'deny'
          ? (Array.isArray(state?.subagentTools) && state.subagentTools.length > 0 ? state.subagentTools : ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'])
          : []),
      ]

      const fieldHead = (key, label, field) => h('div', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: UI.gap.md, marginBottom: UI.gap.md },
      }, [
        h('span', { key: 'n', style: { fontWeight: 500 } }, label),
        sourceChip(field),
      ])

      const fieldBox = (key, children) => h('div', {
        key,
        style: { padding: '10px 0', borderTop: `1px solid ${TOKEN.borderSoft}` },
      }, children)

      const hint = (key, text) => h('div', {
        key,
        style: { color: TOKEN.tertiary, marginTop: UI.gap.sm, fontSize: UI.font.sm },
      }, text)

      const capField = () => fieldBox('cap', [
        fieldHead('h', t('fieldCap'), 'maxTokens'),
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
          segment('cap', [
            optionButton({
              key: 'follow',
              label: t('capFollow'),
              on: capNow === 0,
              data: { 'data-cap': '0' },
              busy,
              small: true,
              onClick: () => chooseMaxTokens(0),
            }),
            optionButton({
              key: 'unlimited',
              label: t('unlimited'),
              on: capNow === -1,
              data: { 'data-cap': '-1' },
              busy,
              small: true,
              onClick: () => chooseMaxTokens(-1),
            }),
            optionButton({
              key: 'custom',
              label: t('capCustom'),
              on: capNow > 0,
              data: { 'data-cap': 'custom' },
              busy,
              small: true,
              // Choosing "custom" with nothing typed yet starts from 4096, so the
              // click does something the user can see and then edit.
              onClick: () => chooseMaxTokens(capNow > 0 ? capNow : 4096),
            }),
          ], { label: t('fieldCap'), wrap: true }),
          h('input', {
            key: 'n',
            type: 'number',
            min: 1,
            'aria-label': t('fieldCap'),
            placeholder: '4096',
            value: capDraft !== '' ? capDraft : (capNow > 0 ? String(capNow) : ''),
            onChange: (event) => setCapDraft(event.target.value),
            onBlur: () => {
              const next = Number(capDraft)
              setCapDraft('')
              if (Number.isInteger(next) && next > 0) chooseMaxTokens(next)
            },
            onKeyDown: (event) => { if (event.key === 'Enter') event.target?.blur?.() },
            style: {
              width: '96px',
              height: '28px',
              border: `1px solid ${TOKEN.border}`,
              borderRadius: '7px',
              padding: '0 8px',
              font: 'inherit',
              color: TOKEN.label,
              background: TOKEN.layer1,
            },
          }),
        ]),
        hint('hint', t('capHint')),
      ])

      const instrField = () => fieldBox('instr', [
        fieldHead('h', t('fieldInstr'), 'instruction'),
        segment('instr-mode', [
          optionButton({
            key: 'auto',
            label: t('instrAuto'),
            on: instrNow === 'auto',
            data: { 'data-instr': 'auto' },
            busy,
            small: true,
            onClick: () => chooseInstruction('auto'),
          }),
          optionButton({
            key: 'none',
            label: t('instrNone'),
            on: instrNow === 'none',
            data: { 'data-instr': 'none' },
            busy,
            small: true,
            onClick: () => chooseInstruction('none'),
          }),
          h('span', {
            key: 'now',
            style: { padding: '0 6px', color: TOKEN.tertiary, fontSize: '12px', alignSelf: 'center' },
          }, instrNow === 'auto' || instrNow === 'none' ? '' : `${t('instrCustomState')} · ${instrNow.length}`),
        ], { label: t('fieldInstr'), wrap: true }),
        h('textarea', {
          key: 'ta',
          rows: 3,
          'aria-label': t('fieldInstr'),
          placeholder: t('instrPlaceholder'),
          value: instrDraft !== '' ? instrDraft : (instrNow === 'auto' || instrNow === 'none' ? '' : instrNow),
          onChange: (event) => setInstrDraft(event.target.value),
          style: {
            display: 'block',
            width: '100%',
            maxWidth: '620px',
            marginTop: '8px',
            padding: '8px 10px',
            border: `1px solid ${TOKEN.border}`,
            borderRadius: '8px',
            font: 'inherit',
            lineHeight: '18px',
            color: TOKEN.label,
            background: TOKEN.layer1,
            resize: 'vertical',
          },
        }),
        h('div', { key: 'actions', style: { display: 'flex', gap: '8px', marginTop: '6px' } }, [
          h('button', {
            key: 'save',
            type: 'button',
            'aria-disabled': busy ? 'true' : 'false',
            onClick: () => {
              if (busy) return
              const text = instrDraft.trim()
              setInstrDraft('')
              chooseInstruction(text === '' ? 'auto' : text)
            },
            style: {
              border: `1px solid ${TOKEN.solid}`,
              background: TOKEN.solid,
              color: TOKEN.solidText,
              borderRadius: '7px',
              padding: '3px 12px',
              font: 'inherit',
              fontSize: '12px',
              fontWeight: 600,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          }, t('instrSave')),
          h('button', {
            key: 'default',
            type: 'button',
            'aria-disabled': busy ? 'true' : 'false',
            onClick: () => {
              if (busy) return
              setInstrDraft('')
              chooseInstruction('auto')
            },
            style: {
              border: `1px solid ${TOKEN.border}`,
              background: 'transparent',
              color: TOKEN.label,
              borderRadius: '7px',
              padding: '3px 12px',
              font: 'inherit',
              fontSize: '12px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          }, t('instrDefault')),
        ]),
      ])

      const allModelsField = () => fieldBox('all', [
        fieldHead('h', t('allModels'), 'applyToAllModels'),
        segment('all-models', [
          optionButton({
            key: 'off',
            label: t('toggleOff'),
            on: !allNow,
            data: { 'data-all-models': 'false' },
            busy,
            small: true,
            onClick: () => chooseApplyToAllModels(false),
          }),
          optionButton({
            key: 'on',
            label: t('toggleOn'),
            on: allNow,
            data: { 'data-all-models': 'true' },
            busy,
            small: true,
            onClick: () => chooseApplyToAllModels(true),
          }),
        ], { label: t('allModels') }),
        hint('hint', t('allModelsHint')),
      ])

      return h('div', {
        'data-plugin': 'dsh-terse-mode-settings',
        style: { color: TOKEN.label, fontSize: '13px', lineHeight: '20px' },
      }, [
        h('div', {
          key: 'title',
          style: { display: 'flex', alignItems: 'baseline', gap: UI.gap.md, fontSize: '15px', fontWeight: 600, marginBottom: UI.gap.sm },
        }, [
          h('span', { key: 't' }, t('nav')),
          busy ? h('span', { key: 'saving', style: { fontSize: UI.font.xs, fontWeight: 400, color: TOKEN.tertiary } }, t('saving')) : null,
        ]),
        h('div', { key: 'intro', style: { color: TOKEN.secondary, marginBottom: UI.gap.lg } }, t('sectionIntro')),

        heading('levels', t('whatTitle'), t('levelsSub')),
        h('div', { key: 'levelCards' }, levels.map(levelCard)),
        h('div', { key: 'defaults', style: { color: TOKEN.tertiary, marginTop: '6px', maxWidth: '620px' } }, t('levelDefaultsNote')),

        heading('adjust', t('adjustTitle'), t('adjustSub')),

        h('div', { key: 'effort', style: cardStyle }, [
          h('div', { key: 't', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
            h('span', { key: 'l', style: { fontWeight: 600 } }, t('effortTitle')),
          ]),
          withSource(
            segment('effort', valuesWithFallback(state?.reasoningChoices, EFFORT_VALUES, ['auto']).map((value) => optionButton({
              key: value,
              label: t(EFFORT_META[value]?.[0] ?? value),
              on: effortShown === value,
              title: t(EFFORT_META[value]?.[1] ?? value),
              data: { 'data-effort': value },
              busy,
              onClick: () => chooseEffort(value),
            })), { label: t('effortTitle'), wrap: true }),
            sourceSuffix(state, 'reasoningEffort', () => chooseEffort('auto')),
          ),
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginTop: '8px' } }, t(EFFORT_META[effortNow]?.[1] ?? 'effortAutoWhat')),
        ]),

        h('div', { key: 'subagents', style: cardStyle }, [
          h('div', { key: 't', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
            h('span', { key: 'l', style: { fontWeight: 600 } }, t('subagentTitle')),
            sourceChip('subagents'),
          ]),
          segment('subagents', choiceValues(state?.subagentChoices, ['allow', 'deny']).map((value) => optionButton({
            key: value,
            label: t(SUBAGENT_META[value]?.[0] ?? value),
            on: subagentNow === value,
            title: t(SUBAGENT_META[value]?.[1] ?? value),
            data: { 'data-subagents': value },
            busy,
            onClick: () => chooseSubagents(value),
          })), { label: t('subagentTitle') }),
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginTop: '8px' } }, t(subagentNow === 'deny' ? 'subagentLineDeny' : 'subagentLineAllow')),
        ]),

        h('div', { key: 'search', style: cardStyle }, [
          h('div', { key: 't', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } }, [
            h('span', { key: 'l', style: { fontWeight: 600 } }, t('searchTitle')),
          ]),
          withSource(
            segment('search', valuesWithFallback(state?.searchChoices, ['auto', 'allow', 'deny'], ['auto']).map((value) => optionButton({
              key: value,
              label: t(SEARCH_META[value]?.[0] ?? value),
              on: searchShown === value,
              title: t(SEARCH_META[value]?.[1] ?? value),
              data: { 'data-search-choice': value },
              busy,
              onClick: () => chooseSearch(value),
            })), { label: t('searchTitle') }),
            sourceSuffix(state, 'search', () => chooseSearch('auto')),
          ),
          h('div', { key: 'h', style: { color: TOKEN.tertiary, marginTop: '8px' } }, t(searchChoiceNow === 'auto'
            ? 'searchLineAuto'
            : (searchNow === 'deny' ? 'searchLineDeny' : 'searchLineAllow'))),
        ]),

        h('div', { key: 'effective', style: { ...cardStyle, marginTop: '16px' } }, [
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: '8px' } }, t('effectiveTitle')),
          ...(effective ? [
            h('div', { key: 'grid', style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 32px' } }, [
              row('think', t('think'), view.effort),
              row('cap', t('cap'), view.cap),
              row('search', t('search'), view.search),
              row('sub', t('subagentTitle'), subagentNow === 'deny' ? t('subagentDeny') : t('subagentAllow')),
            ]),
            // Not a repeat of the policy: whether the prompt section and the tool
            // restrictions are actually mounted. Both can fail silently.
            h('div', { key: 'health', style: { marginTop: '10px', color: TOKEN.tertiary, fontSize: '12px' } }, [
              instructionText(state),
              ` · ${t('toolsHidden')} ${hiddenCount} ${t('toolsCountUnit')}`,
              state?.health && state.health.sessions ? ` · ${t('sessionsLine').replace('{n}', String(state.health.sessions))}` : null,
            ]),
          ] : [
            h('div', { key: 'none', style: { color: error ? TOKEN.error : TOKEN.tertiary } }, error ?? t('effectiveUnknown')),
            detail ? h('div', { key: 'detail', style: { color: TOKEN.tertiary, marginTop: '2px', wordBreak: 'break-all' } }, `${t('cause')}: ${detail}`) : null,
            error ? h('button', {
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
            }, t('retry')) : null,
          ]),
        ]),

        h(Collapse, { key: 'advanced', title: t('advancedTitle'), sub: t('advancedSub') }, [
          capField(),
          instrField(),
          allModelsField(),
          fieldBox('rest', [
            row('a3', t('fieldHidden'), `${hiddenCount} ${t('toolsCountUnit')}${hiddenNames.length > 0 ? ` · ${hiddenNames.join(', ')}` : ''}`),
            // A name this host does not mount is the most useful thing the panel
            // can report after a version bump: "deny" silently hides nothing.
            unknownTools.length > 0
              ? h('div', { key: 'u', style: { color: TOKEN.error, fontSize: '12px', marginTop: '4px' } },
                `${t('unknownToolsLine')}: ${unknownTools.join(', ')}`)
              : null,
            row('a4', t('fieldStore'), h('span', {
              style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', color: TOKEN.secondary },
            }, '$DSH_HOME/storages/dsh-terse-mode/level.json')),
            row('a5', t('fieldPatch'), h('span', {
              style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', color: TOKEN.secondary },
            }, 'profile/cordis.patch.yml')),
            row('a6', t('fieldWhen'), t('whenValue')),
          ]),
          h('div', { key: 's1', style: { color: TOKEN.secondary, marginTop: '10px', maxWidth: '620px' } }, t('setting1')),
          h('div', { key: 's2', style: { color: TOKEN.secondary, marginTop: '4px', maxWidth: '620px' } }, t('setting2')),
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
