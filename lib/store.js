/**
 * Where the panel's choice is remembered between DSH restarts.
 *
 * Deliberately NOT the profile patch: the panel is a runtime control, and
 * rewriting a user-owned `cordis.patch.yml` from a plugin would fight the
 * config editor and its comment preservation. A tiny JSON file under the
 * harness home is owned by this plugin alone, so the precedence is simple and
 * explainable: the panel's choice wins over the patch row, and deleting the
 * file falls back to the patch.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const STORE_FILE = 'level.json'
/** Refuse to parse anything larger: this file is one small object. */
const MAX_STORE_BYTES = 1024 * 1024
/** Distinguishes temp files within one process; the pid covers other hosts. */
let tmpSeq = 0

/**
 * Resolve `<dsh home>/storages/dsh-terse-mode/level.json`.
 *
 * The harness publishes a profile-aware resolver as the `dshHomePath` service;
 * without it (or without a profile) `$DSH_HOME` and `~/.dsh` are the same
 * answer every DSH build uses.
 */
export function resolveStorePath(ctx) {
  try {
    const homePath = ctx?.get?.('dshHomePath')
    if (typeof homePath === 'function') return homePath('storages', 'dsh-terse-mode', STORE_FILE)
  } catch { /* fall through to the environment */ }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-terse-mode', STORE_FILE)
}

/**
 * A read/write handle for the choices the panel made. Every failure is
 * non-fatal: a plugin that cannot persist must still work for this session.
 *
 * Stored shape: `{ level, reasoningEffort, search, subagents, maxTokens,
 * instruction, applyToAllModels, updatedAt }`. The four level knobs always carry
 * a value; the advanced ones are only present once the panel has touched them,
 * so "absent" keeps meaning "follow the patch".
 */
export function createLevelStore(ctx, log = () => {}) {
  const path = resolveStorePath(ctx)
  /**
   * The last parsed document, with the stat stamp it was read at.
   *
   * `apply()` and every panel request read this file, and each read used to be a
   * stat + a full parse on the caller's thread. The file only changes when a
   * choice is written (or the other host writes it), and both replace the inode,
   * so mtime + size is enough to decide the cache is stale.
   */
  let cached

  const parse = (text) => {
    const parsed = JSON.parse(text)
    if (typeof parsed?.level !== 'string') return undefined
    return {
      level: parsed.level,
      reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort : 'auto',
      search: typeof parsed.search === 'string' ? parsed.search : 'auto',
      subagents: typeof parsed.subagents === 'string' ? parsed.subagents : 'allow',
      // Undefined, not a default: an absent key means "the panel never chose",
      // which is what lets a patch value survive.
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : undefined,
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction : undefined,
      applyToAllModels: typeof parsed.applyToAllModels === 'boolean' ? parsed.applyToAllModels : undefined,
      subagentTools: Array.isArray(parsed.subagentTools) ? parsed.subagentTools.filter((name) => typeof name === 'string') : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  }

  const read = () => {
    try {
      const stat = statSync(path)
      // A corrupt or oversized file must not block the event loop on every
      // panel request (and `apply()` reads this on the boot path).
      if (stat.size > MAX_STORE_BYTES) return undefined
      // inode + birth time as well as mtime: two writes inside the same
      // millisecond produce the same mtime and size, and the temp-file rename
      // gives the new document a different identity.
      const stamp = `${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}`
      if (cached !== undefined && cached.stamp === stamp) return cached.value
      const value = parse(readFileSync(path, 'utf8'))
      cached = { stamp, value }
      return value
    } catch {
      cached = undefined
      return undefined
    }
  }

  return {
    path,
    read,
    /**
     * Persist a choice.
     *
     * @param choice — the values to store.
     * @param fields — which keys this write owns. When given, the on-disk
     *   document is the base and only those keys are replaced, so a write from
     *   the desktop host cannot clobber a field `dsh web` changed a moment ago
     *   (both hosts share this file; the watch is 150ms behind). Without it the
     *   write replaces the document, resetting unspecified knobs to defaults.
     * @returns the timestamp written, or `undefined` on failure.
     */
    write(choice, fields) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const updatedAt = new Date().toISOString()
        const owned = Array.isArray(fields) ? fields : null
        const base = owned === null
          ? { level: choice?.level, reasoningEffort: 'auto', search: 'auto', subagents: 'allow' }
          : (read() ?? { level: choice?.level, reasoningEffort: 'auto', search: 'auto', subagents: 'allow' })
        const payload = { ...base }
        for (const field of owned ?? Object.keys(choice ?? {})) {
          if (choice?.[field] !== undefined) payload[field] = choice[field]
        }
        payload.updatedAt = updatedAt
        // A sibling temp file renamed over the target: a reader (the other host)
        // never sees a half-written document, and a crash cannot truncate it.
        const tmp = `${path}.${process.pid}.${tmpSeq += 1}.tmp`
        try {
          writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
          renameSync(tmp, path)
        } catch (error) {
          try { unlinkSync(tmp) } catch { /* never created */ }
          throw error
        }
        // Our own write must be visible on the next read even if the stamp
        // happens to collide with the one it replaced.
        cached = undefined
        return updatedAt
      } catch (error) {
        log('warn', `could not remember the choice at ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
    /**
     * Call `onChange` whenever the file changes on disk — including writes made
     * by the *other* host, since the desktop app and `dsh web` share this file
     * through different profiles.
     *
     * Watches the directory rather than the file: `write()` renames a temp file
     * over the target, which replaces the inode and would detach a file watcher
     * after the very first save.
     *
     * @returns a disposer, or `undefined` when watching is unavailable (a
     *          readonly or missing directory, an unsupported platform). A plugin
     *          that cannot watch must still work — it just won't follow the
     *          other host until the next start.
     */
    watch(onChange) {
      let timer
      let watcher
      try {
        const dir = dirname(path)
        const name = basename(path)
        mkdirSync(dir, { recursive: true })
        watcher = watch(dir, { persistent: false }, (_event, file) => {
          // A `rename` may arrive with no file name; the debounce plus the
          // caller's value comparison make that false positive cheap.
          if (file !== null && file !== undefined && String(file) !== name) return
          clearTimeout(timer)
          timer = setTimeout(() => {
            try { onChange() } catch { /* a watcher must never throw */ }
          }, 150)
          timer.unref?.()
        })
        watcher.on?.('error', () => { /* keep the plugin alive, just stop following */ })
      } catch {
        return undefined
      }
      return () => {
        clearTimeout(timer)
        try { watcher?.close() } catch { /* already gone */ }
      }
    },
  }
}
