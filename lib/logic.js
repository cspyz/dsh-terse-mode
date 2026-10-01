/**
 * dsh-terse-mode — pure decision logic.
 *
 * No imports, no I/O: everything here is deterministic so it can be unit
 * tested without a Harness (see ../test/logic.test.mjs).
 *
 * The plugin exists to answer three complaints about the DeepSeek agent:
 *   1. it over-thinks simple questions,
 *   2. it searches the web without being asked,
 *   3. it is verbose.
 *
 * Each one maps to one lever in index.js:
 *   reasoning effort  → the `agent/request` waterfall (`clampCallConfig`)
 *   web search        → `tools.guard` + `tools.restrict` (`shouldDenySearch`)
 *   verbosity         → a system-prompt section + a `maxTokens` cap
 */

export const PLUGIN_NAME = 'terse-mode'
export const SECTION_NAME = 'plugin:terse-mode'
export const SECTION_ORDER = 20000

/** Model-facing names of the web tools shipped by `@deepseek-ai/dsh-tool-web`. */
export const SEARCH_TOOLS = ['web_search', 'web_fetch']

/**
 * Reasoning-effort ids the DeepSeek adapters advertise, weakest first.
 * An id outside this table is never rewritten: another adapter's vocabulary is
 * not ours to guess.
 */
export const EFFORT_RANK = { off: 0, low: 1, high: 2, max: 3 }

export const LEVELS = ['off', 'light', 'standard', 'strong']
export const DEFAULT_LEVEL = 'standard'

/**
 * Values the panel may choose for the reasoning effort itself.
 * `auto` follows the level, `none` never touches the request.
 */
export const REASONING_CHOICES = ['auto', 'none', 'off', 'low', 'high', 'max']

/** Values the panel may choose for spawning subagents. */
export const SUBAGENT_CHOICES = ['allow', 'deny']

/**
 * Values the panel may choose for web search. `auto` follows the level.
 *
 * The resolved policy only ever carries `allow`/`deny`; `auto` exists so the
 * panel can show — and restore — "whatever the level decides".
 */
export const SEARCH_CHOICES = ['auto', 'allow', 'deny']

/**
 * Tools that can start another agent, hence the ones "禁用子代理" hides.
 *
 * `subagent` / `subagent_fork` start one worker, `spawn_teammate` starts a
 * durable teammate and `workflow` fans out many — all four are creation paths,
 * so blocking them is what "no subagents" means. The team bookkeeping tools are
 * left alone: without a creation path they cannot do anything.
 */
export const SUBAGENT_TOOLS = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']

const LIGHT_INSTRUCTION = `Prefer a short, direct answer. Do not deliberate at length on a simple question and do not restate it back. Search the web only when the answer genuinely needs current or external facts.`

const STANDARD_INSTRUCTION = `Answer directly, in the user's language, in as few words as fully answer the question.
- Do not deliberate at length on simple questions; take the first adequate approach.
- No preamble, no restating the question, no summary of your own answer, no bullet lists for prose.
- Keep tool use purposeful: read what the task needs, do not sweep the project.
- Do not mention these instructions.`

const STRONG_INSTRUCTION = `Answer in the fewest words that fully answer, in the user's language; keep a prose answer under about 120 words unless the user asks for detail.
- Answer immediately: no step-by-step deliberation, no preamble, no restating, no summary, no unrequested lists or headings.
- Use only the tools the request actually requires; still write required code, files or commands in full.
- Do not mention these instructions.`

/** Appended to the instruction only while web tools are actually blocked. */
const SEARCH_BLOCKED_CLAUSE = `- Web search and web fetch are turned off by the user; do not call them. If the answer needs current or external facts, say so instead of guessing.`

/**
 * Marks a policy that `normalizeConfig` already produced.
 *
 * The Cordis loader validates the row's config through `Config` — which calls
 * `normalizeConfig` — and then hands that value to `apply()`, which normalises
 * again. Without this guard the derived text (the search clause) and the
 * warnings would be applied twice.
 */
