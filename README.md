# dsh-terse-mode — 少想、少搜、少废话

一个 DSH（DeepSeek Harness）插件，给同一 profile 里的所有会话（含子 agent）加一层可随时调的约束：

- **少想**：把模型请求的推理强度压到档位值，简单问题不再想很久；
- **少搜**：`web_search` / `web_fetch` 按档位或开关关闭——新会话里模型根本看不到这两个工具，老会话里真调用也会被拒绝；
- **少废话**：系统提示词最后加一条「直接答、别复述、别总结自己」的指令，**不设硬性输出上限**，回答长度只由指令引导；
- **少委派**：可一键禁用子代理（`subagent` / `subagent_fork` / `spawn_teammate` / `workflow` 四个工具从模型眼前隐藏）。

四档强度 + 三个独立开关（思考强度 / 联网搜索 / 子代理），在**对话页顶部的常驻控件**和 **DSH 设置页的「简洁模式」一节**里都能直接改，改完立即生效。

| 入口 | 位置 | 能做什么 |
|---|---|---|
| 顶部控件 | 对话页 header（「智能体团队 / 标准模式」那一行） | 切档位、开关联网、开关子代理、`?` 展开全部说明 |
| 设置页 | 设置 → 简洁模式 | 同样的控制项 + 每档解释 + 当前实际生效值 + 改在哪里的说明 |

## 快速开始

```bash
node tools/install-terse-mode.mjs                   # 桌面端（profiles/desktop）
node tools/install-terse-mode.mjs --profile web     # 网页端（dsh web 用的 profiles/web）
```

装完**刷新一次页面**即可看到控件；改档位/开关不需要重启。

## 档位

| 档位 | 思考强度 | 单次输出上限 | 联网搜索 | 适合 |
|---|---|---|---|---|
| `off` | 不动 | 不限 | 允许 | 关掉插件（总开关） |
| `light` | 压到 `low` | 不限 | 允许 | 只想让它别啰嗦 |
| `standard`（默认） | 压到 `low` | 不限 | 禁止 | 日常问答 |
| `strong` | 关到 `off` | 不限 | 禁止 | 只想快速得到短答案 |

**四个档位都不设输出上限**：回答长度只由提示词指令引导，不会被硬截断。想给某次会话硬上限，才显式写 `maxTokens: <正整数>`。

**档位给的是默认值**：思考强度与联网搜索两个开关只要不是 `auto`（跟随档位），就以开关为准；子代理开关完全独立于档位。所以上表的「思考强度 / 联网搜索」两列读作「该档位的默认值」。

## 思考强度（可单独调）

档位给的思考强度是**上限**（只降不升）；想直接指定强度，用顶部控件或设置页里的「思考强度（覆盖档位）」。
文案与官方模型菜单一致，用官方的 effort 名：

| 选项 | 含义 |
|---|---|
| `auto`（跟随档位） | 由档位决定：light / standard = `low`，strong = `off`，off（档位）= 完全不碰请求 |
| `off` | 完全关闭思考（最快） |
| `low` | 轻量思考 |
| `high` | 比档位更高——只给确实需要深思的任务 |
| `max` | 最大强度，最慢最贵 |

- **点了就是决定，不是上限**：选 `high` 会把请求强度设成 `high`（即使模型菜单里选的是低）；只有该模型确实公布了这个强度时才设，否则保持原样。
- **点档位会把思考强度与联网选择重置为「跟随档位」**：想固定就先点档位、再点强度/开关。
- 面板选择（档位 + 强度 + 联网 + 子代理）都记在 `$DSH_HOME/storages/dsh-terse-mode/level.json`。
- 命令行等价写法：POST `/dsh-terse-mode/api/state`，body `{"reasoningEffort":"high"}`（或 `{"level":"light","search":"allow"}`）。
- patch 里也可以写：`reasoningEffort: auto | none | off | low | high | max`（`auto` 跟随档位，`none` 从不碰请求）。


