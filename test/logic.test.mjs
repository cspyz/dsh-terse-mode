import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EFFORT_RANK,
  LEVELS,
  clampCallConfig,
  deniedTools,
  describePolicy,
  effortsOf,
  isDeepseekRoute,
  lowestEffortAtMost,
  normalizeConfig,
  rawOf,
  shouldDenySearch,
} from '../lib/logic.js'

describe('normalizeConfig', () => {
  it('falls back to the standard level for a bare config', () => {
    const policy = normalizeConfig(undefined)
    assert.equal(policy.level, 'standard')
    assert.equal(policy.reasoningEffort, 'low')
    assert.equal(policy.maxTokens, null, 'no level caps the output')
    assert.equal(policy.search, 'deny')
    assert.equal(policy.applyToAllModels, false)
    assert.deepEqual(policy.warnings, [])
  })

  it('never throws and always warns instead', () => {
    const policy = normalizeConfig({ level: 'loud', reasoningEffort: 'ultra', maxTokens: 'many', search: 'maybe', applyToAllModels: 'yes' })
    assert.equal(policy.level, 'standard')
    assert.equal(policy.reasoningEffort, 'low')
    assert.equal(policy.maxTokens, null)
    assert.equal(policy.search, 'deny')
    assert.equal(policy.applyToAllModels, false)
    assert.equal(policy.warnings.length, 5)
  })

  it('survives a non-object config', () => {
    const policy = normalizeConfig('standard')
    assert.equal(policy.level, 'standard')
    assert.equal(policy.warnings.length, 1)
  })

  it('keeps a valid level', () => {
    for (const level of LEVELS) assert.equal(normalizeConfig({ level }).level, level)
  })

  for (const level of LEVELS) {
    it(`level ${level} is internally consistent`, () => {
      const policy = normalizeConfig({ level })
      assert.ok(policy.reasoningEffort === null || EFFORT_RANK[policy.reasoningEffort] !== undefined)
      assert.ok(policy.maxTokens === null || policy.maxTokens > 0)
      assert.ok(policy.search === 'allow' || policy.search === 'deny')
      assert.equal(typeof policy.instruction, 'string')
    })
  }

  it('off disables everything', () => {
    const policy = normalizeConfig({ level: 'off' })
    assert.equal(policy.reasoningEffort, null)
    assert.equal(policy.maxTokens, null)
    assert.equal(policy.search, 'allow')
    assert.equal(policy.instruction, '')
  })

  it('accepts "none" to leave the reasoning effort alone', () => {
    assert.equal(normalizeConfig({ level: 'strong', reasoningEffort: 'none' }).reasoningEffort, null)
  })

  it('treats maxTokens 0 as "follow the level" and -1 as unlimited', () => {
    assert.equal(normalizeConfig({ level: 'strong', maxTokens: 0 }).maxTokens, null, 'the strong level no longer caps output')
    assert.equal(normalizeConfig({ level: 'strong', maxTokens: -1 }).maxTokens, null)
    assert.equal(normalizeConfig({ level: 'standard', maxTokens: 999.9 }).maxTokens, 999, 'an explicit cap still works')
  })

  it('appends the search clause only while web tools are blocked', () => {
    const denied = normalizeConfig({ level: 'standard' })
    const allowed = normalizeConfig({ level: 'standard', search: 'allow' })
    assert.match(denied.instruction, /Web search and web fetch are turned off/)
    assert.doesNotMatch(allowed.instruction, /turned off/)
    assert.equal(allowed.search, 'allow')
  })

  it('honours a custom instruction and "none"', () => {
    assert.equal(normalizeConfig({ instruction: 'Be terse.' }).instruction, 'Be terse.\n- Web search and web fetch are turned off by the user; do not call them. If the answer needs current or external facts, say so instead of guessing.')
    assert.equal(normalizeConfig({ instruction: 'none' }).instruction, '')
    assert.equal(normalizeConfig({ level: 'off', instruction: 'Be terse.' }).instruction, 'Be terse.')
  })

  it('is idempotent, because the loader normalises and then apply() normalises again', () => {
    const once = normalizeConfig({ level: 'standard' })
    const twice = normalizeConfig(once)
    assert.equal(twice, once)
    assert.equal(twice.instruction.split('Web search and web fetch are turned off').length - 1, 1)
    assert.deepEqual(twice.warnings, [])

    const noisy = normalizeConfig({ level: 'bogus' })
    assert.equal(normalizeConfig(noisy).warnings.length, 1)
  })

  it('distinguishes a level default (ceiling) from a chosen effort (exact)', () => {
    assert.equal(normalizeConfig({ level: 'standard' }).reasoningMode, 'cap')
    assert.equal(normalizeConfig({ level: 'standard', reasoningEffort: 'auto' }).reasoningMode, 'cap')
    assert.equal(normalizeConfig({ level: 'standard', reasoningEffort: 'high' }).reasoningMode, 'exact')
    assert.equal(normalizeConfig({ level: 'strong', reasoningEffort: 'none' }).reasoningMode, 'cap')
    assert.deepEqual(rawOf(normalizeConfig({ level: 'strong', reasoningEffort: 'high' })), { level: 'strong', reasoningEffort: 'high' })
  })

  it('remembers only what the author wrote, not the materialised policy', () => {
    // The loader hands apply() the resolved policy, so rawOf must not treat the
    // resolved effort/cap/search as author choices.
    assert.deepEqual(rawOf(normalizeConfig({ level: 'standard' })), { level: 'standard' })
    assert.deepEqual(
      rawOf(normalizeConfig({ level: 'standard', maxTokens: 500, search: 'allow' })),
      { level: 'standard', maxTokens: 500, search: 'allow' },
    )
    assert.deepEqual(rawOf({ level: 'light' }), { level: 'light' })
  })

  it('re-normalising a new level drops the previous level defaults', () => {
    const authored = rawOf(normalizeConfig({ level: 'standard' }))
    const light = normalizeConfig({ ...authored, level: 'light' })
    assert.equal(light.maxTokens, null)
    assert.equal(light.search, 'allow')
    assert.doesNotMatch(light.instruction, /turned off/)

    const strong = normalizeConfig({ ...authored, level: 'strong' })
    assert.equal(strong.reasoningEffort, 'off')
    assert.equal(strong.maxTokens, null)
    assert.equal(strong.search, 'deny')
  })

  it('keeps the subagent choice independent of the level', () => {
    assert.equal(normalizeConfig({ level: 'standard' }).subagents, 'allow', 'allow is the default')
    assert.equal(normalizeConfig({ level: 'strong', subagents: 'deny' }).subagents, 'deny')
    assert.equal(normalizeConfig({ subagents: true }).subagents, 'deny', 'booleans are forgiven')
    assert.equal(normalizeConfig({ subagents: false }).subagents, 'allow')
    assert.equal(normalizeConfig({ subagents: 'maybe' }).subagents, 'allow')
    assert.match(normalizeConfig({ subagents: 'maybe' }).warnings.join(' '), /subagents must be/)
  })

  it('lets an explicit search choice override the level, in both directions', () => {
    const allowed = normalizeConfig({ level: 'strong', search: 'allow' })
    assert.equal(allowed.search, 'allow')
    assert.doesNotMatch(allowed.instruction, /turned off/)
    assert.deepEqual(deniedTools(allowed), [], 'the guard must stop blocking web tools')

    const denied = normalizeConfig({ level: 'light', search: 'deny' })
    assert.equal(denied.search, 'deny')
    assert.match(denied.instruction, /turned off/)
    assert.deepEqual(deniedTools(denied), ['web_search', 'web_fetch'])

    // `auto` is not a policy value: it means "the level decides".
    assert.equal(normalizeConfig({ level: 'light', search: 'auto' }).search, 'allow')
    assert.equal(normalizeConfig({ level: 'light', search: 'maybe' }).search, 'allow')
    assert.match(normalizeConfig({ level: 'light', search: 'maybe' }).warnings.join(' '), /unknown search mode/)
  })

  it('lists the tools each denial hides, and lets the list be replaced', () => {
    const standard = normalizeConfig({ level: 'standard' })
    assert.deepEqual(deniedTools(standard), ['web_search', 'web_fetch'])
    assert.deepEqual(deniedTools(normalizeConfig({ level: 'light' })), [], 'light allows search and subagents')
    assert.deepEqual(
      deniedTools(normalizeConfig({ level: 'standard', subagents: 'deny' })),
      ['web_search', 'web_fetch', 'subagent', 'subagent_fork', 'spawn_teammate', 'workflow'],
    )
    assert.deepEqual(
      deniedTools(normalizeConfig({ level: 'standard', subagents: 'deny', subagentTools: ['subagent'] })),
      ['web_search', 'web_fetch', 'subagent'],
    )
    assert.deepEqual(
      deniedTools(normalizeConfig({ level: 'light', subagents: 'deny' })),
      ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'],
      'a level that allows search still hides subagents when denied',
    )
  })

  it('describes the policy in one line', () => {
    assert.equal(
      describePolicy(normalizeConfig({ level: 'strong' })),
      'level=strong reasoning=off maxTokens=unlimited search=deny subagents=allow instruction=on applyToAllModels=false',
    )
  })
})

