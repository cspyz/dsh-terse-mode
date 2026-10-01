/**
 * The panel's host side: request handling, the level and reasoning-effort
 * controls, and a live change seen from `apply()` — the path the
 * conversation-header widget actually takes.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, beforeEach, describe, it } from 'node:test'

import { createLevelHandler, API_PATH } from '../lib/level-api.js'
import { createLevelStore } from '../lib/store.js'
import { apply, Config } from '../index.js'

/** Minimal node:http request/response doubles. */
function request(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  return stream
}

function response() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(text) { this.body = text ?? '' },
    json() { return JSON.parse(this.body) },
  }
}

/** A controller stub: the handler's contract is what these tests pin down. */
function stub({ level = 'standard', reasoningEffort = 'low', authored = {} } = {}) {
  const policy = () => ({
    level,
    authored,
    reasoningEffort,
    reasoningMode: authored.reasoningEffort === undefined ? 'cap' : 'exact',
    maxTokens: null,
    search: 'deny',
    instruction: 'x',
  })
  return {
    calls: [],
    get runtime() { return { get policy() { return policy() } } },
    setLevel(next) { this.calls.push(['level', next]); level = next; authored = { ...authored, level: next }; return policy() },
    setReasoningEffort(next) { this.calls.push(['effort', next]); reasoningEffort = next; return policy() },
    storedAt: () => '2026-10-01T00:00:00.000Z',
  }
}

