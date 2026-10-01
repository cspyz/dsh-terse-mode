#!/usr/bin/env node
/**
 * preflight-terse-mode.mjs — prove the bundle can load BEFORE it goes anywhere
 * near the live profile.
 *
 * DSH's boot is all-or-nothing: one entry that cannot load stops the process
 * (and a failed activation has already once tripped the Desktop safe-mode
 * watchdog, which resets `dsh.profile.bundles` to the in-box bundle). So the
 * package is checked here against the same things the loader does:
 *   - manifest fields and the patch file it points at
 *   - the module imports and exports (name / apply / inject / Config)
 *   - the Config validator: defaults materialise, nonsense never rejects
 *   - `apply()` runs against a fake context without throwing
 *   - the patch YAML names this package and a known level
 *
 * Exit code 0 = safe to install, 1 = do not install.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Development workspace (`<workspace>/terse-mode`) or a published checkout where
// the repository root is the package itself.
const workspace = resolve(here, '..')
const packageDir = existsSync(join(workspace, 'terse-mode', 'package.json'))
  ? join(workspace, 'terse-mode')
  : workspace
const LEVELS = ['off', 'light', 'standard', 'strong']

// The plugin remembers the panel's choice in `$DSH_HOME`; point that at a
// throwaway directory so this run can neither read the live level (which would
// make these checks depend on the user's current setting) nor write to it.
const sandboxHome = mkdtempSync(join(tmpdir(), 'terse-mode-preflight-'))
process.env.DSH_HOME = sandboxHome
process.on('exit', () => {
  try { rmSync(sandboxHome, { recursive: true, force: true }) } catch { /* best effort */ }
})

const checks = []
const check = (name, run) => {
  try {
    run()
    checks.push([true, name])
  } catch (error) {
    checks.push([false, `${name}: ${error instanceof Error ? error.message : String(error)}`])
  }
}

// ------------------------------------------------------------- manifest ----
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const patchPath = join(packageDir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''

check('package.json declares dsh.bundle.patch', () => {
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string')
  assert.equal(manifest.type, 'module', 'the loader imports it as ESM')
  assert.ok(manifest.exports?.['.'], 'needs an exports entry for "."')
  assert.equal(existsSync(patchPath), true, `missing ${patchPath}`)
})

check('the bundle patch inserts exactly one row of this package', () => {
  const rows = patchText.match(/^\s*-\s*id:\s*(\S+)\s*$/gm) ?? []
  assert.equal(rows.length, 1, `expected one insert row, found ${rows.length}`)
  assert.match(patchText, new RegExp(`^\\s*name:\\s*${manifest.name}\\s*$`, 'm'), 'patch must name the package')
})

check('the patch sets a known level', () => {
  const match = /^\s*level:\s*(\S+)\s*$/m.exec(patchText)
  assert.ok(match, 'no level line found')
  assert.ok(LEVELS.includes(match[1]), `unknown level "${match[1]}"`)
})

// --------------------------------------------------------------- module ----
const module = await import(pathToFileURL(join(packageDir, manifest.exports['.'])).href)

check('exports name / apply / inject / Config', () => {
  assert.equal(typeof module.name, 'string')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['systemPrompt', 'tools'])
  assert.ok(module.Config?.['~standard'], 'Config must be a standard schema')
})

check('Config materialises defaults and never rejects', () => {
  const good = module.Config['~standard'].validate({})
  assert.equal(good.issues, undefined)
  assert.equal(good.value.level, 'standard')
  assert.equal(good.value.reasoningEffort, 'low')
  const nonsense = module.Config['~standard'].validate({ level: null, maxTokens: 'wat', search: 7, applyToAllModels: 'yes' })
  assert.equal(nonsense.issues, undefined)
  assert.ok(Array.isArray(nonsense.value.warnings))
})

check('the validator is synchronous (async validation is unsupported)', () => {
  const result = module.Config['~standard'].validate({})
  assert.equal('then' in result, false)
})

check('apply() runs on a bare context without throwing', () => {
  const calls = []
  const tools = { guard: (g) => { calls.push(['guard', g]); return () => {} }, restrict: () => () => {} }
  const ctx = {
    tools,
    systemPrompt: { section: (s) => { calls.push(['section', s]); return () => {} } },
    logger: () => ({ info: () => {}, warn: () => {} }),
    get: () => undefined,
    effect: (execute) => execute(),
    on: () => () => {},
  }
  module.apply(ctx, {})
  assert.deepEqual(calls.map(([kind]) => kind).sort(), ['guard', 'section'])
})

check('apply() survives a context with nothing on it', () => {
  const bare = { get: () => undefined, logger: undefined, effect: (execute) => execute(), on: () => () => {} }
  module.apply(bare, { level: 'strong' })
})

// ---------------------------------------------------------- client half ----
const clientPath = join(packageDir, manifest.exports?.['./client'] ?? 'client.js')
const clientSource = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''

check('package.json declares the web client half', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.client?.immediately, true)
  assert.equal(typeof manifest.exports?.['./client'], 'string')
  assert.equal(existsSync(clientPath), true, `missing ${clientPath}`)
  assert.ok(manifest.files?.includes('client.js'), 'client.js must be published')
})

check('client.js parses as browser JavaScript', () => {
  // Parses without executing: the file calls window.__ModuleLoader__ at top level.
  new Function(clientSource)
})