细项可以覆盖档位（写在 `cordis.patch.yml` 那一行的 `config` 里）：

```yaml
- id: terse-mode
  config:
    level: standard
    reasoningEffort: auto     # auto | none | off | low | high | max
    maxTokens: 0              # 0=跟随档位, -1=不限, 或正整数
    search: auto              # auto | allow | deny（面板里有开关，auto=跟随档位）
    subagents: allow          # allow | deny（也可写 true/false）
    subagentTools:            # 可选：覆盖被隐藏的工具名单
      - subagent
    instruction: auto         # auto | none | 你自己的提示词
    applyToAllModels: false   # true=对非 DeepSeek 模型也压强度
```

## 联网搜索开关

和档位**互相独立**的另一个开关（和子代理开关同款）：

```
简洁模式   [关][轻][标准][强]   [子代理]   [联网]   (?)
```

- 点一下 `联网` 就在「允许 / 禁止」之间切换；禁止时显示红字 `联网·禁止`。
- 禁止做的事：`web_search` / `web_fetch` **从模型眼前隐藏**，运行期也硬拦（guard 消息「Web tools are turned off…」），
  并在系统提示里加一句「联网已关，需要外部事实就直说，不要猜」。
- 允许做的事：即使当前档位是「标准/强」（默认禁止联网），也会放行联网工具。
- 胶囊显示的是**实际生效**状态：你没显式选过时显示档位给的值；点过以后就是你选的。
- 弹层与设置页里是三选一：**跟随档位 / 允许 / 禁止**（`auto` 让你随时回到「由档位决定」）。
  `search: auto` 走档位默认：`关/轻` 允许，`标准/强` 禁止。
- 点档位会把这个显式选择**重置为「跟随档位」**（和思考强度一样），想固定就先点档位再点开关。
- 不依赖联网的外部事实无法获得时，模型会明说而不是编造 —— 这是禁止联网的预期代价。

## 禁用子代理

和档位**互相独立**的一个开关（不跟着档位变、改档位也不会重置它）：

```
简洁模式   [关][轻][标准][强]   [子代理]   (?)
```

点一下 `子代理` 就在「允许 / 禁用」之间切换（禁用时显示红字 `子代理·禁用`）。禁用做的事：
把**四个创建子代理的工具**（`subagent`、`subagent_fork`、`spawn_teammate`、`workflow`）从模型眼前隐藏，并在运行期硬拦它们的调用
（guard 的消息是「Subagents are turned off…」）。团队记账类工具（`team_task_*` 等）不动：没有创建入口它们本身做不了事。
要自定义名单就写 `subagentTools`。默认 `allow`，不改变原有行为。

## 在设置页面里调

除了对话页顶部的小控件，**DSH 设置页里也有一节「简洁模式」**（客户端插件注册 `settings.section` 槽），里面有：
档位四选一 + 每档解释、思考强度五选一、**联网搜索三选一**、子代理开关、当前实际生效值、以及「改在哪里」的说明。
两处是**同一份状态**：在设置页里改，顶部控件立刻跟着变，反之亦然。

## 两个部署（桌面端 + 网页端）

插件装在 **profile** 里，桌面端和网页端用的是不同 profile，所以要各装一次：

```bash
node tools/install-terse-mode.mjs                    # 桌面端（profiles/desktop）
node tools/install-terse-mode.mjs --profile web      # 网页端（dsh web 用的 profiles/web）
```

`--profile <名字>` 对应 `$DSH_HOME/profiles/<名字>`；`--status` 看当前状态，`--uninstall` 撤销（都要带同一个 `--profile`）。
两端共用同一个记忆文件 `$DSH_HOME/storages/dsh-terse-mode/level.json`，所以档位/强度/子代理选择是共享的。

改档位有两种办法，任选：