describe('the panel API', () => {
  it('answers GET with the level, the effort choice and the effective clamp', async () => {
    const controller = stub()
    const res = response()
    await createLevelHandler(controller)(request('GET'), res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = res.json()
    assert.equal(body.level, 'standard')
    assert.deepEqual(body.levels, ['off', 'light', 'standard', 'strong'])
    assert.equal(body.reasoningChoice, 'auto')
    assert.deepEqual(body.reasoningChoices, ['auto', 'none', 'off', 'low', 'high', 'max'])
    assert.deepEqual(body.effective, {
      reasoningEffort: 'low',
      reasoningMode: 'cap',
      maxTokens: null,
      search: 'deny',
      instruction: true,
    })
    assert.equal(body.persistedAt, '2026-10-01T00:00:00.000Z')
  })

  it('applies a POSTed level', async () => {
    const controller = stub()
    const res = response()
    await createLevelHandler(controller)(request('POST', { level: 'strong' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(controller.calls, [['level', 'strong']])
    assert.equal(res.json().level, 'strong')
  })

  it('applies a POSTed reasoning effort on its own', async () => {
    const controller = stub()
    const res = response()
    await createLevelHandler(controller)(request('POST', { reasoningEffort: 'max' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(controller.calls, [['effort', 'max']])
    assert.equal(res.json().reasoningChoice, 'auto', 'the stub policy still reports its own authored choice')
    assert.equal(res.json().effective.reasoningEffort, 'max')
  })

  it('serves an empty POST as a read (the panel lane where GET is blocked)', async () => {
    // The Desktop shell's forwarder rejects a GET through its fetch bridge, so
    // the panel reads with `POST {}`; an unknown *field* is still a 400, so a
    // typo stays diagnosed instead of being silently ignored.
    const controller = stub()
    const res = response()
    await createLevelHandler(controller)(request('POST', {}), res)
    assert.equal(res.status, 200)
    assert.equal(res.json().level, 'standard')
    assert.deepEqual(controller.calls, [])
  })

  it('applies both fields when both are sent', async () => {
    const controller = stub()
    const res = response()
    await createLevelHandler(controller)(request('POST', { level: 'light', reasoningEffort: 'off' }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(controller.calls, [['level', 'light'], ['effort', 'off']])
  })

  it('rejects unknown values and an empty body without touching the controller', async () => {
    const controller = stub()
    for (const body of [{ level: 'loud' }, { reasoningEffort: 'ultra' }, { other: true }]) {
      const res = response()
      await createLevelHandler(controller)(request('POST', body), res)
      assert.equal(res.status, 400)
      assert.match(res.json().error, /level|reasoningEffort|expected/)
    }
    assert.deepEqual(controller.calls, [])
  })

  it('rejects a malformed body', async () => {
    const controller = stub()
    const broken = Readable.from(['{not json'])
    broken.method = 'POST'
    const res = response()
    await createLevelHandler(controller)(broken, res)
    assert.equal(res.status, 400)
  })

  it('refuses other methods', async () => {
    const res = response()
    await createLevelHandler(stub())(request('DELETE'), res)
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, POST')
  })

  it('reports a thrown handler as JSON instead of an empty 400', async () => {
    const controller = { get runtime() { throw new Error('boom') }, setLevel: () => undefined }
    const res = response()
    await createLevelHandler(controller)(request('GET'), res)
    assert.equal(res.status, 500)
    assert.match(res.json().error, /boom/)
  })
})

describe('the level store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terse-mode-store-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips the level and the effort choice', () => {
    const ctx = { get: (name) => (name === 'dshHomePath' ? (...segments) => join(dir, ...segments) : undefined) }
    const store = createLevelStore(ctx)
    assert.equal(store.read(), undefined)
    assert.equal(typeof store.write({ level: 'strong', reasoningEffort: 'high' }), 'string')
    const stored = store.read()
    assert.equal(stored.level, 'strong')
    assert.equal(stored.reasoningEffort, 'high')
    assert.match(readFileSync(store.path, 'utf8'), /"reasoningEffort": "high"/)
  })

  it('defaults a missing effort choice to "auto" and survives a bad path', () => {
    const ctx = { get: (name) => (name === 'dshHomePath' ? (...segments) => join(dir, ...segments) : undefined) }
    const store = createLevelStore(ctx)
    store.write({ level: 'light' })
    assert.equal(store.read().reasoningEffort, 'auto')

    const broken = createLevelStore({ get: (name) => (name === 'dshHomePath' ? () => join(dir, 'nope', '\u0000bad') : undefined) })
    assert.equal(broken.read(), undefined)
    assert.equal(broken.write({ level: 'off' }), undefined) // must not throw
  })
})

describe('live changes through apply()', () => {
  let harness

  /** A fake context with a web server that records its routes. */
  function fakeContext() {
    const state = {
      sections: [],
      effects: [],
      guards: [],
      restrictions: [],
      routes: [],
      rootEffects: [],
      waterfall: [],
      serial: [],
      logs: [],
      agents: [],
      services: {},
    }
    const tools = {
      guard: (guard) => { state.guards.push(guard); return () => {} },
      restrict: (filter) => { state.restrictions.push(filter); return () => {} },
    }
    const services = {
      systemPrompt: { section: (section) => { state.sections.push(section); return () => { state.sections = state.sections.filter((s) => s !== section) } } },
      tools,
      agents: { list: () => state.agents },
      webServer: {
        // Faithful to the host: registering the same (kind, path) twice throws.
        register: (route) => {
          if (state.routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
            throw new Error(`duplicate route ${route.path}`)
          }
          state.routes.push(route)
          return () => { state.routes = state.routes.filter((r) => r !== route) }
        },
      },
      ...state.services,
    }
    const makeAgent = (id = 'a1') => ({
      id,
      ctx: { tools, get: (name) => (name === 'tools' ? tools : services[name]), effect: (execute) => execute() },
    })
    const ctx = {
      systemPrompt: services.systemPrompt,
      tools,
      // A distinct root scope, like the real context tree: the route is
      // registered there, so disposing the *row's* effects must not take it.
      root: { effect(execute) { const dispose = execute(); state.rootEffects.push(dispose); return dispose } },
      logger: (name) => ({ info: (text) => state.logs.push(['info', name, text]), warn: (text) => state.logs.push(['warn', name, text]) }),
      get: (name) => services[name],
      effect(execute) { const dispose = execute(); state.effects.push(dispose); return dispose },
      on(event, listener, options) {
        const bucket = event === 'agent/created' ? state.serial : state.waterfall
        if (options?.prepend) bucket.unshift(listener); else bucket.push(listener)
        return () => {}
      },
      createAgent(id) {
        const agent = makeAgent(id)
        state.agents.push(agent)
        for (const listener of [...state.serial]) listener({ agent })
        return agent
      },
      async call(method, body) {
        const res = response()
        await state.routes.find((r) => r.path === API_PATH).handler(request(method, body), res)
        return res
      },
      async requestConfig(seed) {
        let index = -1
        const next = () => {
          index += 1
          const listener = state.waterfall[index]
          return listener ? listener({ turn: 1, step: 1, signal: undefined }, next) : Promise.resolve(seed)
        }
        return next()
      },
    }
    return { ctx, state, services, tools }
  }

  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'terse-mode-home-'))
    harness = fakeContext()
  })

  it('registers exactly one route', () => {
    apply(harness.ctx, { level: 'standard' })
    assert.equal(harness.state.routes.length, 1)
    assert.equal(harness.state.routes[0].kind, 'exact')
    assert.equal(harness.state.routes[0].path, '/dsh-terse-mode/api/state')
  })

  it('keeps one route across a reload and never releases it', async () => {
    // A reload applies a new generation on the same server: registering the
    // path a second time throws, which used to leave the panel with no route.
    apply(harness.ctx, { level: 'standard' })
    apply(harness.ctx, { level: 'light' })
    assert.equal(harness.state.routes.length, 1, 'no duplicate registration')
    assert.equal(harness.state.rootEffects.length, 1, 'the route is held by the root scope, not the row')

    // The surviving route must serve the newest generation.
    const body = await harness.ctx.call('POST', { level: 'strong' }).then((r) => r.json())
    assert.equal(body.level, 'strong')

    // Disposing the row's own effects (an unload) detaches the controller but
    // must not take the route with it; the surviving handler answers 503.
    for (const dispose of [...harness.state.effects]) {
      try { dispose() } catch { /* already gone */ }
    }
    assert.equal(harness.state.routes.length, 1, 'the route survives the row')
    const gone = await harness.ctx.call('GET')
    assert.equal(gone.status, 503)
    assert.match(gone.json().error, /not mounted/)

    // …and disposing the root scope is what finally releases it.
    for (const dispose of [...harness.state.rootEffects]) {
      try { dispose() } catch { /* already gone */ }
    }
    assert.equal(harness.state.routes.length, 0)
  })

  it('repairs the route after the server released it with the old fiber', async () => {
    // The real failure: a registration belongs to the fiber that made it, so a
    // reload drops the route. A cached "already registered" flag then left the
    // plugin mounted, enforcing, and permanently 404 on the panel's route.
    apply(harness.ctx, { level: 'standard' })
    assert.equal(harness.state.routes.length, 1)

    harness.state.routes = [] // the host released the path with the old fiber
    apply(harness.ctx, { level: 'light' })

    assert.equal(harness.state.routes.length, 1, 'the new generation must register again')
    const body = await harness.ctx.call('GET').then((r) => r.json())
    assert.equal(body.level, 'light', 'and serve its own policy')
  })

  it('applies a whole level when apply() received the validated config (the loader path)', async () => {
    // This is how the loader calls the plugin: validate through Config, then
    // apply. Re-normalising the resolved policy used to keep the old level's
    // cap and search, so a live click only renamed the level.
    apply(harness.ctx, Config['~standard'].validate({ level: 'standard' }).value)

    const light = await harness.ctx.call('POST', { level: 'light' }).then((r) => r.json())
    assert.equal(light.level, 'light')
    assert.equal(light.effective.reasoningEffort, 'low')
    assert.equal(light.effective.search, 'allow')

    const strong = await harness.ctx.call('POST', { level: 'strong' }).then((r) => r.json())
    assert.equal(strong.level, 'strong')
    assert.equal(strong.effective.reasoningEffort, 'off')
    assert.equal(strong.effective.search, 'deny')
    assert.equal(strong.effective.instruction, true)
  })

  it('sets the reasoning effort exactly, and a level click resets it to auto', async () => {
    apply(harness.ctx, { level: 'standard' })
    // The adapter advertises efforts, so the exact choice can be honoured.
    const ctx = harness.ctx
    ctx.get('llm') // not a service here: the clamp falls back to the policy

    const high = await ctx.call('POST', { reasoningEffort: 'high' }).then((r) => r.json())
    assert.equal(high.reasoningChoice, 'high')
    assert.equal(high.effective.reasoningEffort, 'high')
    assert.equal(high.effective.reasoningMode, 'exact')

    const raised = await ctx.requestConfig({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' })
    assert.equal(raised.reasoningEffort, 'high', 'an explicit choice is a decision, not a ceiling')

    const opened = await ctx.call('GET').then((r) => r.json())
    assert.equal(opened.reasoningChoice, 'high')

    const afterLevel = await ctx.call('POST', { level: 'strong' }).then((r) => r.json())
    assert.equal(afterLevel.reasoningChoice, 'auto', 'a level click clears the explicit effort')
    assert.equal(afterLevel.effective.reasoningEffort, 'off')
    assert.equal(afterLevel.effective.reasoningMode, 'cap')
  })

  it('turns web search on and off through the API, independently of the level', async () => {
    apply(harness.ctx, { level: 'standard' })
    const guard = harness.state.guards[0]
    assert.match(guard({ name: 'web_search' }), /Web tools are turned off/, 'standard denies search')

    const allowed = await harness.ctx.call('POST', { search: 'allow' }).then((r) => r.json())
    assert.deepEqual(allowed.searchChoices, ['auto', 'allow', 'deny'])
    assert.equal(allowed.searchChoice, 'allow', 'the switch is explicit')
    assert.equal(allowed.effective.search, 'allow', 'and it overrides the level')
    assert.equal(guard({ name: 'web_search' }), undefined, 'the guard stops blocking web tools')

    const denied = await harness.ctx.call('POST', { search: 'deny' }).then((r) => r.json())
    assert.equal(denied.searchChoice, 'deny')
    assert.equal(denied.effective.search, 'deny')
    assert.match(guard({ name: 'web_search' }), /Web tools are turned off/)

    // `auto` restores "whatever the level decides".
    const auto = await harness.ctx.call('POST', { search: 'auto' }).then((r) => r.json())
    assert.equal(auto.searchChoice, 'auto')
    assert.equal(auto.effective.search, 'deny', 'standard decides again')

    // A level click also resets the explicit choice, in both directions.
    await harness.ctx.call('POST', { search: 'deny' })
    const light = await harness.ctx.call('POST', { level: 'light' }).then((r) => r.json())
    assert.equal(light.searchChoice, 'auto')
    assert.equal(light.effective.search, 'allow')

    const bad = await harness.ctx.call('POST', { search: 'maybe' })
    assert.equal(bad.status, 400)
    assert.match(bad.json().error, /search must be one of/)
  })

  it('remembers the level, the effort, the search and the subagent choice across a plugin restart', async () => {
    apply(harness.ctx, { level: 'light' })
    await harness.ctx.call('POST', { level: 'off' })
    await harness.ctx.call('POST', { reasoningEffort: 'high' })
    await harness.ctx.call('POST', { search: 'deny' })
    await harness.ctx.call('POST', { subagents: 'deny' })

    const reopened = fakeContext()
    apply(reopened.ctx, { level: 'light' })
    assert.ok(reopened.state.logs.some(([level, , text]) => level === 'info' && /remembered from the panel/.test(text)))
    const body = await reopened.ctx.call('GET').then((r) => r.json())
    assert.equal(body.level, 'off')
    assert.equal(body.reasoningChoice, 'high')
    assert.equal(body.effective.reasoningEffort, 'high')
    assert.equal(body.searchChoice, 'deny', 'the search switch is remembered too')
    assert.equal(body.subagents, 'deny', 'the subagent choice is remembered too')
    assert.equal(reopened.state.sections.length, 0, 'off means no instruction section')
  })

  it('turns subagents off and on through the API, guard included', async () => {
    apply(harness.ctx, { level: 'standard' })
    const guard = harness.state.guards[0]
    assert.equal(guard({ name: 'subagent' }), undefined)

    const off = await harness.ctx.call('POST', { subagents: 'deny' }).then((r) => r.json())
    assert.equal(off.subagents, 'deny')
    assert.deepEqual(off.subagentChoices, ['allow', 'deny'])
    assert.match(guard({ name: 'subagent' }), /Subagents are turned off/)
    assert.match(guard({ name: 'web_search' }), /Web tools are turned off/, 'standard still blocks search')

    const bad = await harness.ctx.call('POST', { subagents: 'maybe' })
    assert.equal(bad.status, 400)

    const on = await harness.ctx.call('POST', { subagents: 'allow' }).then((r) => r.json())
    assert.equal(on.subagents, 'allow')
    assert.equal(guard({ name: 'subagent' }), undefined)
  })

  it('lets the patch level win when nothing was stored', async () => {
    apply(harness.ctx, { level: 'strong' })
    const body = await harness.ctx.call('GET').then((r) => r.json())
    assert.equal(body.level, 'strong')
    assert.equal(body.reasoningChoice, 'auto')
  })
})
