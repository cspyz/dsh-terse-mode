#!/usr/bin/env node
/**
 * install-terse-mode.mjs — put the `dsh-terse-mode` bundle into a DSH profile,
 * or take it back out again.
 *
 * WHY THE PROFILE PATCH, NOT `dsh.profile.bundles`
 * -----------------------------------------------
 * On this machine the Desktop host rewrote `profiles/desktop/package.json` at
 * 2026-10-01 12:29 and dropped `dsh-terse-mode` from `dsh.profile.bundles`
 * (the dependency entry stayed, and neither the market log nor the plugin
 * manager logged an operation), which unmounted the plugin on the next boot.
 * A row inserted into the profile's own `cordis.patch.yml` survives, because
 * that file is the user's layer — the market only ever edits it surgically and
 * preserves it. The plugin name resolves from the profile's `node_modules`,
 * where the junction below points.
 *
 * So this script touches exactly four things outside the workspace:
 *   1. `<profile>/package.json`            — one `link:` dependency entry
 *   2. `<profile>/node_modules/dsh-terse-mode` — a junction to this package
 *   3. `<profile>/cordis.patch.yml`        — one marked `insert:` row
 *   4. (non-desktop profiles) `dsh.profile.bundles` — kept for the templates
 *      that expect a listed bundle
 *
 * Everything it overwrites is copied to `<workspace>/.backup/<timestamp>/`
 * first, and `--uninstall` undoes every edit. It deliberately does NOT run
 * pnpm: a `link:` dependency resolves through the junction, and leaving the
 * lockfile alone keeps every other installed plugin exactly as it is.
 *
 * Usage:
 *   node tools/install-terse-mode.mjs --dry-run
 *   node tools/install-terse-mode.mjs [--level strong] [--profile desktop]
 *   node tools/install-terse-mode.mjs --status
 *   node tools/install-terse-mode.mjs --uninstall
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-terse-mode'
const DIR_NAME = 'terse-mode'
const ROW_ID = 'terse-mode-profile'
const LEVELS = ['off', 'light', 'standard', 'strong']
const MARK_START = '# >>> dsh-terse-mode (managed by tools/install-terse-mode.mjs) >>>'
const MARK_END = '# <<< dsh-terse-mode <<<'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
// Two layouts are supported: the development workspace (`<workspace>/terse-mode`
// next to `<workspace>/tools`) and a published checkout where the repository root
// *is* the plugin package (`<repo>/tools`).
const packageDir = existsSync(join(workspace, DIR_NAME, 'package.json'))
  ? join(workspace, DIR_NAME)
  : workspace

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const dryRun = has('--dry-run')
const uninstall = has('--uninstall')
const statusOnly = has('--status')
const level = option('--level', null)
const profile = option('--profile', process.env.DSH_PROFILE || 'desktop')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const profilePatchPath = join(profileDir, 'cordis.patch.yml')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const bundlePatchPath = join(packageDir, 'cordis.patch.yml')
const isDesktop = profile === 'desktop'

const say = (...args) => console.log(...args)
const fail = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

if (!existsSync(manifestPath)) fail(`找不到 profile 清单：${manifestPath}（profile 名字或 DSH_HOME 不对？）`)
if (!existsSync(packageDir)) fail(`找不到插件目录：${packageDir}`)

const manifestRaw = readFileSync(manifestPath, 'utf8')
let manifest
try {
  manifest = JSON.parse(manifestRaw)
} catch (error) {
  fail(`profile 清单不是合法 JSON，我没有改任何东西：${String(error.message)}`)
}

const bundles = () => {
  const list = manifest?.dsh?.profile?.bundles
  return Array.isArray(list) ? list : []
}
const installedSpec = () => manifest?.dependencies?.[PACKAGE_NAME]
const readPatch = () => (existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : '')
const patchHasRow = () => readPatch().includes(MARK_START)

/** The bundle's own level, which the profile row mirrors on install. */
function bundleLevel() {
  const match = /^\s*level:\s*(\S+)\s*$/m.exec(existsSync(bundlePatchPath) ? readFileSync(bundlePatchPath, 'utf8') : '')
  return match && LEVELS.includes(match[1]) ? match[1] : 'standard'
}

