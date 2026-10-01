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
function reactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
  })
  return {
    createElement,
    useState: (initial) => [initial, () => {}],
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
          if (name === 'react') return reactStub()
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
    // each view is checked against what it is supposed to contain.
    const expected = {
      'conversation.session.header.actions': ['简洁模式', '子代理', '联网', '关', '轻', '标准', '强'],
      'settings.section': ['简洁模式', '每一档在做什么', '思考强度', '联网搜索', '子代理', '跟随档位', '允许', '禁止'],
    }
    for (const { slot, component } of registered) {
      const text = render(component({})).join(' ')
      assert.ok(text.length > 12, `${slot} rendered (almost) nothing`)
      for (const label of expected[slot] ?? []) {
        assert.ok(text.includes(label), `${slot} is missing the ${label} block`)
      }
    }
  })
})
