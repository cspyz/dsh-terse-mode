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
import { readFileSync, writeFileSync } from 'node:fs'
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
  const store = createLevelStore(ctx)
  const remembered = store.read()
  const authored = rawOf(config)

  /** Append one bounded line to a diagnostics file next to the state file. */
  const appendLine = (name, line) => {
    try {
      const file = join(dirname(store.path), name)
      const stamp = new Date().toISOString()
      let previous = ''
      try {
        previous = readFileSync(file, 'utf8')
        if (previous.length > 64 * 1024) previous = ''
      } catch { /* first write */ }
      writeFileSync(file, `${previous}${stamp} ${line}\n`)
    } catch { /* diagnostics must never break the host */ }
  }

  /**
   * The plugin's own log lines, mirrored to `plugin.log`.
   *
   * The Desktop host's stdout is not reachable from a plugin, so when the panel
   * cannot connect there is no other way to read *why* a registration failed.
   */
  const log = makeLogger(ctx, (level, text) => appendLine('plugin.log', `${level} ${text}`))

  /**
   * One line per panel request, next to the state file. When the widget shows
   * "未连上宿主" this is what separates "the request never left the renderer"
   * from "it arrived and was refused".
   */
  const debugLog = (line) => appendLine('requests.log', line)

  /**
   * Merge a remembered panel choice over the authored config.
   *
   * An `auto` choice must *remove* an authored value (so the level default
   * applies again), which is why this is not a plain spread.
   */
  const withRemembered = (base, choice) => {
    const next = { ...base }
    if (choice === undefined) return next
    if (LEVELS.includes(choice.level)) next.level = choice.level
    if (choice.reasoningEffort === 'auto') delete next.reasoningEffort
    else if (REASONING_CHOICES.includes(choice.reasoningEffort)) next.reasoningEffort = choice.reasoningEffort
    if (choice.search === 'auto') delete next.search
    else if (SEARCH_CHOICES.includes(choice.search)) next.search = choice.search
    if (SUBAGENT_CHOICES.includes(choice.subagents)) next.subagents = choice.subagents
    return next
  }

  const runtime = {
    /** The authored config, kept clean so a choice change can re-normalise. */
    raw: withRemembered(authored, remembered),
    /** The live policy. Everything reads this, never a captured copy. */
    policy: normalizeConfig(config),
    sectionDispose: undefined,
    restrictions: new Set(),
  }
  runtime.policy = normalizeConfig(runtime.raw)
  if (remembered !== undefined) {
    log('info', `using the choice remembered from the panel: level=${runtime.raw.level ?? '(authored)'} reasoningEffort=${runtime.raw.reasoningEffort ?? 'auto'}`)
  }

  log('info', `active: ${describePolicy(runtime.policy)}`)
  for (const warning of runtime.policy.warnings) log('warn', warning)

  // ------------------------------------------------------------- prompt ----
  const syncInstruction = () => {
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
    disposeRestrictions()
    if (deniedTools(runtime.policy).length === 0) return
    for (const agent of liveAgents(ctx)) restrictAgent(agent)
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
    const next = { ...runtime.raw, ...patch }
    // An `auto` choice means "follow the level again", i.e. the field must leave
    // the authored subset rather than be stored as a value.
    for (const field of ['reasoningEffort', 'search']) {
      if (patch[field] === 'auto') delete next[field]
    }
    runtime.raw = next
    runtime.policy = normalizeConfig(next)
    store.write({
      level: runtime.raw.level,
      reasoningEffort: runtime.raw.reasoningEffort ?? 'auto',
      search: runtime.raw.search ?? 'auto',
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

  // Unload disposes the live pieces this file owns directly; the `ctx.effect`
  // and `ctx.on` registrations release themselves.
  try {
    ctx.effect(() => () => {
      dispose(runtime.sectionDispose)
      disposeRestrictions()
    }, `${PLUGIN_NAME}.runtime()`)
  } catch (error) {
    log('warn', `could not own the runtime state: ${message(error)}`)
  }

  syncInstruction()
  syncRestrictions()

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
  // Exact-model capability, resolved once per provider/model for the life of
  // this plugin generation. Without it we could not tell a route that carries
  // no effort yet (because the adapter default is applied *after* this
  // waterfall) from one that cannot reason at all — and naming an unsupported
  // effort makes the request fail with UNSUPPORTED_REASONING_EFFORT.
  const effortsByRoute = new Map()
  let llm
  const effortsFor = async (provider, model, signal) => {
    const key = `${provider}|${model}`
    if (effortsByRoute.has(key)) return effortsByRoute.get(key)
    try {
      llm ??= ctx.get?.('llm')
      if (typeof llm?.resolveModelInfo !== 'function') return undefined
      const info = await llm.resolveModelInfo(provider, model, signal)
      const efforts = effortsOf(info)
      effortsByRoute.set(key, efforts)
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

/** Agents that already exist (a config reload, or a row enabled mid-session). */
function liveAgents(ctx) {
  try {
    return ctx.get?.('agents')?.list?.() ?? []
  } catch {
    return []
  }
}

function dispose(disposer) {
  try { disposer?.() } catch { /* already disposed */ }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
