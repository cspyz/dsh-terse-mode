# dsh-terse-mode · 简洁模式

> Keep the agent terse: four adjustable levels plus independent switches for reasoning
> effort, web search and subagents, on the conversation header and in Settings.

一个 DeepSeek Harness 插件：**给 AI 装上「少想、少搜、少废话、少委派」四个旋钮。**

DeepSeek 处理一个简单问题也要想很久、动不动联网搜一圈、回答又长又绕，还可能把活丢给子代理再烧一遍 token —— 这个插件把这些都变成你随时能拨的开关，改完立即生效。

```
简洁模式   [关][轻][标准][强]   [子代理]   [联网]   (?)
```

**不需要任何其他插件**，原生 DSH 装上即用；零运行时依赖。

---

## 它做什么

| 旋钮 | 效果 |
|---|---|
| **四档强度** | 一键切换「关 / 轻 / 标准 / 强」，同时决定思考强度、联网与提示词力度 |
| **思考强度** | 单独指定 `off / low / high / max`，或让它跟随档位；压住「一个问题想半天」 |
| **联网搜索** | 允许 / 禁止 / 跟随档位；禁止时模型看不到搜索工具，也不会硬编事实 |
| **子代理** | 允许 / 禁用；禁用后模型必须自己在当前会话干完，不再乱派活 |

**四个档位都不设输出上限**，长回答不会被硬截断——长度只由「直接答、别复述」这条指令引导。

装上后对所有会话生效（包括子代理），并且在**对话页顶部**和 **DSH 设置页**各有一个入口，改哪边都一样。

---

## 安装

要求：DSH 桌面端，或 `dsh web`（任一已能正常对话的版本）。

```bash
dsh plugin --profile web add github:cspyz/dsh-terse-mode        # 网页端
dsh plugin --profile desktop add github:cspyz/dsh-terse-mode    # 桌面端
```

装完**重启一次 DSH**（或重启 `dsh web`），对话页顶部就会出现控件。

- 桌面端和网页端是**两个独立 profile**，两边都想用就各装一次。
- 装完即用，不需要在设置里额外启用什么。

**其他安装方式（可选）**

- 如果你另外装了第三方插件市场，也可以直接在市场里搜 `dsh-terse-mode` 安装。
- 也可以克隆仓库后用自带脚本安装，效果相同：

  ```bash
  git clone https://github.com/cspyz/dsh-terse-mode.git
  cd dsh-terse-mode
  node tools/install-terse-mode.mjs                    # 桌面端
  node tools/install-terse-mode.mjs --profile web      # 网页端
  ```

---

## 怎么用

### 顶部控件

插件会在**对话页顶部那一行**放一个常驻控件：

- 点 **关 / 轻 / 标准 / 强** 切换档位，立即生效；
- 点 **子代理**、**联网** 单独开关（禁用时显示红字提醒）；
- 鼠标移到按钮上有说明；
- 点 **?** 展开完整面板：每一档做什么、思考强度选择、当前实际生效的值、以及去哪里改配置。

### 设置页

**设置 → 简洁模式**：和顶部控件是同一份设置，只是排版更宽松，适合慢慢看说明。

### 四档分别是什么

| 档位 | 思考强度（默认） | 联网（默认） | 适合 |
|---|---|---|---|
| **关** | 不干预 | 允许 | 临时关掉插件 |
| **轻** | `low` | 允许 | 只想让它别啰嗦 |
| **标准**（默认） | `low` | 禁止 | 日常问答 |
| **强** | `off` | 禁止 | 只要快、只要短 |

档位给的是**默认值**：思考强度和联网只要不是「跟随档位」，就以你选的开关为准；子代理开关完全独立于档位。

> 点档位会把思考强度与联网选择重置为「跟随档位」。想固定组合，先点档位、再点开关。

### 思考强度怎么选

| 选项 | 含义 |
|---|---|
| `auto` | 跟随档位（轻 / 标准 = `low`，强 = `off`） |
| `off` | 完全不思考，最快 |
| `low` | 轻量思考，日常够用 |
| `high` | 明显更强的推理，慢一些 |
| `max` | 最强，最慢也最贵 |

选定的强度**就是决定**：哪怕模型菜单里选的是低，这里选 `high` 也会按 `high` 发请求（仅在该模型确实支持时）。选择会被记住，重启后依然生效。

### 联网与子代理

- 禁止联网时：`web_search` / `web_fetch` 从模型可见的工具里移除，真调用也会被拒绝，并提示「需要外部事实就直说，不要猜」。**代价是它无法再查最新信息**——临时要用，把联网切成「允许」即可。
- 禁用子代理时：`subagent`、`subagent_fork`、`spawn_teammate`、`workflow` 四个工具都会被隐藏并拒绝调用。适合不想让 AI 到处派活、想省 token 的时候。

---

## 常见问题

**改了档位要重启吗？** 不用，档位和开关都是即时生效（只有首次安装插件需要重启一次）。

**更省 token 吗？** 会。思考（reasoning）按输出计费，压到 `low`/`off` 省得最多；禁止联网省掉搜索结果与额外轮次；禁用子代理省掉每个子代理的整套上下文开销。插件本身会给每次请求加一小段指令（约一百多 token），对需要思考或搜索的问题稳赚。

**它会截断我的回答吗？** 不会。四个档位都不设输出上限，只靠指令引导简短。

**为什么禁止联网后我说「搜一下」它也不搜？** 这是「禁止」的定义。把联网切成「允许」，或把档位切到「轻」即可。

**想完全关掉？** 档位点「关」。

**选择存在哪？** 记在本机（`$DSH_HOME/storages/dsh-terse-mode/level.json`），重启后保持。

---

## 配置（进阶，可选）

默认不用改任何东西。想写进配置文件的，可在你的 profile `cordis.patch.yml` 里按 `id: terse-mode` 覆盖：

```yaml
- id: terse-mode
  config:
    level: standard          # off | light | standard | strong
    reasoningEffort: auto    # auto | none | off | low | high | max
    search: auto             # auto | allow | deny
    subagents: allow         # allow | deny
    instruction: auto        # auto | none | 你自己的提示词
    applyToAllModels: false  # true = 对非 DeepSeek 模型也压强度
```

- 面板里的选择**优先于**配置里的 `level`；删掉上面那个存储文件即回到配置值。
- 改配置文件即时生效；改插件源码需重启 DSH。

---

## 安全性

- **零运行时依赖**：纯 JavaScript，不引入任何第三方包。
- **配置写错也不会让 DSH 启动失败**：无法识别的取值一律回落到安全默认，只在日志里留一条提醒。
- **不给不支持的模型硬塞参数**：只调整请求里已有的推理强度，且默认只对 DeepSeek 路由生效。
- **只动自己**：安装只改当前 profile，不跑包管理器、不碰 lockfile，其他插件不受影响；卸载时全部还原。
- **数据不出本机**：档位、开关等偏好只存在本地。

---

## 卸载

```bash
dsh plugin --profile web remove github:cspyz/dsh-terse-mode
dsh plugin --profile desktop remove github:cspyz/dsh-terse-mode
```

如果是用仓库脚本装的，则跑 `node tools/install-terse-mode.mjs --uninstall`（桌面端）或加 `--profile web`（网页端）；它会先把 profile 配置备份到工作区 `.backup/<时间戳>/`。

---

## 许可

[MIT](LICENSE)