describe('clampCallConfig', () => {
  const standard = normalizeConfig({ level: 'standard' })
  const strong = normalizeConfig({ level: 'strong' })
  const off = normalizeConfig({ level: 'off' })

  it('lowers a DeepSeek route from high to low', () => {
    const result = clampCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, standard)
    assert.equal(result.reasoningEffort, 'low')
  })

  it('turns thinking off at the strong level', () => {
    const result = clampCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }, strong)
    assert.equal(result.reasoningEffort, 'off')
  })

  it('never raises the effort', () => {
    const result = clampCallConfig({ provider: 'deepseek-account', model: 'm', reasoningEffort: 'off' }, standard)
    assert.equal(result.reasoningEffort, 'off')
  })

  it('never introduces an effort the route did not carry', () => {
    const result = clampCallConfig({ provider: 'deepseek-account', model: 'm' }, strong)
    assert.equal('reasoningEffort' in result, false)
  })

  it('leaves an unknown effort id alone', () => {
    const result = clampCallConfig({ provider: 'deepseek-account', model: 'm', reasoningEffort: 'medium' }, strong)
    assert.equal(result.reasoningEffort, 'medium')
  })

  it('only touches DeepSeek routes by default', () => {
    const foreign = { provider: 'openrouter', model: 'x', reasoningEffort: 'high' }
    assert.equal(clampCallConfig(foreign, standard).reasoningEffort, 'high')
    const forced = clampCallConfig(foreign, normalizeConfig({ level: 'standard', applyToAllModels: true }))
    assert.equal(forced.reasoningEffort, 'low')
  })

  it('picks the advertised effort when the route carries none yet', () => {
    // The adapter default is materialised after this waterfall, so an unset
    // effort is the normal case for a fresh conversation.
    const efforts = ['off', 'low', 'high', 'max']
    assert.equal(clampCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' }, standard, efforts).reasoningEffort, 'low')
    assert.equal(clampCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' }, strong, efforts).reasoningEffort, 'off')
  })

  it('leaves the request alone when the model cannot reach the target', () => {
    const onlyStrong = ['high', 'max']
    assert.equal('reasoningEffort' in clampCallConfig({ provider: 'deepseek', model: 'm' }, strong, onlyStrong), false)
  })

  it('cannot raise an effort through the advertised list either', () => {
    const efforts = ['off', 'low', 'high', 'max']
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'off' }, standard, efforts).reasoningEffort, 'off')
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'low' }, strong, efforts).reasoningEffort, 'off')
  })

  it('still refuses to guess when the capability is unknown', () => {
    assert.equal('reasoningEffort' in clampCallConfig({ provider: 'deepseek', model: 'm' }, standard, undefined), false)
  })

  it('honours an explicitly chosen effort, including raising it', () => {
    const efforts = ['off', 'low', 'high', 'max']
    const chosen = normalizeConfig({ level: 'standard', reasoningEffort: 'high' })
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'low' }, chosen, efforts).reasoningEffort, 'high')
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm' }, chosen, efforts).reasoningEffort, 'high')

    // ...but never a value the route does not advertise: leave it alone instead.
    assert.equal('reasoningEffort' in clampCallConfig({ provider: 'deepseek', model: 'm' }, chosen, ['low']), false)
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm' }, chosen, ['low', 'high']).reasoningEffort, 'high')

    const off = normalizeConfig({ level: 'standard', reasoningEffort: 'off' })
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'max' }, off, efforts).reasoningEffort, 'off')
  })

  it('keeps the ceiling behaviour for a level-derived effort', () => {
    const efforts = ['off', 'low', 'high', 'max']
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'low' }, normalizeConfig({ level: 'standard', reasoningEffort: 'high' }), efforts).reasoningEffort, 'high')
    // A cap never raises: standard caps at low, so a lower current value stays.
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'off' }, standard, efforts).reasoningEffort, 'off')
  })

  it('leaves output length alone unless a cap was configured explicitly', () => {
    // No level caps output any more.
    assert.equal('maxTokens' in clampCallConfig({ provider: 'deepseek', model: 'm' }, standard), false)
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', maxTokens: 9000 }, strong).maxTokens, 9000, 'the route keeps its own cap')

    const capped = normalizeConfig({ level: 'standard', maxTokens: 4096 })
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', maxTokens: 100_000 }, capped).maxTokens, 4096)
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm', maxTokens: 256 }, capped).maxTokens, 256, 'never grows')
    assert.equal(clampCallConfig({ provider: 'deepseek', model: 'm' }, capped).maxTokens, 4096)
  })

  it('does nothing at the off level', () => {
    const config = { provider: 'deepseek-account', model: 'm', reasoningEffort: 'max', maxTokens: 5000 }
    assert.deepEqual(clampCallConfig(config, off), config)
  })

  it('does not mutate the frozen input', () => {
    const config = Object.freeze({ provider: 'deepseek-account', model: 'm', reasoningEffort: 'high', maxTokens: 9000 })
    const result = clampCallConfig(config, standard)
    assert.equal(config.reasoningEffort, 'high')
    assert.equal(config.maxTokens, 9000)
    assert.notEqual(result, config)
  })
})

