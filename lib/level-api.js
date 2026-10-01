/**
 * The host half of the conversation-page panel.
 *
 * One route on the host web server (`ctx.webServer`), following the same lane
 * the installed plugin market uses for `/dsh-market/*`: a plain-`fetch`
 * endpoint the browser can call. That is the only client→host channel
 * available to a plugin installed as a `link:` junction, because such a plugin
 * cannot import `@deepseek-ai/*` and therefore cannot declare a remote service.
 *
 *   GET  /dsh-terse-mode/api/state  → { level, levels, effective, persistedAt }
 *   POST /dsh-terse-mode/api/state  → { level } → the same state
 *
 * The handler is a plain function over (request, response) so it can be tested
 * without a running server.
 */
import { LEVELS, REASONING_CHOICES, SEARCH_CHOICES, SUBAGENT_CHOICES, describePolicy } from './logic.js'

export const API_PATH = '/dsh-terse-mode/api/state'
/** Refuse anything larger: the body is one word. */
const MAX_BODY_BYTES = 4096

/**
 * Build the request handler for a policy controller.
 *
 * POST accepts `{ level }`, `{ reasoningEffort }`, or both; at least one must
 * name a valid value. `reasoningEffort: 'auto'` clears the explicit choice so
 * the level default applies again.
 *
 * @param controller — `{ runtime, setLevel, setReasoningEffort, log, storedAt }`.
 * @returns `(request, response) => Promise<void>`.
 */
export function createLevelHandler(controller) {
  return async function handle(request, response) {
    try {
      // The route itself outlives a plugin generation (see `registerLevelApi`),
      // so it has to answer clearly when the plugin is not mounted.
      if (controller.available === false) {
        sendJson(response, 503, { error: 'dsh-terse-mode is not mounted in this profile' })
        return
      }
      if (request.method === 'GET') {
        sendJson(response, 200, state(controller))
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }

      const body = await readJsonBody(request)
      if (body === undefined) {
        sendJson(response, 400, { error: 'body must be a JSON object' })
        return
      }
      // An empty POST is the panel's *read* lane: the Desktop shell's request
      // forwarder is unreliable for GET (its body handling rejects a GET), while
      // POST arrives normally — so the panel reads with `POST {}`.
      if (Object.keys(body).length === 0) {
        sendJson(response, 200, state(controller))
        return
      }
      if (body.level === undefined && body.reasoningEffort === undefined && body.search === undefined && body.subagents === undefined) {
        sendJson(response, 400, { error: `expected "level" (${LEVELS.join(', ')}), "reasoningEffort" (${REASONING_CHOICES.join(', ')}), "search" (${SEARCH_CHOICES.join(', ')}) and/or "subagents" (${SUBAGENT_CHOICES.join(', ')})` })
        return
      }
      if (body.level !== undefined) {
        if (typeof body.level !== 'string' || !LEVELS.includes(body.level)) {
          sendJson(response, 400, { error: `level must be one of ${LEVELS.join(', ')}` })
          return
        }
        if (controller.setLevel(body.level) === undefined) {
          sendJson(response, 400, { error: `unknown level "${body.level}"` })
          return
        }
      }
      if (body.reasoningEffort !== undefined) {
        if (typeof body.reasoningEffort !== 'string' || !REASONING_CHOICES.includes(body.reasoningEffort)) {
          sendJson(response, 400, { error: `reasoningEffort must be one of ${REASONING_CHOICES.join(', ')}` })
          return
        }
        if (controller.setReasoningEffort(body.reasoningEffort) === undefined) {
          sendJson(response, 400, { error: `unknown reasoningEffort "${body.reasoningEffort}"` })
          return
        }
      }
      if (body.search !== undefined) {
        if (typeof body.search !== 'string' || !SEARCH_CHOICES.includes(body.search)) {
          sendJson(response, 400, { error: `search must be one of ${SEARCH_CHOICES.join(', ')}` })
          return
        }
        if (controller.setSearch(body.search) === undefined) {
          sendJson(response, 400, { error: `unknown search "${body.search}"` })
          return
        }
      }
      if (body.subagents !== undefined) {
        if (typeof body.subagents !== 'string' || !SUBAGENT_CHOICES.includes(body.subagents)) {
          sendJson(response, 400, { error: `subagents must be one of ${SUBAGENT_CHOICES.join(', ')}` })
          return
        }
        if (controller.setSubagents(body.subagents) === undefined) {
          sendJson(response, 400, { error: `unknown subagents "${body.subagents}"` })
          return
        }
      }
      sendJson(response, 200, state(controller))
    } catch (error) {
      // The web server turns a throwing handler into a 400 and a warning, but a
      // readable JSON error is more useful to the panel than an empty body.
      try {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      } catch { /* response already gone */ }
    } finally {
      // One line per request next to the state file: when the panel cannot
      // connect, this is what tells "the browser never arrived" apart from
      // "it arrived and was refused".
      try {
        const headers = request.headers ?? {}
        controller.debugLog?.(`${request.method} ${request.url} origin=${headers.origin ?? '-'} sfs=${headers['sec-fetch-site'] ?? '-'} -> ${response.statusCode ?? response.status ?? '?'}`)
      } catch { /* diagnostics must never break the response */ }
    }
  }
}

