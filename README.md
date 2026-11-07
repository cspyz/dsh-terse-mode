English | [中文](README.zh.md)

# dsh-terse-mode — think less, search less, talk less

[![test](https://github.com/cspyz/dsh-terse-mode/actions/workflows/test.yml/badge.svg)](https://github.com/cspyz/dsh-terse-mode/actions/workflows/test.yml)

A DeepSeek Harness plugin: four levels that sit in the conversation header, plus three switches you can turn on their own — reasoning effort, web search, subagents. Changes apply to the next request.

**It is not "shorter answers".** The point is control, not compression. A level is a master switch; the three toggles let you pin one thing independently; and **no level caps output length** — brevity is asked for in the prompt, never enforced with a token limit.

<img src="assets/screenshots/01-header-row.png" width="880" alt="The Terse mode control in the conversation header: next to the host's own agent-team / standard-mode / cost-details buttons, with Off / Light / Std / Strong, Subagents, Web search and ? on the right">

## Install

```sh
dsh plugin --profile web add dsh-terse-mode        # dsh web
dsh plugin --profile desktop add dsh-terse-mode    # desktop app
```

That resolves through npm. To pin a commit instead — or to try a build that is not published yet — install straight from the repository:

```sh
dsh plugin --profile web add github:cspyz/dsh-terse-mode
```

The two profiles are independent — install once per profile if you use both. Restart DSH once (or reload the page); the control then appears in the conversation header.

> **Gone after a restart?** Known Desktop-host behaviour: on boot it rewrites the profile's `package.json` and drops the plugin's row from `dsh.profile.bundles`. Use the script install instead — it writes the row into the profile's own `cordis.patch.yml`, a user layer the host only edits surgically:

```sh
node tools/install-terse-mode.mjs                   # desktop
node tools/install-terse-mode.mjs --profile web     # dsh web
```

It touches four places in the profile: one `link:` dependency in `package.json`, one `node_modules` junction, one marked `insert` row in `cordis.patch.yml` (non-desktop profiles also get `dsh.profile.bundles`). No pnpm, no lockfile, no effect on other plugins; uninstall reverts all of it.

## What it does

- **Think less** — pins the request's reasoning effort to the level's value, so a simple question stops taking a minute.
- **Search less** — at *Std* and *Strong*, `web_search` / `web_fetch` are removed from the model's tool list entirely, and refused if it calls them anyway.
- **Talk less** — one line at the end of the system prompt: answer directly, do not restate, do not summarise yourself. **No hard output limit.**
- **Delegate less** — `subagent`, `subagent_fork`, `spawn_teammate` and `workflow` are hidden from the model and refused at call time.

Two entry points, one set of settings:

| Entry | Where | What you can do |
|---|---|---|
| Header control | the conversation header row, beside the host's own buttons | switch level, toggle search, toggle subagents, open `?` for the full explanation |
| Settings | Settings → **Terse mode** | the same controls, roomier, plus the effective values and where to change them |

## Levels

| Level | Reasoning effort (default) | Web search (default) | Output cap | For |
|---|---|---|---|---|
| **Off** | untouched | allowed | none | temporarily disable the plugin |
| **Light** | `low` | allowed | none | just stop the rambling |
| **Std** (default) | `low` | disabled | none | everyday questions |
| **Strong** | `off` | disabled | none | fastest short answer |

A level only supplies **defaults**: the reasoning and search switches win whenever they are not on *Follow level*, and the subagent switch is independent of the level entirely.

> Clicking a level resets reasoning and search back to *Follow level*. To pin a combination, pick the level first, then the switches.

## Reasoning effort (overrides the level)

| Option | Meaning |
|---|---|
| `auto` | decided by the level: Light / Std = `low`, Strong = `off`, level Off = the request is never touched |
| `off` | thinking disabled — the fastest |
| `low` | light reasoning; enough for daily work |
| `high` | the model's high effort, above what the levels give |
| `max` | maximum effort: slowest and most expensive |

The chosen effort **is** the decision: pick `high` here and the request is sent at `high` even if the model menu says otherwise — but only where the route actually advertises that effort, so an unsupported value can never fail the request. The choice is remembered across restarts.

## Web search and subagents

- **Search disabled** — `web_search` / `web_fetch` are removed from the model's tool list, and a real call is refused with "say you cannot look it up, do not guess". The cost is real: it cannot check current facts. Switch search to *allowed*, or the level to *Light*, when you need that.
- **Subagents disabled** — the four delegation tools disappear from the model's view. Cheaper per task, and harder to lose control of; the price is no parallel fan-out on big jobs.

## FAQ

**Do I need to restart after changing a level?** No. Levels and switches apply immediately; only the first install needs a restart.

**Does it actually save tokens?** Yes. Reasoning is billed as output, so `low` / `off` saves the most; disabling search saves the results and the extra turn; disabling subagents saves a whole context per subagent. The plugin adds a short instruction (about a hundred tokens) to each request — a net win on anything that would otherwise think or search.

**Will it truncate my answers?** No. No level sets an output ceiling; length is guided by the instruction only.

**Why does it refuse to search when I say "search for it"?** That is what *disabled* means. Set search to *allowed*, or the level to *Light*.

**Where is the choice stored?** Locally, in `$DSH_HOME/storages/dsh-terse-mode/level.json`, and it survives restarts.

## Configuration (optional)

Nothing here needs changing. To pin values in your profile's `cordis.patch.yml`, override by `id: terse-mode`:

```yaml
- id: terse-mode
  config:
    level: standard          # off | light | standard | strong
    reasoningEffort: auto    # auto | none | off | low | high | max
    search: auto             # auto | allow | deny
    subagents: allow         # allow | deny
    instruction: auto        # auto | none | your own prompt
    applyToAllModels: false  # true = also cap non-DeepSeek models
```

A choice made in the panel wins over `level` in this file; delete the storage file above to fall back to the configured value. Config edits apply immediately; source edits need a DSH restart.

## Security

- **Zero runtime dependencies** — plain JavaScript, no third-party packages.
- **A malformed config cannot stop DSH from booting** — unrecognised values fall back to safe defaults and leave one line in the log.
- **No effort is forced onto a model that does not support it** — only the request's existing effort is adjusted, and by default only on DeepSeek routes.
- **It only touches itself** — installing changes the current profile only, runs no package manager, and leaves the lockfile alone; other plugins are unaffected. Uninstall reverts everything.
- **The state API is loopback-only** — `POST /dsh-terse-mode/api/state` rejects a non-loopback `Host` (DNS rebinding), a cross-origin request, and any body that is not JSON.
- **Data stays on this machine** — levels and switches are stored locally.

## Uninstall

```sh
dsh plugin --profile web remove dsh-terse-mode
dsh plugin --profile desktop remove dsh-terse-mode
```

Use the same spec you installed with — `github:cspyz/dsh-terse-mode` if you pinned the repository.

If you installed with the script, run `node tools/install-terse-mode.mjs --uninstall` (desktop) or add `--profile web`. It backs up the profile manifest and patch to `.backup/<timestamp>/` in the workspace first.

## License

[MIT](LICENSE)