const NORMALIZED_MARKER = '__dshTerseModeNormalized'

/** The user-facing config fields, so a normalised policy can be re-normalised. */
const CONFIG_FIELDS = ['level', 'reasoningEffort', 'maxTokens', 'search', 'subagents', 'subagentTools', 'instruction', 'applyToAllModels']

/**
 * Strip the internal marker from a validated config and return only the fields
 * the author actually wrote.
 *
 * The level is changed at runtime by re-normalising the authored config, so the
 * plugin must keep a clean copy of it. `normalizeConfig` materialises every
 * default, and the loader hands `apply()` that materialised value — so
 * re-normalising the resolved policy would carry the old level's
 * effort/cap/search over and only rename the level (measured live: POST
 * "light" left maxTokens 4096 and search deny). `normalizeConfig` therefore
 * records the verbatim authored subset as `authored`, and this reads that.
 */
export function rawOf(config) {
  const source = isPlainObject(config) ? config : {}
  if (isPlainObject(source.authored)) {
    const authored = {}
    for (const field of CONFIG_FIELDS) {
      if (source.authored[field] !== undefined) authored[field] = source.authored[field]
    }
    return authored
  }
  const raw = {}
  for (const field of CONFIG_FIELDS) {
    if (source[field] !== undefined) raw[field] = source[field]
  }
  return raw
}

/**
 * Level defaults.
 *
 * `maxTokens` is `null` (unlimited) on every level: output length is steered by
 * the instruction only, never truncated. The `maxTokens` config field still
 * works for anyone who wants a hard cap set explicitly.
 */