describe('policy helpers', () => {
  it('recognises DeepSeek provider ids', () => {
    assert.equal(isDeepseekRoute('deepseek'), true)
    assert.equal(isDeepseekRoute('deepseek-account'), true)
    assert.equal(isDeepseekRoute('DeepSeek-Official'), true)
    assert.equal(isDeepseekRoute('openrouter'), false)
    assert.equal(isDeepseekRoute(undefined), false)
  })

  it('chooses the weakest effort that does not exceed the target', () => {
    const deepseek = ['off', 'low', 'high', 'max']
    assert.equal(lowestEffortAtMost(deepseek, 'low'), 'low')
    assert.equal(lowestEffortAtMost(deepseek, 'off'), 'off')
    assert.equal(lowestEffortAtMost(['low', 'medium', 'high'], 'low'), 'low')
    assert.equal(lowestEffortAtMost(['medium', 'high'], 'off'), undefined)
    assert.equal(lowestEffortAtMost(['high', 'max'], 'low'), undefined)
    assert.equal(lowestEffortAtMost([], 'low'), undefined)
    assert.equal(lowestEffortAtMost(undefined, 'low'), undefined)
    assert.equal(lowestEffortAtMost(['bogus', 'low'], 'low'), 'low')
  })

  it('reads advertised efforts out of a resolved model info', () => {
    assert.deepEqual(effortsOf({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }), ['low', 'high'])
    assert.deepEqual(effortsOf({ reasoning: { efforts: ['off', 'max'] } }), ['off', 'max'])
    assert.equal(effortsOf({}), undefined)
    assert.equal(effortsOf({ reasoning: {} }), undefined)
    assert.equal(effortsOf({ reasoning: { efforts: [] } }), undefined)
    assert.equal(effortsOf({ reasoning: { efforts: [{ name: 'Low' }] } }), undefined)
  })

  it('maps search modes to the deny decision', () => {
    assert.equal(shouldDenySearch(normalizeConfig({ level: 'standard' })), true)
    assert.equal(shouldDenySearch(normalizeConfig({ level: 'standard', search: 'allow' })), false)
    assert.equal(shouldDenySearch(normalizeConfig({ level: 'off' })), false)
  })
})