function rowBlock(levelValue) {
  return [
    MARK_START,
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: ${PACKAGE_NAME}`,
    '      config:',
    '        level: ' + levelValue,
    '        # output is never capped by a level (maxTokens still accepts a positive number)',
    '        maxTokens: -1',
    MARK_END,
    '',
  ].join('\n')
}

/** Replace the marked row in place, or append it. */
function upsertRow(levelValue) {
  const text = readPatch()
  const block = rowBlock(levelValue)
  if (patchHasRow()) {
    const start = text.indexOf(MARK_START)
    const end = text.indexOf(MARK_END, start)
    if (end < 0) fail(`${profilePatchPath} 里有开始标记却没有结束标记，我不动它，请你手工检查`)
    const after = `${text.slice(start, end + MARK_END.length)}\n`
    if (after === block) return false
    writeFileSync(profilePatchPath, `${text.slice(0, start)}${block}${text.slice(end + MARK_END.length).replace(/^\r?\n/, '')}`)
    return true
  }
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  writeFileSync(profilePatchPath, `${text}${separator}${block}`)
  return true
}

/** Remove the marked row, preserving everything around it. */
function removeRow() {
  const text = readPatch()
  const start = text.indexOf(MARK_START)
  if (start < 0) return false
  const end = text.indexOf(MARK_END, start)
  if (end < 0) fail(`${profilePatchPath} 里有开始标记却没有结束标记，我不动它，请你手工检查`)
  const rest = text.slice(end + MARK_END.length).replace(/^\r?\n/, '')
  writeFileSync(profilePatchPath, `${text.slice(0, start)}${rest}`)
  return true
}

// ---------------------------------------------------------------- status ----
function status() {
  say(`profile        : ${profileDir}`)
  say(`插件目录       : ${packageDir}`)
  say(`依赖条目       : ${installedSpec() ?? '(没有)'}`)
  say(`node_modules   : ${describePath(linkPath)}`)
  say(`profile patch  : ${patchHasRow() ? `已插入行 ${ROW_ID}（level=${readPatch().match(/^\s*level:\s*(\S+)\s*$/m)?.[1] ?? '?'}）` : '(没有插入行)'}`)
  say(`bundles        : ${bundles().length ? bundles().join(', ') : '(空)'}（含插件: ${bundles().includes(PACKAGE_NAME) ? '是' : '否'}）`)
}

function describePath(path) {
  if (!existsSync(path)) return '(不存在)'
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return `junction/symlink → ${resolve(path)}`
    return stat.isDirectory() ? '(真实目录)' : '(不是目录)'
  } catch (error) {
    return `(读不到: ${String(error.message)})`
  }
}

// ---------------------------------------------------------------- backup ----
function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(workspace, '.backup', `${PACKAGE_NAME}-${stamp}`)
  if (dryRun) {
    say(`[dry-run] 会备份 package.json、cordis.patch.yml 到 ${dir}`)
    return dir
  }
  mkdirSync(dir, { recursive: true })
  copyFileSync(manifestPath, join(dir, 'package.json'))
  if (existsSync(profilePatchPath)) copyFileSync(profilePatchPath, join(dir, 'cordis.patch.yml'))
  const lock = join(profileDir, 'pnpm-lock.yaml')
  if (existsSync(lock)) copyFileSync(lock, join(dir, 'pnpm-lock.yaml'))
  say(`已备份 profile 清单与 patch 到 ${dir}`)
  return dir
}

// ---------------------------------------------------------------- install ---
function setLevel(nextLevel) {
  if (!LEVELS.includes(nextLevel)) fail(`level 必须是 ${LEVELS.join(' | ')} 之一，收到 "${nextLevel}"`)
  if (!existsSync(bundlePatchPath)) fail(`找不到 ${bundlePatchPath}`)
  const text = readFileSync(bundlePatchPath, 'utf8')
  if (!/^\s*level:\s*\S+\s*$/m.test(text)) fail('cordis.patch.yml 里没有可替换的 level 行，我不猜你的意图')
  const next = text.replace(/^(\s*level:\s*)\S+\s*$/m, `$1${nextLevel}`)
  if (next !== text) {
    if (dryRun) say(`[dry-run] ${bundlePatchPath}: level → ${nextLevel}`)
    else { writeFileSync(bundlePatchPath, next); say(`档位已设为 ${nextLevel}（${bundlePatchPath}）`) }
  }
  if (patchHasRow()) {
    if (dryRun) say(`[dry-run] profile patch 行 level → ${nextLevel}`)
    else if (upsertRow(nextLevel)) say(`profile patch 行同步为 ${nextLevel}`)
  }
}

function install() {
  const spec = `link:${packageDir.replaceAll('\\', '/')}`
  const targetBlock = rowBlock(bundleLevel())
  // The marked row is kept in sync with the template, so a change to the
  // template (e.g. the explicit `maxTokens: -1`) reaches an existing install.
  const rowOutdated = patchHasRow() && !readPatch().includes(targetBlock)
  const changes = []
  if (installedSpec() !== spec) changes.push(`dependencies.${PACKAGE_NAME} = ${spec}`)
  if (!patchHasRow()) changes.push(`cordis.patch.yml += insert 行 ${ROW_ID}`)
  else if (rowOutdated) changes.push(`cordis.patch.yml 的行 ${ROW_ID} 与当前模板不一致（会改写）`)
  if (bundles().includes(PACKAGE_NAME)) changes.push(`dsh.profile.bundles -= ${PACKAGE_NAME}（避免 bundle 行与 profile 行把插件挂两次）`)
  if (!existsSync(linkPath)) changes.push(`junction ${linkPath} → ${packageDir}`)

  if (changes.length === 0) say('已经是目标状态，无需改动。')
  else {
    say('将要写入的改动：')
    for (const line of changes) say(`  - ${line}`)
    say('  （不写 dsh.profile.bundles：宿主会在启动时重写它，而 bundle 层会再插一行，插件靠 profile patch 的那一行挂载）')
  }

  if (dryRun) {
    if (level) setLevel(level)
    say('[dry-run] 没有写入任何文件。')
    return
  }
  if (changes.length === 0 && !level) return

  backup()
  const manifestChanged = installedSpec() !== spec || bundles().includes(PACKAGE_NAME)
  if (installedSpec() !== spec) {
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: spec }
  }
  if (bundles().includes(PACKAGE_NAME)) {
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: bundles().filter((name) => name !== PACKAGE_NAME) } }
  }
  if (manifestChanged) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    say(`已更新 ${manifestPath}`)
  }
  const hadRow = patchHasRow()
  if (upsertRow(bundleLevel())) {
    say(hadRow ? `已同步 profile patch 行（${profilePatchPath}）` : `已插入 profile patch 行（${profilePatchPath}）`)
  }
  if (level) setLevel(level)

  if (!existsSync(linkPath)) {
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    symlinkSync(packageDir, linkPath, 'junction')
    say(`已创建 junction：${linkPath} → ${packageDir}`)
  }

  say('\n下一步：')
  say('  1) 刷新界面（F5）。profile patch 是被监听的，新增的行通常会立刻挂载；看不到就重启一次 DSH。')
  say('  2) 复查：`node tools/install-terse-mode.mjs --status`；宿主自检：curl http://127.0.0.1:19387/dsh-terse-mode/api/state')
  say('  3) 改档位：`node tools/install-terse-mode.mjs --level off|light|standard|strong`')
  say('  4) 撤销：`node tools/install-terse-mode.mjs --uninstall`')
}

// -------------------------------------------------------------- uninstall ---
function uninstallNow() {
  const spec = installedSpec()
  if (spec === undefined && !patchHasRow() && !bundles().includes(PACKAGE_NAME) && !existsSync(linkPath)) {
    say('插件本来就没装，无需撤销。')
    return
  }
  if (dryRun) {
    say(`[dry-run] 会移除 dependencies.${PACKAGE_NAME}、profile patch 里的行 ${ROW_ID}、bundles 里的条目与 ${linkPath}`)
    return
  }
  backup()
  if (removeRow()) say(`已从 ${profilePatchPath} 移除插入行`)
  if (spec !== undefined) delete manifest.dependencies[PACKAGE_NAME]
  if (manifest.dsh?.profile) manifest.dsh.profile.bundles = bundles().filter((name) => name !== PACKAGE_NAME)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  say(`已从 ${manifestPath} 移除插件条目`)

  if (existsSync(linkPath)) {
    if (lstatSync(linkPath).isSymbolicLink()) {
      unlinkSync(linkPath)
      say(`已移除 junction：${linkPath}`)
    } else {
      say(`注意：${linkPath} 不是 junction（可能是真实目录），我没有删，请自行确认。`)
    }
  } else {
    say('node_modules 里本来就没有这个条目。')
  }
  say(`\n插件已卸载（插件目录本身没删：${packageDir}）。重启或刷新后生效。`)
}

// ------------------------------------------------------------------ main ----
say(`DSH profile    : ${profile}`)
if (statusOnly) status()
else if (uninstall) uninstallNow()
else install()