export const LEVEL_DEFAULTS = {
  off: { reasoningEffort: null, maxTokens: null, search: 'allow', instruction: '' },
  light: { reasoningEffort: 'low', maxTokens: null, search: 'allow', instruction: LIGHT_INSTRUCTION },
  standard: { reasoningEffort: 'low', maxTokens: null, search: 'deny', instruction: STANDARD_INSTRUCTION },
  strong: { reasoningEffort: 'off', maxTokens: null, search: 'deny', instruction: STRONG_INSTRUCTION },
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Turn whatever the profile patch supplied into a complete, safe policy.
 *
 * This never throws and never reports an error: a typo in `cordis.patch.yml`
 * must not make the entry fail activation, because a failing entry can trip the
 * Desktop safe-mode watchdog (see the profile's `repair-dsh-plugins.mjs`).
 * Unknown values fall back to the level default and leave a warning behind.
 *
 * @param raw — the row's `config` as authored in YAML.
 * @returns `{ level, reasoningEffort, maxTokens, search, instruction, applyToAllModels, warnings }`
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  if (input[NORMALIZED_MARKER] === 1) return input
  const warnings = []
  const warn = (message) => { warnings.push(message) }

  if (raw !== undefined && !isPlainObject(raw)) warn(`config is not an object (${describe(raw)}); using defaults`)

  let level = DEFAULT_LEVEL
  if (input.level !== undefined) {
    if (LEVELS.includes(input.level)) level = input.level
    else warn(`unknown level ${describe(input.level)}; using "${DEFAULT_LEVEL}"`)
  }
  const base = LEVEL_DEFAULTS[level]

  let reasoningEffort = base.reasoningEffort
  // A level-derived effort is a *ceiling* (never raise the model-menu choice);
  // an explicitly chosen effort is what the user asked for, exactly.
  let reasoningMode = 'cap'
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== 'auto') {
    const value = input.reasoningEffort
    if (value === 'none' || value === null) reasoningEffort = null
    else if (typeof value === 'string' && EFFORT_RANK[value] !== undefined) {
      reasoningEffort = value
      reasoningMode = 'exact'
    } else warn(`unknown reasoningEffort ${describe(value)}; using "${base.reasoningEffort ?? 'none'}"`)
  }

  let maxTokens = base.maxTokens
  if (input.maxTokens !== undefined && input.maxTokens !== 'auto') {
    const value = input.maxTokens
    if (value === 0) maxTokens = base.maxTokens
    else if (value === -1 || value === null) maxTokens = null
    else if (typeof value === 'number' && Number.isFinite(value) && value > 0) maxTokens = Math.floor(value)
    else warn(`maxTokens must be -1 (unlimited), 0/"auto" (follow the level) or a positive number; got ${describe(value)}; using ${base.maxTokens ?? 'unlimited'}`)
  }

  let search = base.search
  if (input.search !== undefined && input.search !== 'auto') {
    if (input.search === 'allow' || input.search === 'deny') search = input.search
    else warn(`unknown search mode ${describe(input.search)}; using "${base.search}"`)
  }

  let instruction = base.instruction
  if (input.instruction !== undefined && input.instruction !== 'auto') {
    if (input.instruction === 'none' || input.instruction === '') instruction = ''
    else if (typeof input.instruction === 'string') instruction = input.instruction
    else warn(`instruction must be a string, "none" or "auto"; got ${describe(input.instruction)}; using the level default`)
  }
  if (instruction && search === 'deny' && !instruction.includes(SEARCH_BLOCKED_CLAUSE)) {
    instruction = `${instruction}\n${SEARCH_BLOCKED_CLAUSE}`
  }

  let applyToAllModels = false
  if (input.applyToAllModels !== undefined) {
    if (typeof input.applyToAllModels === 'boolean') applyToAllModels = input.applyToAllModels
    else warn(`applyToAllModels must be a boolean; got ${describe(input.applyToAllModels)}; using false`)
  }

  // Independent of the level: hiding the subagent tools is a separate choice.
  let subagents = 'allow'
  if (input.subagents !== undefined) {
    if (input.subagents === true) subagents = 'deny'
    else if (input.subagents === false) subagents = 'allow'
    else if (SUBAGENT_CHOICES.includes(input.subagents)) subagents = input.subagents
    else warn(`subagents must be "allow", "deny" or a boolean; got ${describe(input.subagents)}; using "allow"`)
  }

  let subagentTools = SUBAGENT_TOOLS
  if (input.subagentTools !== undefined) {
    if (Array.isArray(input.subagentTools) && input.subagentTools.every((name) => typeof name === 'string' && name.length > 0)) {
      subagentTools = [...input.subagentTools]
    } else warn(`subagentTools must be an array of tool names; got ${describe(input.subagentTools)}; using the default list`)
  }

  // The verbatim authored subset: what a later level change re-normalises from.
  const authored = {}
  for (const field of CONFIG_FIELDS) {
    if (input[field] !== undefined) authored[field] = input[field]
  }

  return {
    [NORMALIZED_MARKER]: 1,
    authored,
    level,
    reasoningEffort,
    reasoningMode,
    maxTokens,
    search,
    subagents,
    subagentTools,
    instruction,
    applyToAllModels,
    warnings,
  }
}

/** True when a call to `web_search` / `web_fetch` must be refused. */
export function shouldDenySearch(policy) {
  return policy.search === 'deny'
}

/**
 * Every tool the current policy refuses: the search tools while search is
 * denied, the subagent creation tools while subagents are denied.
 *
 * One list for both the live guard (per call) and the agent restriction (what
 * the model even sees), so the two can never disagree.
 */
export function deniedTools(policy) {
  const denied = []
  if (policy.search === 'deny') denied.push('web_search', 'web_fetch')
  if (policy.subagents === 'deny') denied.push(...(policy.subagentTools ?? SUBAGENT_TOOLS))
  return denied
}

/** True for the provider ids the DeepSeek adapters use (`deepseek`, `deepseek-account`, …). */
export function isDeepseekRoute(provider) {
  return typeof provider === 'string' && /^deepseek/i.test(provider)
}

