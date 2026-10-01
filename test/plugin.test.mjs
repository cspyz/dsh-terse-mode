/**
 * Exercises the real `apply()` against a small fake Cordis context.
 *
 * The point is the wiring, not the policy maths (see logic.test.mjs): that the
 * request listener is registered outermost, that the guard is live, that tool
 * restrictions are owned and released, and that a hostile collaborator cannot
 * make `apply` or an `agent/created` listener throw.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

import { apply, Config } from '../index.js'

// Never read the real harness home: the level store lives under it, and a
// remembered level would change what these tests observe.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'terse-mode-plugin-home-'))

/** Minimal stand-in for a Cordis context. */
function fakeContext({ toolsBehaviour = 'normal', agents = [], modelInfo = 'reasoning', webServerLate = false } = {}) {
  const state = {
    sections: [],
    effects: [],
    // Effects registered on an `agent.ctx` live in the agent's own fiber, not
    // in the plugin's, so they must not be released with the plugin.
    agentEffects: [],
    agents,
    waterfall: [],
    serial: [],
    guards: [],
    restrictions: [],
    restrictionsReleased: 0,
    logs: [],
    modelInfoCalls: 0,
    routes: [],
    injects: [],
    webServerCallbacks: [],
    services: {},
  }

  const llm = {
    async resolveModelInfo() {
      state.modelInfoCalls += 1
      if (modelInfo === 'throws') throw new Error('endpoint unreachable')
      if (modelInfo === 'none') return { provider: 'deepseek-account', model: 'deepseek-flash' }
      return { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
    },
  }
  state.services.llm = llm

  const releaseAll = () => {
    let released = 0
    while (state.effects.length > 0) {
      const dispose = state.effects.pop()
      try { dispose?.() } catch { /* ignore */ }
      released += 1
    }
    return released
  }

  const tools = {
    guard(guard) {
      state.guards.push(guard)
      return () => { state.guards = state.guards.filter((g) => g !== guard) }
    },
    restrict(filter) {
      if (toolsBehaviour === 'unknown-tool') throw new Error('tools.restrict() names unknown global tool "web_search"')
      if (toolsBehaviour === 'partial' && filter.deny.includes('web_fetch')) throw new Error('tools.restrict() names unknown global tool "web_fetch"')
      state.restrictions.push(filter)
      return () => { state.restrictionsReleased += 1 }
    },
  }

  const services = {
    systemPrompt: {
      section(section) {
        state.sections.push(section)
        return () => { state.sections = state.sections.filter((s) => s !== section) }
      },
    },
    tools,
    agents: { list: () => agents },
    // The panel's route; registered once the web server is there.
    webServer: {
      register(route) {
        if (state.routes.some((existing) => existing.path === route.path)) throw new Error(`duplicate route ${route.path}`)
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((r) => r !== route) }
      },
    },
    ...state.services,
  }

  const makeAgent = (id) => ({
    id,
    ctx: {
      // Property access, because that is what rebinds the service to this scope.
      tools,
      get: (name) => (name === 'tools' ? tools : services[name]),
      effect(execute) {
        const dispose = execute()
        state.agentEffects.push(dispose)
        return dispose
      },
    },
  })

  const ctx = {
    systemPrompt: services.systemPrompt,
    tools,
    logger: (name) => ({
      info: (text) => state.logs.push(['info', name, text]),
      warn: (text) => state.logs.push(['warn', name, text]),
    }),
    get: (name) => (webServerLate && name === 'webServer' ? undefined : services[name]),
    // Optional, late injection — the shipped pattern, and what the real host
    // needs: the web server mounts *after* this row.
    inject(deps, callback) {
      if (!deps.includes('webServer')) return
      state.injects.push('webServer')
      if (webServerLate) state.webServerCallbacks.push(() => callback({ ...ctx, get: (name) => services[name] }))
      else callback(ctx)
    },
    effect(execute) {
      const dispose = execute()
      state.effects.push(dispose)
      return dispose
    },
    on(event, listener, options) {
      const bucket = event === 'agent/created' ? state.serial : state.waterfall
      if (options?.prepend) bucket.unshift(listener)
      else bucket.push(listener)
      return () => {
        const index = bucket.indexOf(listener)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    // Fire `agent/created` the way the harness does: serial listeners run in
    // order, are awaited, and a throw rejects creation.
    async createAgent(id = 'a1') {
      const agent = makeAgent(id)
      state.agents.push(agent)
      for (const listener of [...state.serial]) await listener({ agent, source: 'fresh' })
      return agent
    },
    makeAgent,
    async requestConfig(seed) {
      let index = -1
      const next = () => {
        index += 1
        const listener = state.waterfall[index]
        return listener ? listener({ turn: 1, step: 1 }, next) : Promise.resolve(seed)
      }
      return next()
    },
    releaseAll,
  }

  return { ctx, state, services }
}

/** Mimics the UI's model-selection listener: it re-applies the picked effort. */
function modelSelectionListener(effort) {
  return async (_payload, next) => {
    const resolved = await next()
    const { reasoningEffort: _inherited, ...rest } = resolved
    return { ...rest, reasoningEffort: effort }
  }
}

describe('Config schema', () => {
  it('is a standard schema that materialises defaults', () => {
    assert.ok(Config['~standard'])
    assert.equal(Config['~standard'].validate.length, 1)
    const result = Config['~standard'].validate({ level: 'strong' })
    assert.equal(result.value.level, 'strong')
    assert.equal(result.value.reasoningEffort, 'off')
  })

  it('never reports issues, even for nonsense', () => {
    const result = Config['~standard'].validate({ level: 42, maxTokens: -99 })
    assert.equal(result.issues, undefined)
    assert.equal(result.value.level, 'standard')
    assert.equal(result.value.maxTokens, null)
    assert.ok(result.value.warnings.length >= 2)
  })
})

describe('apply()', () => {
  let harness

  beforeEach(() => {
    harness = fakeContext()
  })

  it('adds one last prompt section and applies the web policy', async () => {
    apply(harness.ctx, { level: 'standard' })
    assert.equal(harness.state.sections.length, 1)
    const section = harness.state.sections[0]
    assert.equal(section.name, 'plugin:terse-mode')
    assert.equal(section.interpolate, false)
    assert.ok(section.order > 10200, 'must sort after every shipped section')
    assert.match(section.text, /Answer directly/)

    assert.equal(harness.state.guards.length, 1)
    assert.match(harness.state.guards[0]({ name: 'web_search' }), /turned off/)
    assert.match(harness.state.guards[0]({ name: 'web_fetch' }), /turned off/)
    assert.equal(harness.state.guards[0]({ name: 'read' }), undefined)

    const agent = await harness.ctx.createAgent()
    assert.deepEqual(harness.state.restrictions, [{ deny: ['web_search', 'web_fetch'] }])
    assert.equal(agent.id, 'a1')
  })

  it('keeps the clamp outermost, so the UI model selection cannot undo it', async () => {
    apply(harness.ctx, { level: 'standard' })
    // Registered later without prepend, exactly like installModelSelection.
    harness.state.waterfall.push(modelSelectionListener('high'))

    const result = await harness.ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' })
    assert.equal(result.reasoningEffort, 'low')
    assert.equal('maxTokens' in result, false, 'no level caps output any more')
  })

  it('caps output tokens only when a cap was configured explicitly', async () => {
    apply(harness.ctx, { level: 'standard', maxTokens: 4096 })
    assert.equal((await harness.ctx.requestConfig({ provider: 'deepseek', model: 'm', maxTokens: 999_999 })).maxTokens, 4096)
    assert.equal((await harness.ctx.requestConfig({ provider: 'deepseek', model: 'm', maxTokens: 64 })).maxTokens, 64)

    const uncapped = fakeContext()
    apply(uncapped.ctx, { level: 'standard' })
    assert.equal('maxTokens' in await uncapped.ctx.requestConfig({ provider: 'deepseek', model: 'm', maxTokens: 999_999 }), true)
  })

  it('leaves non-DeepSeek routes alone unless asked', async () => {
    apply(harness.ctx, { level: 'strong' })
    const foreign = await harness.ctx.requestConfig({ provider: 'openrouter', model: 'x', reasoningEffort: 'high' })
    assert.equal(foreign.reasoningEffort, 'high')

    const forced = fakeContext()
    apply(forced.ctx, { level: 'strong', applyToAllModels: true })
    const clamped = await forced.ctx.requestConfig({ provider: 'openrouter', model: 'x', reasoningEffort: 'high' })
    assert.equal(clamped.reasoningEffort, 'off')
  })

  it('pins a low effort when the adapter default has not been applied yet', async () => {
    apply(harness.ctx, { level: 'standard' })
    // Nothing pinned an effort: without the capability lookup the adapter
    // default (`high`) would win after this waterfall.
    const result = await harness.ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.equal(result.reasoningEffort, 'low')
    // ...and the lookup is cached per route.
    await harness.ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.equal(harness.state.modelInfoCalls, 1)
  })

  it('registers the panel API when the web server only appears after this row', () => {
    // Measured on the real host: `ctx.get('webServer')` is empty at apply time
    // because the web server mounts later, so a plain lookup never registered
    // the route and the panel showed "未连上宿主" forever while everything else
    // (prompt, guard, restrictions) worked.
    const late = fakeContext({ webServerLate: true })
    apply(late.ctx, { level: 'standard' })
    assert.equal(late.state.routes.length, 0, 'not registered yet')
    assert.deepEqual(late.state.injects, ['webServer'], 'the plugin must ask for the service')
    assert.equal(late.state.guards.length, 1, 'the rest of the plugin works meanwhile')

    // The service arrives: the injected callback runs and the route appears.
    for (const deliver of late.state.webServerCallbacks) deliver()
    assert.equal(late.state.routes.length, 1)
    assert.equal(late.state.routes[0].path, '/dsh-terse-mode/api/state')
    assert.ok(!late.state.logs.some(([, , text]) => /no web server/.test(text)), 'no bogus warning')
  })

  it('leaves the request untouched when the capability lookup fails', async () => {
    const flaky = fakeContext({ modelInfo: 'throws' })
    apply(flaky.ctx, { level: 'strong' })
    const result = await flaky.ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.equal('reasoningEffort' in result, false)
    assert.equal('maxTokens' in result, false, 'nothing caps output by default')
    assert.ok(flaky.state.logs.some(([level, , text]) => level === 'warn' && /could not read the reasoning capability/.test(text)))
  })

  it('does not force an effort onto a model that advertises none', async () => {
    const noReasoning = fakeContext({ modelInfo: 'none' })
    apply(noReasoning.ctx, { level: 'strong' })
    const result = await noReasoning.ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-chat' })
    assert.equal('reasoningEffort' in result, false)
  })

  it('is a no-op at level off', async () => {
    apply(harness.ctx, { level: 'off' })
    assert.equal(harness.state.sections.length, 0)
    // The request listener stays registered so a live level change takes effect
    // without re-registering; at `off` it copies the config unchanged.
    assert.equal(harness.state.waterfall.length, 1)
    assert.equal(harness.state.guards.length, 1, 'the guard stays registered but allows everything')
    assert.equal(harness.state.guards[0]({ name: 'web_search' }), undefined)

    await harness.ctx.createAgent()
    assert.equal(harness.state.restrictions.length, 0)
    const untouched = await harness.ctx.requestConfig({ provider: 'deepseek', model: 'm', reasoningEffort: 'max' })
    assert.equal(untouched.reasoningEffort, 'max')
    assert.equal('maxTokens' in untouched, false)
  })

  it('releases its registrations when the plugin unloads', async () => {
    apply(harness.ctx, { level: 'standard' })
    await harness.ctx.createAgent()
    assert.equal(harness.state.restrictions.length, 1)

    harness.ctx.releaseAll()
    assert.equal(harness.state.sections.length, 0)
    assert.equal(harness.state.guards.length, 0)
    assert.equal(harness.state.restrictionsReleased, 1)
  })

  it('survives a tools.restrict() that rejects unknown tool names', async () => {
    const hostile = fakeContext({ toolsBehaviour: 'unknown-tool' })
    apply(hostile.ctx, { level: 'standard' })
    const agent = await hostile.ctx.createAgent() // must not reject
    assert.equal(agent.id, 'a1')
    assert.ok(hostile.state.logs.some(([level, , text]) => level === 'warn' && /could not hide the denied tools/.test(text)))
  })

  it('still hides the names that do exist when one is unknown', async () => {
    const partial = fakeContext({ toolsBehaviour: 'partial' })
    apply(partial.ctx, { level: 'standard' })
    await partial.ctx.createAgent()
    assert.deepEqual(partial.state.restrictions, [{ deny: ['web_search'] }])
  })

  it('restricts agents that already exist when the row is applied', async () => {
    harness.state.agents.push(harness.ctx.makeAgent('already-open'))
    apply(harness.ctx, { level: 'strong' })
    assert.deepEqual(harness.state.restrictions, [{ deny: ['web_search', 'web_fetch'] }])
  })

  it('hides the subagent tools and refuses their calls when subagents are denied', async () => {
    apply(harness.ctx, { level: 'light', subagents: 'deny' })
    await harness.ctx.createAgent()
    assert.deepEqual(harness.state.restrictions, [{ deny: ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'] }])

    const guard = harness.state.guards[0]
    assert.match(guard({ name: 'subagent' }), /Subagents are turned off/)
    assert.match(guard({ name: 'workflow' }), /Subagents are turned off/)
    assert.equal(guard({ name: 'web_search' }), undefined, 'light still allows search')
    assert.equal(guard({ name: 'read' }), undefined)
  })

  it('logs the effective policy and every fallback warning', () => {
    apply(harness.ctx, { level: 'nonsense' })
    const info = harness.state.logs.find(([level]) => level === 'info')
    assert.match(info[2], /level=standard reasoning=low maxTokens=unlimited search=deny/)
    assert.ok(harness.state.logs.some(([level, , text]) => level === 'warn' && /unknown level/.test(text)))
  })

  it('adds the search clause once when apply() receives the already-validated config', () => {
    // Exactly what the loader does: validate through Config, then apply.
    apply(harness.ctx, Config['~standard'].validate({ level: 'standard' }).value)
    const section = harness.state.sections[0]
    assert.equal(section.text.split('Web search and web fetch are turned off').length - 1, 1)
    assert.equal(harness.state.logs.filter(([level]) => level === 'warn').length, 0)
  })
})
