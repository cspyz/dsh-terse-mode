/**
 * dsh-terse-mode — keep the DeepSeek agent from over-thinking, over-searching
 * and over-talking.
 *
 * Host-only Cordis plugin. Zero runtime dependencies: the only shared API it
 * touches is the one the Harness documents for plugins
 * (`ctx.systemPrompt.section`, the `agent/request` waterfall,
 * `ctx.tools.guard` / `ctx.tools.restrict`).
 *
 * The policy is mutable at runtime: a UI panel (or anything else holding the
 * controller) can call the level controller without reloading the plugin, and
 * the guard / request listener / restrictions all read the live policy. Three
 * registration sites, each disposable and each best-effort: a missing or
 * failing collaborator degrades this plugin, it must never fail activation or
 * an agent's creation (see docs/superpowers/specs/2026-10-01-terse-mode-design.md).
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LEVELS,
  PLUGIN_NAME,
  REASONING_CHOICES,
  SEARCH_CHOICES,
  SECTION_NAME,
  SECTION_ORDER,
  SEARCH_TOOLS,
  SUBAGENT_CHOICES,
  clampCallConfig,
  deniedTools,
  describePolicy,
  effortsOf,
  normalizeConfig,
  rawOf,
} from './lib/logic.js'
import { registerLevelApi } from './lib/level-api.js'
import { createLevelStore } from './lib/store.js'

/** Name shown in fiber diagnostics and in the plugin log. */
export const name = PLUGIN_NAME

/**
 * Services this row needs before it can do anything. Both are mounted by the
 * shipped base bundle in every profile; without them there is nothing to tune.
 */
export const inject = ['systemPrompt', 'tools']