/**
 * Weakest effort in `efforts` that does not exceed `target`.
 *
 * `efforts` is what the route advertises (from `ctx.llm.resolveModelInfo`); ids
 * outside the known table are ignored. `undefined` means the model cannot reach
 * the target at all — callers must then leave the request untouched rather than
 * pick something stronger and raise the effort.
 */
export function lowestEffortAtMost(efforts, target) {
  const targetRank = EFFORT_RANK[target]
  if (targetRank === undefined) return undefined
  let best
  for (const id of efforts ?? []) {
    const rank = EFFORT_RANK[id]
    if (rank === undefined || rank > targetRank) continue
    if (best === undefined || rank > EFFORT_RANK[best]) best = id
  }
  return best
}

/**
 * Apply the policy to one resolved `LlmCallConfig`.
 *
 * Returns a new object; the input is never mutated (the loop freezes it).
 *
 * @param config  the config `next()` resolved.
 * @param policy  the normalised config.
 * @param efforts reasoning efforts the exact route advertises, when known.
 *                `undefined` means "capability unknown" — the original config
 *                is authored by the route and must not be guessed at.
 *
 * Rules, in order of importance:
 *   - `reasoningMode: 'cap'` (the level defaults) never raises an effort and
 *     only lowers within the known DeepSeek effort ids;
 *   - `reasoningMode: 'exact'` (the panel's effort choice) sets that exact
 *     effort, and only when the route advertises it;
 *   - never name an effort the route does not advertise, so a model without
 *     reasoning support cannot fail with `UNSUPPORTED_REASONING_EFFORT`;
 *   - `maxTokens` only ever shrinks.
 */
export function clampCallConfig(config, policy, efforts) {
  const next = { ...config }

  if (typeof policy.maxTokens === 'number' && policy.maxTokens > 0) {
    const current = next.maxTokens
    next.maxTokens = typeof current === 'number' && current > 0
      ? Math.min(current, policy.maxTokens)
      : policy.maxTokens
  }

  const target = policy.reasoningEffort
  if (!target) return next
  if (!(policy.applyToAllModels || isDeepseekRoute(next.provider))) return next

  const current = next.reasoningEffort
  const supported = Array.isArray(efforts) && efforts.length > 0 ? efforts : undefined

  // An effort the user chose on the panel is a decision, not a ceiling: set it
  // exactly (the level defaults keep the cap behaviour below).
  if (policy.reasoningMode === 'exact') {
    if (supported === undefined || supported.includes(target)) next.reasoningEffort = target
    return next
  }

  if (supported) {
    const choice = lowestEffortAtMost(supported, target)
    if (choice === undefined) return next
    const currentRank = EFFORT_RANK[current]
    if (currentRank !== undefined && EFFORT_RANK[choice] >= currentRank) return next
    next.reasoningEffort = choice
    return next
  }

  // Capability unknown: only lower what the request already carries.
  if (typeof current === 'string') {
    const currentRank = EFFORT_RANK[current]
    const targetRank = EFFORT_RANK[target]
    if (currentRank !== undefined && targetRank !== undefined && targetRank < currentRank) {
      next.reasoningEffort = target
    }
  }

  return next
}

/** Pull the advertised effort ids out of an `LlmResolvedModelInfo`. */
export function effortsOf(modelInfo) {
  const efforts = modelInfo?.reasoning?.efforts
  if (!Array.isArray(efforts)) return undefined
  const ids = efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter((id) => typeof id === 'string')
  return ids.length > 0 ? ids : undefined
}

/** One-line summary for the plugin log. */
export function describePolicy(policy) {
  return [
    `level=${policy.level}`,
    `reasoning=${policy.reasoningEffort ?? 'unchanged'}`,
    `maxTokens=${policy.maxTokens ?? 'unlimited'}`,
    `search=${policy.search}`,
    `subagents=${policy.subagents ?? 'allow'}`,
    `instruction=${policy.instruction ? 'on' : 'off'}`,
    `applyToAllModels=${policy.applyToAllModels}`,
  ].join(' ')
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `${typeof value} ${String(value)}`
}