check('client.js registers the documented factory, slot and API path', () => {
  assert.match(clientSource, /__ModuleLoader__\.load\(/)
  assert.match(clientSource, new RegExp(`id:\\s*'${manifest.name}'`), 'factory id must equal the package name')
  assert.match(clientSource, /'conversation\.session\.header\.actions'/, 'the conversation header action row')
  assert.ok(clientSource.includes('/dsh-terse-mode/api/state') || clientSource.includes('dsh-terse-mode/api/state'), 'must call the host route')
  // A link:-installed plugin resolves the junction to its real path, so
  // @deepseek-ai/* would fail with ERR_MODULE_NOT_FOUND: only comments may
  // mention it.
  assert.doesNotMatch(clientSource, /(?:^|[^\w.])require\(\s*['"]@deepseek-ai\//)
  assert.doesNotMatch(clientSource, /^\s*import\s[^\n]*@deepseek-ai\//m)
})

check('every level carries its own explanation, plus the settings notes', () => {
  for (const key of ['levelOffWhat', 'levelLightWhat', 'levelStandardWhat', 'levelStrongWhat']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  for (const key of ['settingsTitle', 'setting1', 'setting2', 'setting3', 'capNote']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  // The explanations reach the DOM as hover text on each segment.
  assert.match(clientSource, /title:\s*t\(LEVEL_WHAT\[level\]/, 'each level needs a hover explanation')
})

check('the panel can also set the reasoning effort', () => {
  for (const key of ['effortTitle', 'effortAuto', 'effortOff', 'effortLow', 'effortHigh', 'effortMax']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  for (const key of ['effortAutoWhat', 'effortOffWhat', 'effortLowWhat', 'effortHighWhat', 'effortMaxWhat']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  assert.match(clientSource, /post\(\{ reasoningEffort: value \}/, 'the pills must POST the effort')
  const route = readFileSync(join(packageDir, 'lib', 'level-api.js'), 'utf8')
  assert.match(route, /setReasoningEffort/, 'the host must accept it')
})

check('the panel and the Settings page can switch web search on and off', () => {
  for (const key of ['searchTitle', 'searchAllow', 'searchDeny', 'searchAuto', 'searchWhatAuto', 'searchWhatAllow', 'searchWhatDeny']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  assert.match(clientSource, /post\(\{ search: next \}/, 'the header switch must POST the choice')
  assert.match(clientSource, /post\(\{ search: value \}/, 'the pills must POST the choice')
  const route = readFileSync(join(packageDir, 'lib', 'level-api.js'), 'utf8')
  assert.match(route, /setSearch/, 'the host must accept it')
  assert.match(route, /searchChoice/, 'the state must expose the choice')
  const logic = readFileSync(join(packageDir, 'lib', 'logic.js'), 'utf8')
  assert.match(logic, /SEARCH_CHOICES = \['auto', 'allow', 'deny'\]/)
})

check('the panel and the Settings page can switch subagents off', () => {
  for (const key of ['subagentTitle', 'subagentAllow', 'subagentDeny', 'subagentWhatAllow', 'subagentWhatDeny']) {
    assert.ok(clientSource.includes(key), `missing ${key}`)
  }
  assert.match(clientSource, /post\(\{ subagents: next \}/, 'the header pill must POST the choice')
  assert.match(clientSource, /post\(\{ subagents: value \}/, 'the Settings page must POST the choice')
  const route = readFileSync(join(packageDir, 'lib', 'level-api.js'), 'utf8')
  assert.match(route, /setSubagents/, 'the host must accept it')
  const logic = readFileSync(join(packageDir, 'lib', 'logic.js'), 'utf8')
  for (const tool of ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']) {
    assert.ok(logic.includes(`'${tool}'`), `the deny list must name ${tool}`)
  }
})

check('the client registers a Settings section as well as the header control', () => {
  assert.match(clientSource, /'settings\.section'/, 'no settings.section registration')
  assert.match(clientSource, /label:\s*\(\)\s*=>\s*t\('nav'\)/, 'the section needs a nav label')
  assert.ok(clientSource.includes('sectionIntro'), 'the section needs its own copy')
})

check('the host asks for the web server instead of assuming it exists', () => {
  // The web server mounts after this row: a bare `ctx.get('webServer')` returns
  // nothing at apply time, so the panel's route was never registered at all.
  const host = readFileSync(join(packageDir, 'index.js'), 'utf8')
  assert.match(host, /ctx\.inject\(\['webServer'\]/, 'the route must be attached through optional injection')
})

check('the host registers the route the client calls', () => {
  const route = readFileSync(join(packageDir, 'lib', 'level-api.js'), 'utf8')
  assert.match(route, /API_PATH = '\/dsh-terse-mode\/api\/state'/)
  assert.match(route, /webServer\.register\(/)
})

// ------------------------------------------------------------------ report --
console.log(`package : ${packageDir}`)
for (const [ok, text] of checks) console.log(`${ok ? '  ok  ' : ' FAIL '} ${text}`)
const failed = checks.filter(([ok]) => !ok)
console.log(failed.length === 0 ? '\nPreflight passed. Safe to install.' : `\n${failed.length} check(s) failed — do NOT install.`)
process.exit(failed.length === 0 ? 0 : 1)