1. 在插件目录里执行 `node tools/install-terse-mode.mjs --level strong`（改的是插件自带的 patch）；
2. 在你 profile 的 `cordis.patch.yml` 里按 `id: terse-mode` 覆盖同一行 —— 这一层优先级最高，升级插件也不会丢，
   而且改 profile 的 patch 是**热生效**的（约 1 秒），不用重启。

> 注意区分：改**配置**（档位/细项）是热生效的；改**插件代码**（`index.js`/`lib/`/`client.js`）需要重启一次 DSH 才换用新模块，
> 因为已安装的模块不会重新导入（实测：加一条注释触发 profile 重组合后，新路由仍然 404）。新增 client 半侧同样需要重启。

面板里点档位则**不需要**重启：那是运行时改策略，不走模块加载。
## 可视化面板

对话页**顶部那一行**（「智能体团队 / 标准模式 / 费用明细」旁边）有一个常驻控件：

```
简洁模式   [关][轻][标准][强]   [子代理]   (?)
```

- 点一下档位就立即生效，不用改文件、不用重启：提示词、思考强度、输出上限、联网搜索一起跟着变。
- **每个档位鼠标移上去都有说明**（原生提示，一句话说清这一档压什么、放什么）。
- `子代理` 一键禁用/允许子代理（详见上文「禁用子代理」）。
- **`?`** 打开说明与设置面板：
  - 「每一档在做什么」：四档逐条解释，当前档高亮；
  - 「思考强度（覆盖档位）」：`跟随档位 / 关 / 低 / 高 / 最高`，每个都有 hover 说明；
  - 「子代理」：`允许 / 禁用`，附一句当前语义；
  - 「当前实际生效」：思考强度 / 输出上限 / 联网搜索 / 提示词指令，显示的是**实际生效值**（模型菜单里选得更高也会被压到档位值）；
  - 「改在哪里」：细项在插件的 `cordis.patch.yml`（或 profile patch 里按 `id: terse-mode` 覆盖）；面板选的档位存在
    `$DSH_HOME/storages/dsh-terse-mode/level.json`，优先于 patch，删掉即回到 patch；点档位/改配置立即生效，改代码要重启。
- 弹层用 `position: fixed` 挂在按钮下方：顶部那一行不归插件管，绝对定位的盒子可能被裁掉。
- 选择会记住（存到 `$DSH_HOME/storages/dsh-terse-mode/level.json`）。**面板的选择优先于 patch 里的 `level`**；
  想回到 patch 的档位，删掉那个文件即可。
- 面板没连上宿主时按钮右边会显示红字「未连上宿主」（通常是插件刚更新，还需要重启一次 DSH）。

面板与宿主之间走的是 DSH 自己的 HTTP 路由：`GET/POST /dsh-terse-mode/api/state`（仅回环，
和插件市场 `/dsh-market/*` 同一个通道）。手工核对：

```sh
curl http://127.0.0.1:19387/dsh-terse-mode/api/state
curl -X POST -H 'content-type: application/json' -d '{"level":"strong"}' http://127.0.0.1:19387/dsh-terse-mode/api/state
```

## 实测效果（本机 desktop profile，同一个会话）

| | 装之前 | 装之后 |
|---|---|---|
| 推理强度 | `high` | `low` |
| 单次输出上限 | `256000`（适配器默认） | **不限**（档位不再设上限） |
| 工具表 | 含 `web_search`、`web_fetch` | 两者都不再出现 |

`http://127.0.0.1:19387/dsh-market/installed` 里显示 `dsh-terse-mode: state=live`、`findings: []`。

## 安全设计（为什么它不会把你搞崩）

- **配置写错不会让插件启动失败**：插件的配置校验器永不报错，认不出的值一律回落到安全默认，并在日志里留一条 warning。
  （本机曾因插件启动失败触发过 Desktop 安全模式，把 profile 的 bundles 砍回 in-box，所以这里必须这么设计。）
