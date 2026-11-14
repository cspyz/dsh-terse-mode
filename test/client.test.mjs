/**
 * The client half rendered for real, without a browser.
 *
 * The settings section once registered fine (its nav label appeared) and then
 * rendered a blank page, because it referenced two locals that only the header
 * control defines — a ReferenceError the Settings shell swallowed. `node --check`
 * cannot see that, so both components are rendered here with a tiny React stub
 * and a fake page, and any throw fails the suite.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Just enough React to walk a tree: hooks are inert, effects run once. */
function reactStub(force = {}) {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  })
  // `force.open` makes the popover mount and `force.anchor` gives it the rect it
  // would measure from a real button, so the popover's own children can be
  // walked (its keys are where the duplicate that broke the UI lived).
  const useState = (initial) => {
    if (initial === false && force.open) return [true, () => {}]
    if (initial === null && force.anchor) return [{ top: 120, right: 16 }, () => {}]
    return [initial, () => {}]
  }
  return {
    createElement,
    useState,
    useReducer: (initial) => [initial, () => {}],
    // Effects run when the component renders, which is what starts the store's
    // read; re-rendering the component afterwards shows that state.
    useEffect: (callback) => { try { callback() } catch { /* view-level */ } },
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  }
}

/**
 * Load client.js into a fake page and return the registered slots.
 *
 * @param overrides — page globals worth replacing (fetch, location, …).
 */
function loadClient(overrides = {}) {
  const slots = []
  const localStorage = { getItem: () => null, setItem: () => {} }
  const window = {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, 'dsh-terse-mode')
        const module = definition.factory((name) => {
          if (name === 'react') return reactStub(overrides.react)
          throw new Error(`unexpected require(${name})`)
        })
        slots.push(module)
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1400,
    ...overrides.window,
  }
  const document = {
    baseURI: 'dsh-app://app/index.html',
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    currentScript: { src: 'dsh-app://app/plugins/dsh-terse-mode/client.js?rev=1' },
    ...overrides.document,
  }
  const sandbox = {
    window,
    document,
    localStorage,
    navigator: { language: 'zh-CN' },
    location: { origin: 'dsh-app://app', href: 'dsh-app://app/' },
    fetch: overrides.fetch ?? (async () => { throw new Error('Failed to fetch') }),
    setTimeout,
    clearTimeout,
    AbortController,
    console,
    URL,
    Error,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Symbol,
    RegExp,
    ...(overrides.globals ?? {}),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(slots.length, 1, 'client.js must register exactly one module')

  const registered = []
  let currentSlot
  const ctx = {
    effect: (execute) => execute(),
    slots: {
      inject: (slot, callback) => {
        currentSlot = slot
        callback()
      },
      register: (options, component) => {
        assert.equal(options.name, currentSlot, 'a component must register into the slot it was injected for')
        registered.push({ slot: currentSlot, options, component })
        return () => {}
      },
    },
  }
  try { slots[0].apply(ctx) } catch { /* locale service absent: expected */ }
  return { registered, sandbox }
}

/** Walk a rendered element tree, calling every function component it contains. */
function render(element, depth = 0, text = []) {
  if (element === null || element === undefined) return text
  if (typeof element === 'string' || typeof element === 'number') {
    text.push(String(element))
    return text
  }
  if (typeof element !== 'object') return text
  if (Array.isArray(element)) {
    for (const child of element) render(child, depth + 1, text)
    return text
  }
  assert.ok(depth < 40, 'render recursion ran away')
  if (typeof element.type === 'function') return render(element.type(element.props ?? {}), depth + 1, text)
  const children = element.props?.children
  if (children !== undefined) render(children, depth + 1, text)
  return text
}

/** A complete host state, with overrides for the malformed cases below. */
const stateOf = (level, extra = {}) => JSON.stringify({
  level,
  levels: ['off', 'light', 'standard', 'strong'],
  reasoningChoice: 'auto',
  searchChoice: 'auto',
  subagents: 'allow',
  effective: { reasoningEffort: 'low', reasoningMode: 'cap', maxTokens: null, search: 'deny', instruction: true },
  ...extra,
})