/** The state the panel renders. */
export function state(controller) {
  const policy = controller.runtime.policy
  return {
    level: policy.level,
    levels: [...LEVELS],
    // What the panel's effort pills should highlight: the explicit choice, or
    // `auto` when the level decides.
    reasoningChoice: policy.authored?.reasoningEffort ?? 'auto',
    reasoningChoices: [...REASONING_CHOICES],
    // The panel's web-search switch: an explicit `allow`/`deny`, or `auto` while
    // the level decides (the resolved value stays in `effective.search`).
    searchChoice: policy.authored?.search ?? 'auto',
    searchChoices: [...SEARCH_CHOICES],
    subagents: policy.subagents ?? 'allow',
    subagentChoices: [...SUBAGENT_CHOICES],
    subagentTools: [...(policy.subagentTools ?? [])],
    effective: {
      reasoningEffort: policy.reasoningEffort,
      reasoningMode: policy.reasoningMode ?? 'cap',
      maxTokens: policy.maxTokens,
      search: policy.search,
      instruction: policy.instruction.length > 0,
    },
    summary: describePolicy(policy),
    persistedAt: controller.storedAt?.() ?? null,
  }
}

/**
 * Route ownership has two traps, and this is what survives both.
 *
 * 1. A registration lives with the fiber that made it (every shipped plugin
 *    writes `webCtx.effect(() => webCtx.webServer.register(route))`). A reload
 *    therefore *releases* the route, and a reload can also apply the new
 *    generation before the old fiber is disposed, so a blind re-registration
 *    throws a duplicate (kind, path).
 * 2. Caching "already registered" on the server object then makes it worse: once
 *    the route has been released, the cache says it exists and nothing ever
 *    registers it again → mounted, enforcing, market says live, and *every*
 *    request 404s.
 *
 * So: one shared holder per server object (every handler, current or stale,
 * dispatches through it, and an unmounted plugin answers 503), and every
 * generation attempts a fresh registration, retrying with backoff while the
 * path is still busy. Either the release already happened (first retry wins) or
 * it is still this holder's own route, which keeps working while we retry.
 */
const ROUTE_KEY = '__dshTerseModeRoute'

/** 0ms, then short backoff: a released route is free almost immediately. */
const REGISTER_DELAYS = [0, 250, 1000, 3000]

/**
 * Register (or repair) the route on the host web server.
 */
export function registerLevelApi(ctx, controller, log) {
  let webServer
  try {
    webServer = ctx.get?.('webServer')
  } catch {
    webServer = undefined
  }
  if (typeof webServer?.register !== 'function') {
    log('warn', 'no web server in this profile: the conversation-page panel cannot reach the host')
    return
  }

  let holder = webServer[ROUTE_KEY]
  if (holder === undefined) {
    holder = { controller: undefined, debugLog: undefined, handlers: 0 }
    webServer[ROUTE_KEY] = holder
  }
  holder.controller = controller
  holder.debugLog = controller?.debugLog

  // Handlers resolve everything through the holder, so a route registered by an
  // earlier generation still serves this one's policy.
  const live = {
    get available() { return holder.controller !== undefined },
    get runtime() {
      if (holder.controller === undefined) throw new Error('dsh-terse-mode is not mounted in this profile')
      return holder.controller.runtime
    },
    setLevel: (...args) => holder.controller?.setLevel(...args),
    setReasoningEffort: (...args) => holder.controller?.setReasoningEffort(...args),
    setSearch: (...args) => holder.controller?.setSearch(...args),
    setSubagents: (...args) => holder.controller?.setSubagents(...args),
    storedAt: (...args) => holder.controller?.storedAt?.(...args) ?? null,
    debugLog: (line) => holder.debugLog?.(line),
  }

  // A registration belongs to the scope that made it, and a row reload disposes
// the row's fiber — which is how the route kept disappearing. Registering from
// the *root* context instead makes the route outlive every reload of this row.
  let owner = ctx
  try {
    if (ctx?.root && typeof ctx.root.effect === 'function') owner = ctx.root
  } catch { /* no root access: the row scope still works, less durably */ }

  let unloaded = false
  let pending
  const attempt = (index) => {
    if (unloaded) return
    try {
      const dispose = owner.effect(
        () => webServer.register({ kind: 'exact', path: API_PATH, handler: createLevelHandler(live) }),
        'terse-mode.api()',
      )
      holder.handlers += 1
      if (typeof dispose === 'function') holder.dispose = dispose
      log('info', `registered ${API_PATH} (#${holder.handlers}${owner === ctx ? '' : ', held by the root scope'})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const next = index + 1
      if (next < REGISTER_DELAYS.length) {
        pending = setTimeout(() => attempt(next), REGISTER_DELAYS[next])
        return
      }
      // Keep quiet about the expected case: the path is still held by this
      // holder's own earlier registration, which is serving requests.
      log('info', `${API_PATH} is already served by an earlier generation (${message})`)
    }
  }
  attempt(0)

  // Unload detaches the controller but never releases the route: the surviving
  // handler answers 503 through the same holder (see `createLevelHandler`).
  try {
    ctx.effect(() => () => {
      unloaded = true
      clearTimeout(pending)
      if (holder.controller === controller) holder.controller = undefined
    }, 'terse-mode.api()')
  } catch (error) {
    log('warn', `could not own ${API_PATH}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  // Recorded as well as written: the request log reports what the panel got,
  // and `writeHead` alone does not always leave `statusCode` on the object the
  // web server hands us.
  try { response.statusCode = status } catch { /* read-only double */ }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}
