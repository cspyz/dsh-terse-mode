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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const STORE_FILE = 'level.json'

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
 * Stored shape: `{ level, reasoningEffort, updatedAt }` where
 * `reasoningEffort` is one of `auto | none | off | low | high | max`.
 */
export function createLevelStore(ctx, log = () => {}) {
  const path = resolveStorePath(ctx)
  return {
    path,
    /** @returns `{ level, reasoningEffort, search, subagents, updatedAt }`, or `undefined`. */
    read() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof parsed?.level !== 'string') return undefined
        return {
          level: parsed.level,
          reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort : 'auto',
          search: typeof parsed.search === 'string' ? parsed.search : 'auto',
          subagents: typeof parsed.subagents === 'string' ? parsed.subagents : 'allow',
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        }
      } catch {
        return undefined
      }
    },
    /** @returns the timestamp written, or `undefined` on failure. */
    write(choice) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const updatedAt = new Date().toISOString()
        const payload = {
          level: choice?.level,
          reasoningEffort: choice?.reasoningEffort ?? 'auto',
          search: choice?.search ?? 'auto',
          subagents: choice?.subagents ?? 'allow',
          updatedAt,
        }
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)
        return updatedAt
      } catch (error) {
        log('warn', `could not remember the choice at ${path}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
  }
}