/** Find the first element in a rendered tree that matches. */
function findBy(tree, predicate) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = findBy(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(tree)) return tree
  return findBy(tree.props?.children, predicate)
}

/**
 * Walk a rendered tree and fail on two siblings sharing a key.
 *
 * Duplicate keys make React's reconciliation undefined, and inside a portal the
 * orphaned copies are never removed — a level bar that shared its key with a
 * sibling Collapse multiplied on every render until the popover was a column of
 * them. Function components are expanded the same way `render` does it.
 */
function assertUniqueKeys(element, where = 'root', depth = 0) {
  if (element === null || element === undefined || typeof element !== 'object') return
  assert.ok(depth < 40, 'key walk ran away')
  if (Array.isArray(element)) {
    const seen = new Set()
    for (const child of element) {
      const key = child?.props?.key
      if (key !== undefined && key !== null) {
        assert.equal(seen.has(key), false, `${where} has two children keyed ${String(key)}`)
        seen.add(key)
      }
      assertUniqueKeys(child, where, depth + 1)
    }
    return
  }
  if (typeof element.type === 'function') {
    assertUniqueKeys(element.type(element.props ?? {}), where, depth + 1)
    return
  }
  assertUniqueKeys(element.props?.children, where, depth + 1)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the client half renders', () => {
  it('registers the header control and the Settings section', () => {
    const { registered } = loadClient()
    const slots = registered.map((entry) => entry.slot).sort()
    assert.deepEqual(slots, ['conversation.session.header.actions', 'settings.section'])
    const section = registered.find((entry) => entry.slot === 'settings.section')
    assert.equal(section.options.id, 'terse-mode')
    assert.equal(typeof section.options.label(), 'string')
  })

  it('renders both views while the host is unreachable', () => {
    // This is the path that used to blank the Settings page: an undeclared
    // identifier only shows up when the component body actually runs.
    const { registered } = loadClient()
    for (const { slot, component } of registered) {
      assert.doesNotThrow(() => render(component({})), `${slot} threw while offline`)
    }
  })

  it('renders both views with a state that has every field', async () => {
    const body = JSON.stringify({
      level: 'standard',
      levels: ['off', 'light', 'standard', 'strong'],
      reasoningChoice: 'high',
      reasoningChoices: ['auto', 'none', 'off', 'low', 'high', 'max'],
      searchChoice: 'allow',
      searchChoices: ['auto', 'allow', 'deny'],
      subagents: 'deny',
      subagentChoices: ['allow', 'deny'],
      subagentTools: ['subagent'],
      effective: { reasoningEffort: 'high', reasoningMode: 'exact', maxTokens: null, search: 'allow', instruction: true },
      summary: 'x',
      persistedAt: '2026-10-01T00:00:00.000Z',
    })
    const calls = []
    const { registered } = loadClient({
      fetch: async (url, init) => {
        calls.push([url, init?.method ?? 'GET'])
        return { ok: true, status: 200, text: async () => body }
      },
    })

    // Pass 1 reads (and finds nothing yet), pass 2 renders the loaded state.
    for (const { component } of registered) render(component({}))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.length >= 1, true, 'the store must have tried to read')
    assert.match(calls[0][0], /dsh-terse-mode\/api\/state$/)
    assert.equal(calls[0][0].startsWith('dsh-app://app/'), true, 'the page origin is tried first')
    for (const { slot, component } of registered) {
      assert.doesNotThrow(() => render(component({})), `${slot} threw with a full state`)
    }

    // A page that renders nothing is the failure this suite exists for: the
    // Settings section once registered its nav label and drew an empty body.
    // The header is deliberately terse (its long copy lives in the popover), so
    // each view is checked against what it is supposed to contain. The header
    // now carries the level row and a single entry point; the web-search and
    // subagent switches moved inside that popover, so their labels appear in the
    // Settings view only.
    const expected = {
      'conversation.session.header.actions': ['简洁模式', '关', '轻', '标准', '强'],
      'settings.section': ['简洁模式', '每一档在做什么', '思考强度', '联网搜索', '子代理', '推荐', '允许', '禁止', '当前实际生效'],
    }
    for (const { slot, component } of registered) {
      const text = render(component({})).join(' ')
      assert.ok(text.length > 12, `${slot} rendered (almost) nothing`)
      for (const label of expected[slot] ?? []) {
        assert.ok(text.includes(label), `${slot} is missing the ${label} block`)
      }
    }
  })

  it('falls back to the built-in levels when the host sends a malformed list', async () => {
    // `state?.levels ?? LEVELS` let a string reach `.map` and an array of
    // objects reach React; both crashed the header and the Settings section.
    for (const levels of ['off,light', [], [{}], 42, null]) {
      const { registered } = loadClient({
        fetch: async () => ({ ok: true, status: 200, text: async () => stateOf('standard', { levels }) }),
      })
      for (const { slot, component } of registered) {
        assert.doesNotThrow(() => render(component({})), `${slot} threw on levels=${JSON.stringify(levels)}`)
      }
      await tick()
      for (const { slot, component } of registered) {
        assert.doesNotThrow(() => render(component({})), `${slot} threw on levels=${JSON.stringify(levels)} after load`)
      }
      const header = registered.find((entry) => entry.slot === 'conversation.session.header.actions').component
      const text = render(header({})).join(' ')
      assert.ok(text.includes('强'), 'the four built-in levels are still rendered')
    }
  })

  it('arms an abort signal on every request', async () => {
    const seen = []
    const { registered } = loadClient({
      fetch: async (url, init) => {
        seen.push(init)
        return { ok: true, status: 200, text: async () => stateOf('standard') }
      },
    })
    const header = registered.find((entry) => entry.slot === 'conversation.session.header.actions').component
    render(header({}))
    await tick()
    assert.ok(seen.length >= 1)
    assert.ok(seen[0].signal, 'a hung request must be cancellable')
    assert.equal(typeof seen[0].signal.aborted, 'boolean')
  })

  it('drops a stale read that lands after a newer click', async () => {
    let releaseRead
    const readHeld = new Promise((resolve) => { releaseRead = resolve })
    const { registered } = loadClient({
      fetch: async (url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          await readHeld
          return { ok: true, status: 200, text: async () => stateOf('off') }
        }
        return { ok: true, status: 200, text: async () => stateOf('strong') }
      },
    })
    const header = registered.find((entry) => entry.slot === 'conversation.session.header.actions').component

    // The initial read hangs; a click answers first; then the old read lands.
    const tree = header({})
    const strong = findBy(tree, (node) => node?.props?.['data-level'] === 'strong')
    assert.ok(strong, 'the header renders the level buttons')
    strong.props.onClick()
    await tick()
    releaseRead()
    await tick()

    const after = header({})
    const strongAfter = findBy(after, (node) => node?.props?.['data-level'] === 'strong')
    const offAfter = findBy(after, (node) => node?.props?.['data-level'] === 'off')
    assert.equal(strongAfter.props['aria-pressed'], 'true', 'the click wins')
    assert.equal(offAfter.props['aria-pressed'], 'false', 'the stale read was dropped')
  })

  it('shows a pressed pill for the none reasoning choice (F7)', async () => {
    // 'none' is a valid host choice; without a pill the user could not see it was
    // active, and the readout fell back to "follows the model menu".
    const { registered } = loadClient({
      fetch: async () => ({ ok: true, status: 200, text: async () => stateOf('standard', { reasoningChoice: 'none', effective: { reasoningEffort: null, reasoningMode: 'cap', maxTokens: null, search: 'deny', instruction: true } }) }),
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({})); await tick()
    const nonePill = findBy(settings({}), (node) => node?.type === 'button' && node?.props?.children === 'none')
    assert.ok(nonePill, 'the none effort pill exists')
    assert.equal(nonePill.props['aria-pressed'], 'true', 'none is highlighted when chosen')
  })

  it('does not report offline when a successful read lacks effective (F6)', async () => {
    // A partial state (no effective) used to render the offline branch even though
    // the read succeeded, and searchState guessed 'deny' against the level default.
    const { registered } = loadClient({
      fetch: async () => ({ ok: true, status: 200, text: async () => stateOf('light', { effective: undefined }) }),
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({})); await tick()
    const text = render(settings({})).join(' ')
    assert.ok(text.includes('暂无生效数据'), 'shows the neutral unknown placeholder')
    assert.ok(!text.includes('未连上宿主'), 'a successful read must not look offline')
  })

  it('rejects a 200 whose body is not a state, surfacing the error (F11)', async () => {
    // A forwarder can answer 200 with {"error":...}; accepting it cleared the error
    // and stopped the retry loop, so the header looked normal with no real data.
    const { registered } = loadClient({
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: 'not found' }) }),
    })
    const header = registered.find((entry) => entry.slot === 'conversation.session.header.actions').component
    render(header({})); await tick(); await tick()
    const text = render(header({})).join(' ')
    assert.ok(text.includes('未连上宿主'), 'a garbage 200 must surface as an error, not a silent success')
  })

  it('marks the values the config file pinned (sources.patch)', async () => {
    // Without this tag a pinned value renders identically to one the user just
    // clicked, so "follow the level" appears to do nothing.
    const { registered } = loadClient({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => stateOf('standard', { sources: { level: 'panel', search: 'patch', reasoningEffort: 'level', subagents: 'level' } }),
      }),
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({}))
    await tick()
    const text = render(settings({})).join(' ')
    assert.ok(text.includes('配置文件固定'), 'the pinned search switch carries the tag')

    // No "follow the level" link: clearing the pin would only let the patch value
    // straight back in, so offering it would be a dead button.
    const follow = findBy(settings({}), (node) => node?.type === 'button' && node?.props?.children === '改为跟随档位')
    assert.equal(follow, undefined, 'the link is not offered for a config-pinned value')
  })

  it('moves the switches when the level changes', async () => {
    // A level click has to move the block: 标准 → 联网「禁止」, 轻 → 「允许」.
    // Showing "跟随档位" instead left the user unable to see what the level did.
    const stateFor = (level) => JSON.stringify({
      level,
      levels: ['off', 'light', 'standard', 'strong'],
      reasoningChoice: 'auto',
      searchChoice: 'auto',
      subagents: 'allow',
      sources: { level: 'panel', search: 'level', reasoningEffort: 'level', subagents: 'level' },
      effective: {
        reasoningEffort: level === 'strong' ? 'off' : 'low',
        reasoningMode: 'cap',
        maxTokens: null,
        search: level === 'standard' || level === 'strong' ? 'deny' : 'allow',
        instruction: true,
      },
      health: { instruction: true, expected: true, sessions: 1 },
    })
    const { registered } = loadClient({
      fetch: async (url, init) => {
        const asked = init?.body ? JSON.parse(init.body).level : undefined
        return { ok: true, status: 200, text: async () => stateFor(asked ?? 'standard') }
      },
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({}))
    await tick()

    const pressed = (value) => findBy(settings({}), (node) => node?.props?.['data-search-choice'] === value)?.props?.['aria-pressed']
    assert.equal(pressed('deny'), 'true', 'standard denies search')
    assert.equal(pressed('allow'), 'false')

    const light = findBy(settings({}), (node) => node?.props?.['data-level'] === 'light')
    assert.ok(light, 'the level card is there to click')
    light.props.onClick()
    await tick()

    assert.equal(pressed('allow'), 'true', 'the switch jumped to the value light gives')
    assert.equal(pressed('deny'), 'false', 'and the old value is no longer shown')
  })

  it('never renders two siblings with the same key, popover included', async () => {
    const { registered } = loadClient({
      // Mount the popover: its children are where the colliding key lived, and a
      // closed popover would hide the regression completely.
      react: { open: true, anchor: true },
      fetch: async () => ({ ok: true, status: 200, text: async () => stateOf('off', { sources: { search: 'patch', level: 'panel' } }) }),
    })
    render(registered.find((entry) => entry.slot === 'conversation.session.header.actions').component({}))
    await tick()
    for (const { slot, component } of registered) {
      assertUniqueKeys(component({}), slot)
    }
    const header = registered.find((entry) => entry.slot === 'conversation.session.header.actions').component
    const text = render(header({})).join(' ')
    assert.ok(text.includes('每一档在做什么'), 'the popover really rendered')
  })

  it('the key checker itself rejects duplicates', () => {
    // A control for the test above: without this, a broken walker would happily
    // pass on a tree that has the very bug it exists to catch.
    const duplicate = {
      type: 'div',
      props: { children: [{ type: 'span', props: { key: 'levels' } }, { type: 'span', props: { key: 'levels' } }] },
    }
    assert.throws(() => assertUniqueKeys(duplicate), /two children keyed levels/)
  })

  it('does not report a missing instruction as a failure at the off level', async () => {
    // `level: off` deliberately registers no prompt section; that is not a fault.
    const { registered } = loadClient({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => stateOf('off', {
          effective: { reasoningEffort: null, reasoningMode: 'cap', maxTokens: null, search: 'allow', instruction: false },
          health: { instruction: false, expected: false, sessions: 0 },
        }),
      }),
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({}))
    await tick()
    const text = render(settings({})).join(' ')
    assert.ok(text.includes('按当前档位不使用提示词'), 'explained as intentional')
    assert.equal(text.includes('提示词未生效'), false, 'not reported as a failure')
  })

  it('follows the option lists the host sends', async () => {
    // The client used to hard-code the six effort ids and the two/three switch
    // values, which is how `none` once existed on the host and not in the panel.
    const { registered } = loadClient({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => stateOf('standard', {
          reasoningChoices: ['auto', 'low', 'turbo'],
          searchChoices: ['auto', 'deny'],
          subagentChoices: ['allow'],
        }),
      }),
    })
    const settings = registered.find((entry) => entry.slot === 'settings.section').component
    render(settings({}))
    await tick()
    const tree = settings({})
    assert.ok(findBy(tree, (node) => node?.props?.['data-effort'] === 'turbo'), 'an unknown host id still renders')
    assert.equal(findBy(tree, (node) => node?.props?.['data-effort'] === 'high'), undefined, 'a dropped id is gone')
    assert.equal(findBy(tree, (node) => node?.props?.['data-search-choice'] === 'allow'), undefined, 'the switch follows the host list')
  })
})

describe('the built-in dictionaries', () => {
  it('every key the UI translates exists in both zh and en', () => {
    // The advanced editor once rendered raw key names ("instrAuto", "toggleOn")
    // in Chinese because six keys existed only in `en`. A key the UI calls via
    // t() must exist in BOTH built-in dictionaries, or `t` falls back to the key.
    const dictStart = source.indexOf('const DICTIONARIES')
    const zhStart = source.indexOf('zh: {', dictStart)
    const enStart = source.indexOf('en: {', zhStart)
    const dictEnd = source.indexOf('\n    }', enStart)
    const keysOf = (block) => new Set([...block.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]))
    const zh = keysOf(source.slice(zhStart, enStart))
    const en = keysOf(source.slice(enStart, dictEnd))
    const used = [...new Set([...source.matchAll(/\bt\(['"](\w+)['"]\)/g)].map((m) => m[1]))]
    const missing = used.filter((key) => !zh.has(key) || !en.has(key))
    assert.deepEqual(missing, [], `t() keys missing from a dictionary: ${missing.join(', ')}`)
  })
})