- **绝不强行给不支持思考的模型加推理强度**：只有请求本身已经带了 `reasoningEffort` 时才压，而且只降不升、只认 `off/low/high/max` 这组 DeepSeek 的取值。
  默认只对 provider 以 `deepseek` 开头的路由生效，`applyToAllModels: true` 才放开。
- **工具禁用是双保险**：`tools.guard()` 让调用必定失败（对所有会话立即生效），`tools.restrict()` 让新会话的模型看不到这两个工具。
  `restrict` 在报「未知工具名」时会被吞掉并记日志，绝不让 agent 创建失败。
- **零运行时依赖**：纯 JS，不 import 任何 DSH 包，也不带 node_modules。

## 已知边界（先说清楚）

- **输出不再有硬截断**：四个档位都不设 `maxTokens`，长回答不会被切断；长度只由提示词指令引导。若你想要硬上限，显式写 `maxTokens: <正整数>`（插件只会在模型/路由已有的值上取更小的那个）。
- **禁止搜索后，你明确说「搜一下」也搜不了**。要搜就把 `search` 设成 `allow`（或整个切到 `light`/`off`）。
- **「让模型看不到工具」在装上的那一刻就对已开会话生效**（插件会扫一遍在跑的 agent）；靠 guard 兜底的拒绝路径由单测覆盖。
- **对所有会话生效**，包括子 agent；没有「只对这个会话」的开关（`off` 档就是总开关）。
- **改代码要重启**，改配置是热生效（见上）。
- **诊断噪音**：本插件的配置校验是零依赖手写实现（`link:` 安装的插件解析不到 `@deepseek-ai/*`），
  所以 `dsh --dump-config-schema` 会对本行多报一条 `Config is not a native Schemastery schema`。
  这条命令不参与启动，插件运行不受影响。

## 安装 / 卸载

```sh
# 看当前状态
node tools/install-terse-mode.mjs --status

# 只预演，不写文件
node tools/install-terse-mode.mjs --dry-run

# 安装（默认 standard 档）
node tools/install-terse-mode.mjs
node tools/install-terse-mode.mjs --profile desktop --level light

# 卸载（会先把 profile 清单与 patch 备份到 工作区/.backup/<时间戳>/）
node tools/install-terse-mode.mjs --uninstall
```

安装只动 profile 这四处：`package.json` 里一条 `link:` 依赖、`node_modules/dsh-terse-mode` 这个 junction、
**profile 自己的 `cordis.patch.yml` 里一行带标记的 `insert`**（非 desktop profile 还会补 `dsh.profile.bundles`）。
不跑 pnpm、不动 lockfile，所以其他已装插件不会受影响；卸载时全部还原。

**为什么不靠 `dsh.profile.bundles`**：2026-10-01 12:29 实测，Desktop 宿主启动时重写了 desktop profile 的 `package.json`，
把 `dsh-terse-mode` 从 `dsh.profile.bundles` 里删掉了（依赖条目还在，market 日志与 plugin-manager 都没有对应操作），
插件于是在下一次启动时不再挂载。profile 的 `cordis.patch.yml` 是用户层，宿主只做外科式改动、保留它 —— 把行插在那里才是稳的。
`name: dsh-terse-mode` 由 profile 的 `node_modules`（junction）解析，与 bundles 无关。标记注释 `>>> dsh-terse-mode >>>` / `<<<` 让改档位与卸载都能精确替换那一段。

> 实测补充：**改宿主模块代码（`index.js` / `lib/`）必须重启一次 DSH**。即便把 profile patch 里那一行删掉再插回来（重新挂载一次），
> 宿主仍然复用内存里的旧模块（三个档位 POST 后 effective 值完全一致，即可判定跑的还是旧代码）。改配置/点档位不需要重启。

## 开发

```sh
cd terse-mode
node --test test/logic.test.mjs     # 档位与钳制规则
node --test test/plugin.test.mjs    # apply() 的接线（用一个假 Cordis context）
```

设计说明与取舍见 [`docs/design.md`](docs/design.md)。