/**
 * Standard Schema consumed by `resolveConfig` before `apply` runs.
 *
 * It deliberately cannot report issues: `resolveConfig` throws
 * `ValidationError` when a schema rejects, that makes the entry fail to
 * activate, and a failed activation has already once tripped the Desktop
 * safe-mode watchdog. Every unknown value therefore falls back to a safe
 * default and surfaces as a logged warning instead.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-terse-mode',
    validate(value) {
      return { value: normalizeConfig(value) }
    },
  },
}

export function apply(ctx, config) {
  // `store` has to exist before `log` (it names the diagnostics directory) and
  // `log` has to exist before `store` can report a failed write. The indirection
  // breaks the cycle, so a choice that cannot be persisted is never silent.
  let mirror = () => {}
  const store = createLevelStore(ctx, (level, text) => mirror(level, text))
  const remembered = store.read()
  const authored = rawOf(config)

  /**
   * Append one bounded line to a diagnostics file next to the state file.
   *
   * Appends instead of read-modify-writing: the first version read the whole
   * file and rewrote it for every line, and the panel writes one line per
   * request (up to eight when its retries run), so one click could copy 64KB a
   * few times on the event loop. The size is remembered in memory and read from
   * disk once per process; the file is rewritten only when it overflows.
   */
  const logSizes = new Map()
  const appendLine = (name, line) => {
    try {
      const file = join(dirname(store.path), name)
      const text = `${new Date().toISOString()} ${line}\n`
      let size = logSizes.get(file)
      if (size === undefined) {
        try { size = statSync(file).size } catch { size = 0 }
      }
      if (size + text.length > 64 * 1024) {
        writeFileSync(file, text)
        logSizes.set(file, text.length)
        return
      }
      appendFileSync(file, text)
      logSizes.set(file, size + text.length)
    } catch { /* diagnostics must never break the host */ }
  }

  /**
   * The plugin's own log lines, mirrored to `plugin.log`.
   *
   * The Desktop host's stdout is not reachable from a plugin, so when the panel
   * cannot connect there is no other way to read *why* a registration failed.
   */
  const log = makeLogger(ctx, (level, text) => appendLine('plugin.log', `${level} ${text}`))
  mirror = log

  /**
   * One line per panel request, next to the state file. When the widget shows
   * "未连上宿主" this is what separates "the request never left the renderer"
   * from "it arrived and was refused".
   */
  const debugLog = (line) => appendLine('requests.log', line)

  /**
   * The panel's layer, kept apart from the authored config.
   *
   * Two layers instead of one merge is what makes "a level click resets the
   * effort and the search knob" safe. The click clears the *panel's* pin, and
   * whatever `cordis.patch.yml` authored comes back. The old single-layer merge
   * called `delete` on the merged object, so a patch-level `search: deny` was
   * gone for good after one level click — it also wrote `auto` back to
   * `level.json`, which then beat the patch on every later start.
   *
   * `auto` is stored as "no pin", never as the string `auto`, so the layers
   * combine with a plain spread: `{ ...authored, ...pinned }`.
   */
  const pinnedFrom = (choice) => {
    const pinned = {}
    if (choice === undefined) return pinned
    if (LEVELS.includes(choice.level)) pinned.level = choice.level
    if (choice.reasoningEffort !== 'auto' && REASONING_CHOICES.includes(choice.reasoningEffort)) {
      pinned.reasoningEffort = choice.reasoningEffort
    }
    if (choice.search !== 'auto' && SEARCH_CHOICES.includes(choice.search)) pinned.search = choice.search
    if (SUBAGENT_CHOICES.includes(choice.subagents)) pinned.subagents = choice.subagents
    return pinned
  }

  const runtime = {
    /** The authored config, never mutated: the floor the panel builds on. */
    authored,
    /** What the panel chose, and all that is persisted. */
    pinned: pinnedFrom(remembered),
    /** `authored` with `pinned` on top; what `normalizeConfig` consumes. */
    raw: {},
    /** The live policy. Everything reads this, never a captured copy. */
    policy: undefined,
    sectionDispose: undefined,
    sectionTimer: undefined,
    restrictions: new Set(),
  }
  runtime.raw = { ...runtime.authored, ...runtime.pinned }
  runtime.policy = normalizeConfig(runtime.raw)
  if (Object.keys(runtime.pinned).length > 0) {
    log('info', `using the choice remembered from the panel: ${Object.entries(runtime.pinned).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  log('info', `active: ${describePolicy(runtime.policy)}`)
  for (const warning of runtime.policy.warnings) log('warn', warning)

  // ------------------------------------------------------------- prompt ----
  // A reload can apply the new generation before the old fiber releases its
  // section, so the first registration is refused with "already registered".
  // The route already retries with backoff; the section — the actual
  // "be terse" feature — used to give up and stay silent. Same shape here.
  const SECTION_RETRY_DELAYS = [250, 1000, 3000]
  const syncInstruction = (attempt = 0) => {
    if (runtime.sectionTimer !== undefined) {
      clearTimeout(runtime.sectionTimer)
      runtime.sectionTimer = undefined
    }
    dispose(runtime.sectionDispose)
    runtime.sectionDispose = undefined
    if (!runtime.policy.instruction) return
    try {
      runtime.sectionDispose = ctx.effect(() => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: runtime.policy.instruction,
        interpolate: false,
      }), `${PLUGIN_NAME}.section()`)
    } catch (error) {
      log('warn', `could not add the prompt section: ${message(error)}`)
      if (attempt < SECTION_RETRY_DELAYS.length) {
        runtime.sectionTimer = setTimeout(() => syncInstruction(attempt + 1), SECTION_RETRY_DELAYS[attempt])
        // Do not hold a test/CLI process open for a retry.
        runtime.sectionTimer?.unref?.()
      }
    }
  }

  // ----------------------------------------------------- tool visibility ----
  // The search tools and the subagent creation tools share one deny list, so the
  // live guard and the agent restriction can never disagree (see `deniedTools`).
  const restrictAgent = (agent) => {
    try {
      const agentCtx = agent?.ctx
      const tools = resolveTools(agentCtx)
      if (typeof tools?.restrict !== 'function') return
      const apply = (names) => {
        const dispose = agentCtx.effect(
          () => tools.restrict({ deny: names }),
          `${PLUGIN_NAME}.restrict()`,
        )
        if (typeof dispose === 'function') runtime.restrictions.add(dispose)
      }
      const names = deniedTools(runtime.policy)
      let applied = false
      try {
        apply(names)
        applied = true
      } catch {
        // `restrict()` refuses a filter naming an unknown tool, so a partial
        // tool surface must not cost us the names that do exist.
        for (const name of names) {
          try { apply([name]); applied = true } catch { /* not mounted here */ }
        }
      }
      if (!applied) log('warn', 'could not hide the denied tools for this agent; the guard still blocks their calls')
    } catch (error) {
      log('warn', `could not hide tools for one agent: ${message(error)}`)
    }
  }

  const disposeRestrictions = () => {
    for (const dispose of runtime.restrictions) {
      try { dispose() } catch { /* already gone with its agent */ }
    }
    runtime.restrictions.clear()
  }

  const syncRestrictions = () => {
    if (deniedTools(runtime.policy).length === 0) {
      disposeRestrictions()
      return
    }
    // Never tear the old restrictions down before the replacement list is
    // known: the agents service is briefly unavailable during a reload, and
    // the dispose-then-rebuild order left the model seeing tools the policy
    // still claimed to hide (only the call-time guard remained).
    const agents = liveAgents(ctx)
    if (agents === undefined) {
      log('warn', 'agents service unavailable; keeping the existing tool restrictions')
      return
    }
    disposeRestrictions()
    for (const agent of agents) restrictAgent(agent)
  }

  // Always registered; it consults the live policy per agent, so a level change
  // hides the tools from every later session without re-registering anything.
  try {
    ctx.on('agent/created', ({ agent }) => {
      // A throwing `agent/created` listener rejects agent creation, so this
      // listener can never let an exception escape.
      if (deniedTools(runtime.policy).length > 0) restrictAgent(agent)
    })
  } catch (error) {
    log('warn', `could not watch agent/created: ${message(error)}`)
  }

  // --------------------------------------------------------- hard block ----
  try {
    ctx.effect(() => ctx.tools.guard((execution) => {
      const name = execution?.name
      const policy = runtime.policy
      if (policy.subagents === 'deny' && (policy.subagentTools ?? []).includes(name)) {
        return 'Subagents are turned off by the dsh-terse-mode plugin (禁用子代理). Do the work in this session instead of delegating it.'
      }
      if (policy.search === 'deny' && SEARCH_TOOLS.includes(name)) {
        return 'Web tools are turned off by the dsh-terse-mode plugin (level policy). Answer from what you know, or ask the user to allow search.'
      }
      return undefined
    }), `${PLUGIN_NAME}.guard()`)
  } catch (error) {
    log('warn', `could not install the tool guard: ${message(error)}`)
  }

  // ------------------------------------------------------ request clamp ----
  registerRequestClamp(ctx, runtime, log)

  // ------------------------------------------------------ live controls ----
  /**
   * Apply a change to the live policy. Called by the UI transport, which owns
   * how the request arrived; everything else (prompt text, web-tool
   * visibility, the clamp and the guard) follows from the policy this replaces.
   *
   * @returns the effective policy, or `undefined` when a value is unknown.
   */
  const update = (patch) => {
    // Only the panel's layer moves here. `authored` is never touched, so a value
    // written in `cordis.patch.yml` comes back the moment its pin is cleared.
    const next = { ...runtime.pinned }
    if (LEVELS.includes(patch.level)) next.level = patch.level
    for (const field of ['reasoningEffort', 'search']) {
      if (patch[field] === 'auto') delete next[field]
      else if (patch[field] !== undefined) next[field] = patch[field]
    }
    if (SUBAGENT_CHOICES.includes(patch.subagents)) next.subagents = patch.subagents
    runtime.pinned = next
    runtime.raw = { ...runtime.authored, ...next }
    runtime.policy = normalizeConfig(runtime.raw)
    store.write({
      // `next.level` is undefined when the panel never picked one. Writing that
      // drops the key from the JSON, and `store.read()` refuses a file without
      // it — the panel's choice then looked applied but was gone on restart.
      level: next.level ?? runtime.policy.level,
      reasoningEffort: next.reasoningEffort ?? 'auto',
      search: next.search ?? 'auto',
      subagents: runtime.policy.subagents,
    })
    log('info', `updated: ${describePolicy(runtime.policy)}`)
    syncInstruction()
    syncRestrictions()
    return runtime.policy
  }

  /**
   * Choose a level. The level also resets the explicit effort and the explicit
   * search choice, so a level click always means "this level's defaults"; pick
   * those two afterwards to override just that knob. The subagent choice is
   * independent and kept.
   */
  const setLevel = (level) => (LEVELS.includes(level) ? update({ level, reasoningEffort: 'auto', search: 'auto' }) : undefined)

  /** Choose the reasoning effort itself: auto | none | off | low | high | max. */
  const setReasoningEffort = (value) => (REASONING_CHOICES.includes(value) ? update({ reasoningEffort: value }) : undefined)

  /** Allow or forbid web search: auto | allow | deny. */
  const setSearch = (value) => (SEARCH_CHOICES.includes(value) ? update({ search: value }) : undefined)

  /** Allow or forbid spawning subagents: allow | deny. */
  const setSubagents = (value) => (SUBAGENT_CHOICES.includes(value) ? update({ subagents: value }) : undefined)

  /**
   * Adopt a choice another host wrote.
   *
   * The desktop app and `dsh web` use different profiles but share `level.json`,
   * so without this a change made in one is only picked up by the other after a
   * restart. `samePin` is what stops our own writes from rebuilding everything.
   */
  const refreshFromStore = () => {
    const pinned = pinnedFrom(store.read())
    if (samePin(pinned, runtime.pinned)) return
    runtime.pinned = pinned
    runtime.raw = { ...runtime.authored, ...pinned }
    runtime.policy = normalizeConfig(runtime.raw)
    log('info', `adopted the choice written by another host: ${describePolicy(runtime.policy)}`)
    syncInstruction()
    syncRestrictions()
  }

  // Declared before the unload effect so it can be released there; assigned
  // further down, once every function the callback needs exists.
  let stopWatching

  // Unload disposes the live pieces this file owns directly; the `ctx.effect`
  // and `ctx.on` registrations release themselves.
  try {
    ctx.effect(() => () => {
      if (runtime.sectionTimer !== undefined) clearTimeout(runtime.sectionTimer)
      runtime.sectionTimer = undefined
      stopWatching?.()
      dispose(runtime.sectionDispose)
      disposeRestrictions()
    }, `${PLUGIN_NAME}.runtime()`)
  } catch (error) {
    log('warn', `could not own the runtime state: ${message(error)}`)
  }

  syncInstruction()
  syncRestrictions()

  // Follow the shared state file so a change made in the other host (desktop vs
  // `dsh web`) takes effect without a restart. Best effort: a profile whose
  // storage directory cannot be watched simply keeps the start-time choice.
  try {
    stopWatching = store.watch?.(() => {
      try {
        refreshFromStore()
      } catch (error) {
        log('warn', `could not adopt the shared choice: ${message(error)}`)
      }
    })
    if (stopWatching === undefined) log('info', `not watching ${store.path}; the panel choice is read at start-up only`)
  } catch (error) {
    log('warn', `could not watch ${store.path}: ${message(error)}`)
  }

  // Hand the controller to the conversation-page widget over the host web
  // server; a profile without one just logs and keeps working.
  //
  // The service is injected *optionally and late*: the web server mounts after
  // this row in the profiles seen so far, so `ctx.get('webServer')` at apply
  // time returns nothing and the route would never register — the panel then
  // shows "未连上宿主" forever while everything else about the plugin works
  // (measured: `plugin.log` said exactly that). `ctx.inject` is the shipped
  // pattern: it runs when the service appears, and again if it is replaced.
  const controller = {
    runtime,
    setLevel,
    setReasoningEffort,
    setSearch,
    setSubagents,
    log,
    debugLog,
    storedAt: () => store.read()?.updatedAt ?? null,
  }
  const attachApi = (webCtx) => {
    try {
      registerLevelApi(webCtx, controller, log)
    } catch (error) {
      log('warn', `could not attach the panel API: ${message(error)}`)
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attachApi)
    else attachApi(ctx)
  } catch (error) {
    log('warn', `could not watch for the web server: ${message(error)}`)
    attachApi(ctx)
  }
}

/** Clamp reasoning effort and output size on every model request. */
function registerRequestClamp(ctx, runtime, log) {
  // Exact-model capability, cached per provider/model with a short TTL. Without
  // it we could not tell a route that carries no effort yet (because the
  // adapter default is applied *after* this waterfall) from one that cannot
  // reason at all — and naming an unsupported effort makes the request fail
  // with UNSUPPORTED_REASONING_EFFORT.
  //
  // The TTL matters because the answer can be "no metadata yet": caching that
  // forever (the old `set(key, undefined)`) left the route unknown for the rest
  // of the plugin's life after one transient miss.
  const EFFORTS_TTL_MS = 30_000
  const effortsByRoute = new Map()
  let llm
  const effortsFor = async (provider, model, signal) => {
    const key = `${provider}|${model}`
    const hit = effortsByRoute.get(key)
    if (hit !== undefined && Date.now() - hit.at < EFFORTS_TTL_MS) return hit.efforts
    try {
      // Re-read on every TTL miss: the `llm` service can be replaced while the
      // plugin is mounted, and a stale handle would keep answering for it.
      llm = ctx.get?.('llm') ?? llm
      if (typeof llm?.resolveModelInfo !== 'function') return undefined
      const info = await llm.resolveModelInfo(provider, model, signal)
      const efforts = effortsOf(info)
      effortsByRoute.set(key, { at: Date.now(), efforts })
      return efforts
    } catch (error) {
      log('warn', `could not read the reasoning capability of ${key}: ${message(error)}`)
      return undefined
    }
  }

  try {
    // `prepend: true` is required, not cosmetic: the UI's model-selection
    // listener re-applies the user's picked effort after `await next()`, and
    // only the outermost listener's return value survives.
    ctx.on('agent/request', async ({ signal }, next) => {
      const resolved = await next()
      try {
        const policy = runtime.policy
        const efforts = policy.reasoningEffort === null
          ? undefined
          : await effortsFor(resolved.provider, resolved.model, signal)
        return clampCallConfig(resolved, policy, efforts)
      } catch (error) {
        log('warn', `left the request config untouched: ${message(error)}`)
        return resolved
      }
    }, { prepend: true })
  } catch (error) {
    log('warn', `could not watch agent/request: ${message(error)}`)
  }
}

/** `ctx.logger(name)` is a logger factory; logging must never break apply. */
function makeLogger(ctx, mirror) {
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger(`dsh-${PLUGIN_NAME}`) : undefined
  } catch {
    logger = undefined
  }
  return (level, text) => {
    try {
      logger?.[level]?.(text)
    } catch { /* logging is never worth failing for */ }
    try {
      mirror?.(level, text)
    } catch { /* nor is the mirror */ }
  }
}

/**
 * Resolve the tool registry from an agent's scoped context.
 *
 * Property access is the idiomatic form and is what rebinds the service to the
 * calling scope — which `restrict()` requires. `get()` is only a fallback for
 * a context whose property read throws.
 */
function resolveTools(agentCtx) {
  if (!agentCtx) return undefined
  try {
    if (agentCtx.tools) return agentCtx.tools
  } catch { /* fall through to the explicit lookup */ }
  try {
    return agentCtx.get?.('tools')
  } catch {
    return undefined
  }
}

/**
 * Agents that already exist (a config reload, or a row enabled mid-session).
 *
 * `undefined` means "unknown" — the service is missing, still mounting, or
 * threw — which is not the same as "there are no agents". Callers must not
 * dispose live restrictions on an unknown answer.
 */
function liveAgents(ctx) {
  try {
    const agents = ctx.get?.('agents')
    if (agents === undefined) return undefined
    return agents.list?.() ?? []
  } catch {
    return undefined
  }
}

/** The four fields the panel owns; the rest of the config belongs to the patch. */
const PIN_FIELDS = ['level', 'reasoningEffort', 'search', 'subagents']

/**
 * True when two pin objects say the same thing, field by field.
 *
 * Per-field rather than a JSON string: the key order of `level.json` is not
 * something to depend on, and a missing field must equal a missing field.
 */
function samePin(a, b) {
  return PIN_FIELDS.every((field) => a?.[field] === b?.[field])
}

function dispose(disposer) {
  try { disposer?.() } catch { /* already disposed */ }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
