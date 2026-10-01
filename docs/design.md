# dsh-terse-mode 设计说明

日期：2026-10-01
状态：已获用户批准（方案一：自研插件，四档可调，默认标准）
目标 profile：`desktop`（`$DSH_HOME/profiles/desktop`）

## 1. 要解决的问题

用户原话：「限制 deepseek api 乱想、联网搜索、话多。比如我简单问个问题它就要思考很久。」

拆成三件事：

| 症状 | 观察到的原因 |
|---|---|
| 简单问题也思考很久 | profile 自己的 patch 把 `agent-default-model.reasoningEffort` 设成 `high`；UI 模型菜单还可能把强度改得更高 |
| 动不动就联网搜 | `@deepseek-ai/dsh-tool-web` 的 `web_search` / `web_fetch` 由 agent preset 挂在每个会话里，没有默认策略 |
| 回复啰嗦 | 系统里没有任何「啰嗦度」开关，只能靠提示词与输出上限 |

## 2. 结论性的技术前提（读 app.asar 内源码得到）

- `agent/request` 是 Cordis **waterfall**，签名
  `(payload: {agent, turn, step, signal}, next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>`；
  返回值是 `LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`，**没有工具字段**。
  监听器按「最外层先跑、最后 resume 的赢」unwind，UI 的 `installModelSelection` 会在 `await next()` 之后无条件写回用户选的强度，
  因此本插件必须用 `{ prepend: true }` 坐在最外层，才能让压强度生效。
- 工具由注册表装配，不从 `LlmCallConfig` 来。要「让模型看不到」用 `ctx.tools.restrict({deny})`（**必须在 agent 作用域**，否则抛错），
  要「保证一定搜不了」用全局 `ctx.tools.guard(fn)`（同步、fail-closed、可被 effect 释放）。工具名确认为 `web_search`、`web_fetch`。
- 提示词用 `ctx.systemPrompt.section({name, order, text, interpolate})`；内置段最大 order 是 `DEPLOYMENT_PERSONA_SUFFIX = 10200`，
  所以插件段用 `order: 20000` 稳定排在最后。同层同名重复注册会抛错，插件卸载/重载由 effect 释放，不会残留。
- 插件 `Config` 必须是 **Standard Schema**（`{'~standard': {validate}}`，同步）。校验失败会抛 `ValidationError` 让该 entry 启动失败；
  本机曾因插件启动失败触发过 Desktop 安全模式（把 profile 的 bundles 砍回 in-box，见 `repair-dsh-plugins.mjs`）。
  因此本插件的 schema **永不报错**：非法值一律回落到安全默认，并在日志里警告。
- `agent/created` 是 **serial** 且会 await 的：其中任何监听器抛错都会**让 agent 创建失败**，所以里面的逻辑必须整体 try/catch。

## 3. 方案

一个 host-only bundle（无 UI、零运行时依赖、纯 JS）：

```
terse-mode/
  package.json        dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml    insert: [{ id: terse-mode, name: dsh-terse-mode, config: { level: standard } }]
  index.js            插件入口：apply(ctx, config)
  lib/logic.js        纯函数：档位解析、请求钳制（可单测）
  locale/{zh,en}.json 插件卡片标题/描述
  test/logic.test.mjs node --test 单测
```

### 档位

| level | reasoningEffort | maxTokens | 搜索 | 指令 |
|---|---|---|---|---|
| `off` | 不动 | 不限 | 允许 | 不加 |
| `light` | `low` | 不限 | 允许 | 轻量（简短、别过度搜） |
| `standard`（默认） | `low` | 不限 | 禁止 | 标准（含「搜索已关闭」句） |
| `strong` | `off` | 不限 | 禁止 | 最严（回答尽量 120 字内） |

**四个档位都不设输出上限**（第二轮按用户要求改）：回答长度只由指令引导，`maxTokens` 不再出现在任何档位默认里；
字段本身保留 —— 显式写正整数才会给请求加上限，且永远只在已有值上取更小者。profile patch 行里显式写了 `maxTokens: -1`，
所以即使跑着旧版模块，当前部署也是不限输出（实测 `effective.maxTokens = null`）。

细项可覆盖档位：`reasoningEffort: auto|none|off|low|high|max`、`maxTokens: 0(跟随档位)|-1(不限)|正整数`、
`search: auto|allow|deny`、`instruction: auto|none|自定义文本`、`applyToAllModels: false`。

### 三个动作

1. **压思考**：`agent/request` 监听（`prepend: true`），`await next()` 后把 `reasoningEffort` 往下压。
   两条路径，按能力是否已知分流：
   - **能力已知**（`ctx.llm.resolveModelInfo(provider, model)` 给出了该路由公布的 effort 列表，按 provider|model 缓存一次）：
     取「不超过目标档位里最接近的那个」——所以在 profile 没有显式写 effort、适配器默认 `high` 会在本瀑布**之后**才生效的情况下，
     插件仍然能把它钉成 `low`/`off`。这是本插件真正生效的关键路径。
   - **能力未知**（查询失败 / 无 llm 服务 / 模型不公布 reasoning）：只压「请求里已经带着的」effort，且只认 `off<low<high<max`。
   两条路径都保证：只降不升；绝不指定模型未公布的 effort（否则 `prepareCall` 会以 `UNSUPPORTED_REASONING_EFFORT` 结束整轮）。
   默认只对 provider 匹配 `^deepseek` 的路由生效（`applyToAllModels: true` 放开）。
2. **限搜索**：
   - `ctx.tools.guard()`：读实时策略，命中 `web_search`/`web_fetch` 就拒绝（工具调用不执行、不结束轮次）。对**所有**会话立即生效。
   - `agent.ctx.tools.restrict({deny})`：让模型根本看不到这两个工具（省 schema token、省一轮试探）。两个来源都覆盖：
     `agent/created`（新会话）与插件 apply 时的 `ctx.agents.list()` 扫描（**已经开着的会话**，实测有效）。
     该 restriction 由插件 effect 拥有，卸载/改档位时自动撤销；多个名字里有一个不存在时逐个名字重试，不会因一个未知工具名丢掉另一个。
3. **减废话**：`ctx.systemPrompt.section()` 注入指令（`order: 20000`，`interpolate: false`）。**不设输出上限**（第二轮改）；
   `maxTokens` 仅在显式配置正整数时才生效，且取 `Math.min(现状, 配置值)`。

### 两个必须踩对的细节

- **`{ prepend: true }` 不是可选优化**：UI 的 `installModelSelection` 在 `await next()` 之后无条件写回用户选的强度，
  只有注册成最外层的监听器，返回值才是最终的。
- **Config 会经过两次归一**：Loader 先用 `Config` 校验（本插件在 `validate()` 里归一），然后把校验结果交给 `apply()`，
  `apply()` 再归一一次。所以 `normalizeConfig` 必须幂等（内部标记 + 搜索句去重），否则派生文本会被追加两遍——
  第一次装到 desktop 时系统提示词里那句「Web search ... turned off」就真的出现了两次，这是实测发现的缺陷。

### 可调

- 改 `cordis.patch.yml` 里那一行的 `config`，或 patch 层覆盖该行 → Cordis 生命周期重载（若本机 patch 不热载则重启 app 一次）。
- 档位也只影响行为，不写任何 profile 状态；卸载 = 从 `dsh.profile.bundles` 与依赖里移除。

## 4. 失败模式与对策

| 风险 | 对策 |
|---|---|
| Config 里有拼写错误 → 插件启动失败 → 可能触发安全模式 | schema 永不报错，全部回落默认 + 日志警告 |
| `tools.restrict` 抛「unknown tool」 | 单独 try/catch；拿不到就只靠 guard 兜底，绝不让异常冒出 `agent/created` |
| 强迫不支持思考的模型用 `low` → 整轮报错 | 原本无 effort 就不碰；只降不升；默认只对 deepseek 路由生效 |
| `maxTokens` 截断长代码/长文件 | 默认 4096，可在 Config 关掉（`maxTokens: -1`）；文档写明 |
| 已有的老会话拿不到「隐藏工具」 | guard 保证行为一致（工具调不动），隐藏只对新会话生效 |
| 插件文件坏掉导致启动失败 | 插件是纯 JS、零依赖；坏了就 `uninstall` 移除 bundles 条目 |

## 5. 验证（已执行，含实测证据）

1. **纯逻辑单测** `node --test test/logic.test.mjs`：档位解析、只降不升、能力未知时不猜、provider 门禁、maxTokens 取小、幂等。
2. **接线单测** `node --test test/plugin.test.mjs`：用一个仿 Cordis 的假 context 跑真实 `apply()`——section 顺序/内容、
   `prepend` 抢在外层（模拟 UI 模型菜单改写）、guard 判定、restrict 与释放、`agent/created` 抛错不冒泡、restrict 未知名字的降级、幂等。共 48 项全绿。
3. **装载前自检** `node tools/preflight-terse-mode.mjs`：清单/补丁/模块导出/Config 同步校验/`apply()` 在裸 context 上不抛错。
4. **真实装载前的 compose 与启动验证**（用一次性 scratch profile，验证后已删除）：
   - `dsh --profile scratch-terse --dump-config` → 组合树里出现 `- id: terse-mode / name: dsh-terse-mode / config: { level: standard }`，exit 0。
   - `dsh --profile scratch-head "只回答一个数字：1+1=?"` → 真的启动并答出 `2`（exit 0）。这条最关键：
     DSH 的启动是 all-or-nothing，插件若能加载失败，整个进程起不来。会话日志里该轮的
     `request/header` 实测为 `reasoningEffort: low`、`maxTokens: 4096`——该 profile 没有显式 effort，
     说明「能力查询 + 钉 effort」这条路径真的生效了。
5. **desktop 上的端到端实测**（用户真实会话 `session-0fbaf213` 的日志，同一个 agent）：
   | | 装插件前 | 装插件后 |
   |---|---|---|
   | reasoningEffort | `high` | `low` |
   | maxTokens | `256000` | `4096` |
   | 工具表 | 含 `web_search`、`web_fetch` | 两者都不再出现 |
   `/dsh-market/installed` 报 `dsh-terse-mode: state=live, bundle=true, hot=true`，`findings: []`。
6. **回滚**：`node tools/install-terse-mode.mjs --uninstall`（profile 清单原样备份在 `.backup/`）。

### 已知诊断噪音（不影响行为）

本插件的 `Config` 是零依赖的手写 Standard Schema（因为 `link:` 安装的插件**无法**解析 `@deepseek-ai/*`，
而 schemastery 会在配置写错时抛 `ValidationError` 让 entry 启动失败）。代价是诊断命令
`dsh --profile <p> --dump-config-schema` 会对本行输出一条 `Config is not a native Schemastery schema`。
该命令本身在该 profile 上本来就有别的报错（exit 1），且不参与启动；启动与运行不受影响。

## 6. 明确不做（YAGNI）

- 不做设置页/侧边栏页面：用户选了「对话页常驻小控件」，设置页的 slot、导航图标与本地化面板都是多余工序。
- 不做「按问题难度自适应」（用户没选，且判断错会误伤复杂任务）。
- 不做单会话开关（全局生效，`off` 档就是总开关）。
- 不做权限/多用户隔离：路由只监听回环，与插件市场同一条通道，没有额外认证。
- 不改用户 profile 里 `agent-default-model` 的写法（会被 UI 模型菜单覆盖，且属于用户自己的 patch 层）。

## 7. 可视化面板（第二轮，用户追加需求）

需求：**对话页上的常驻小控件**，能直接改档位。

### 架构

```
浏览器                                   宿主
┌───────────────────────────┐            ┌───────────────────────────────┐
│ client.js                 │  fetch     │ index.js                      │
│  conversation.session.     │ ─────────► │  lib/level-api.js             │
│  header.actions            │  GET/POST  │   ctx.webServer.register(...)  │
│  [关][轻][标准][强] (?)     │ ◄───────── │  runtime.policy（可运行时替换）  │
└───────────────────────────┘            │  lib/store.js → level.json     │
                                          └───────────────────────────────┘
```

- **通道**：`ctx.webServer.register({kind:'exact', path:'/dsh-terse-mode/api/state', handler})`，
  与插件市场的 `/dsh-market/*` 同一条 lane。之所以不用 typert remote：`link:` 安装的插件解析不到 `@deepseek-ai/*`，写不了 `@Remote`。
- **客户端**：`window.__ModuleLoader__.load({id:'dsh-terse-mode', factory})`，
  `ctx.slots.inject('conversation.session.header.actions', ...)`——对话页**顶部那一行**（「智能体团队 / 标准模式 / 费用明细」所在的 list slot，
  在 `@deepseek-ai/dsh-client-ui-conversation` 里定义为 `kind: "list", scope: "session"`）。第一版按官方模板挂在输入框下方的
  `conversation.composer.dock`，用户看了截图后要求挪到顶部：两者都是 list slot，只换注册名。不 import 任何 DSH 包，样式只用 `--dsw-alias-*` 令牌 + 内联样式。
- **说明与设置**：四个档位各自带 hover 说明（`title`），另有 `?` 弹层收纳「每一档在做什么 / 当前实际生效 / 改在哪里」。
  弹层用 `position: fixed` + 按钮的 `getBoundingClientRect()` 定位：顶部那一行不归插件管，绝对定位的盒子可能被父级裁掉。
- **运行时策略**：`runtime.policy` 可被 `setLevel()` 替换；guard / agent/request / 提示词段 / 工具可见性全部读实时值，
  所以切换立即对所有会话生效（提示词段与 restrict 由 `syncInstruction()` / `syncRestrictions()` 重建）。
- **持久化**：`$DSH_HOME/storages/dsh-terse-mode/level.json`（`ctx.get('dshHomePath')` 优先）。
  优先级：面板选择 > patch 的 `level`；删文件即回到 patch。刻意不写 profile patch：那会与配置编辑器抢同一个文件、还会丢注释。

### API

| 方法 | 路径 | 结果 |
|---|---|---|
| GET | `/dsh-terse-mode/api/state` | `{ level, levels, reasoningChoice, reasoningChoices, effective:{reasoningEffort,reasoningMode,maxTokens,search,instruction}, summary, persistedAt }` |
| POST | `/dsh-terse-mode/api/state` | body `{ level? , reasoningEffort? }`（至少一个）→ 同上；非法值 400 + `{ error }`；其他方法 405 |
| 其他 | 任何异常 | 500 + `{ error }`（绝不空响应） |

### 思考强度直调（第三轮，用户追加需求）

- `reasoningMode` 区分语义：**档位给的强度是上限（`cap`，只降不升）；面板选的强度是决定（`exact`，按值设、可以升）**。
  判据是「这个 effort 是不是用户显式写的」：`normalizeConfig` 见到显式的 `reasoningEffort` 就标 `exact`，档位默认则是 `cap`。
- `exact` 只在模型公布该强度时才设；未公布就保持原样（绝不制造 `UNSUPPORTED_REASONING_EFFORT`）。
- 点档位会把显式强度清成 `auto`（`update({level, reasoningEffort:'auto'})`），所以「先档位、后强度」才是固定组合。
- 存储扩为 `{ level, reasoningEffort }`（`auto` 表示跟随档位）；`withRemembered()` 负责把面板选择叠加到 patch 作者配置上
  （`auto` 要**删除**作者写的 effort，不是 spread 覆盖，所以单独写了一个函数）。

### 验证

- `test/level-api.test.mjs`：GET/POST 行为（含 `reasoningEffort`、`subagents` 单独设、多字段同设、非法值、坏 body、405、异常转 500）、
  store 往返（含 effort 与 subagents）、路由**只在同一台服务器上注册一次且永不释放**（重载不重复注册、卸载后 503）、
  **走 Loader 路径的 POST 让整档生效**、**显式强度会 raise 且点档位重置为 auto**、重启后记得档位/强度/子代理、无存储时用 patch 档位。
- `test/logic.test.mjs` / `test/plugin.test.mjs`：`cap` vs `exact` 两种语义、`deniedTools()` 的组合（search × subagents）、
  子代理禁用时 guard 拒绝四个创建工具且 light 档仍允许搜索、restrict 名单正确。全套 73 项测试通过。
- `preflight` 16 项：`dsh.client` 清单、`client.js` 可解析、factory id/slot/路由路径一致、client 不 import `@deepseek-ai/*`、
  每档说明与设置文案齐全、面板能设思考强度、面板与设置页都能切子代理、客户端注册 `settings.section`。preflight 用临时
  `$DSH_HOME` 隔离（否则 bare-ctx 检查会读到用户当前档位 —— 这个坑已经踩过一次）。
- 第五轮后：74 项测试通过（新增「模拟宿主回收路由后必须重新注册」）。

## 9. 路由与面板取数：两个只能靠实测得到的结论（第五轮）

### 9.1 路由随「注册它的 fiber」回收，缓存「已注册」会导致永久 404

现象：插件明明挂载并在生效（会话工具面里 `web_search` 已被藏掉、market 报 `live`），但 `/dsh-terse-mode/api/state` **404**。
链路：内置插件都按 `webCtx.effect(() => webCtx.webServer.register(route), …)` 注册，**路由生命周期跟着那条 fiber**；
插件重载时旧 fiber 被卸载 → 路由被释放，而新一代 apply 常常在旧 fiber 释放**之前**跑完 → 重复注册抛 `duplicate (kind, path)`。
第一版修法（注册表挂在 `webServer` 对象上、注册过就不再注册）把问题变成**永久** 404：路由已被释放，缓存却说它在 → 再没人注册。

最终设计（`lib/level-api.js`）：
- **共享 holder** 挂在 server 对象上：当前与历史 handler 都通过它取 controller；卸载只摘掉 controller → 同一条路由回 **503**（不是 404）；
- **每一代都重新注册**，撞车按 `0/250/1000/3000ms` 退避重试：释放已完成时第一次重试即成功；仍是自家那条路由时它照常服务，重试耗尽只记一条 info；
- 回归测试两条：重载不产生第二条路由；**把 routes 清空（模拟宿主回收）后新一代必须重新注册并服务自己的策略**。

实测：桌面端连续两次 `--uninstall/--install` 重载后仍 200；web profile 同样。

**补充（第六轮实测）**：`--uninstall/--install` 这种「patch 内容变化」只会**重新 apply 缓存里的旧模块**，不会重新 import 文件
（证据：本轮新加的 `plugin.log` 镜像在重载后依然不存在，而路由被旧模块的行 fiber 释放 → 404）。所以**宿主侧代码改动只有重启 DSH 才生效**，
这也正是「路由被行 fiber 带走」在现场反复出现的原因。因此注册改为挂在 **root 作用域**（`ctx.root.effect(() => webServer.register(...))`）：
行重载不再释放路由，最新一代只把 holder 指向自己的 controller；root 释放（进程结束）时才最终摘掉它。
`test/level-api.test.mjs` 的假上下文因此区分 `effects`（行）与 `rootEffects`（root），并断言「释放行效果后路由仍在、释放 root 后才消失」。

### 9.2 面板必须用「页面自己的 origin」，不能用注入 base 推出的绝对地址

桌面窗口是 `dsh-app://app/`（`registerSchemesAsPrivileged` 给了 `supportFetchAPI/corsEnabled: true`，外壳的
`protocol.handle` 会把非静态路径**带会话 cookie 转发**给宿主）。但页面注入的 `<base>` 指向宿主 http origin，
于是从 base 推出的 `/dsh-terse-mode/api/state` 变成**跨源**请求：宿主不加 CORS 头 → 三个候选全部 `Failed to fetch`。
`apiCandidates()` 顺序因此改成：**页面 origin** → `document.baseURI` 相对 → transport origin 绝对 → 裸路径；成功的那条会被记住。
失败时面板显示 `origin=… base=…` 与每条候选的原始报错（此前的 `direction: rtl` 截断正好把最有用的头部藏掉了）。

## 7.5 第四轮：禁用子代理 + 设置页 + 网页端（用户追加）

- **子代理开关**：`subagents: allow | deny`（默认 allow，可用 true/false 书写），与档位独立、改档位不重置它。
  禁用时统一由 `deniedTools(policy)` 产出名单（search 的 `web_search/web_fetch` + 子代理的 `subagent/subagent_fork/spawn_teammate/workflow`），
  guard 与 `tools.restrict` 共用同一个名单，因此「模型看得见什么」与「运行期拦什么」永不打架。名单可用 `subagentTools` 覆盖。
  团队记账工具不禁：没有创建入口它们本身做不了事。
- **设置页**：客户端在 `settings.section` 槽注册 id `terse-mode`（`order: 40`、`label: () => t('nav')`、`locale: NS`），
  与顶部控件**共用同一份 store**（`useStore()`：一次 fetch、一个退避重试环、一个 busy 标志、跨视图订阅），所以两边改哪边都立刻同步。
- **网页端**：桌面端与网页端是两个 profile（`dsh web` 用 `profiles/web`），插件按 profile 安装；
  `install-terse-mode.mjs --profile web` 会写 link 依赖 + junction + profile patch 行，**不再写** `dsh.profile.bundles`
  （bundle 层会再插一行 → 插件挂两次；desktop 宿主本来就会重写该字段）。网页 profile 的 `patchReload: live` 让新行**热挂载**，
  实测 `http://127.0.0.1:3080/dsh-terse-mode/api/state` 直接 200。
- **桌面 host 的旧模块**：网页宿主是全新挂载，拿到的是最新代码；桌面宿主已 import 过旧一代，`subagents` 字段要重启 DSH 才认。

### 验证

- `test/level-api.test.mjs`：GET/POST 行为（含 `reasoningEffort` 单独设、两字段同设、非法值、坏 body、405、异常转 500）、
  store 往返（含 effort）、路由只注册一条、**走 Loader 路径的 POST 让整档生效**、**显式强度会 raise 且点档位重置为 auto**、
  重启后记得档位与强度、无存储时用 patch 档位。全套 68 项测试通过。
- `preflight` 14 项：`dsh.client` 清单、`client.js` 可解析、factory id/slot/路由路径一致、client 不 import `@deepseek-ai/*`、
  每档说明与设置文案齐全、面板能设思考强度且宿主接受该字段。

## 8. 实测发现的两处硬约束（都会被下一轮踩到）

### 8.1 desktop profile 的 `dsh.profile.bundles` 会被宿主重写

- 现象：12:01:39 我写入 desktop 清单（依赖 + bundles 条目），12:29:22 宿主重写了 `package.json`，`dsh-terse-mode` 从
  `dsh.profile.bundles` 消失、依赖条目留下，market 随后报 `state: disabled`，下次启动插件不再挂载；market 日志与
  `.plugin-manager/logs/*` 里没有任何对应操作。
- 对策：改走 **profile 自己的 `cordis.patch.yml`** —— 插入一行带标记的 `insert`（`id: terse-mode-profile`，
  `name: dsh-terse-mode` 由 profile 的 `node_modules` junction 解析），并用 `>>>`/`<<<` 注释标记便于精确替换与回滚。
- 实测：插入后**无需重启**即挂载（`GET /dsh-terse-mode/api/state` 从 404 变 200，market 报 `state: live, hot: true`）——
  profile patch 是被监听的，而该模块在本进程里从未被导入过，所以是全新加载。
- 行 id 故意与 bundle patch 里的 `terse-mode` 不同，避免两层同时 insert 同名 id（那属于重复插入，可能阻断启动）；即使两层都存在，
  插件也只是被挂载两次，而它所有注册都是幂等/可降级的（section 重名会抛、被 catch；路由重名会抛、被 catch）。

### 8.2 改宿主模块代码必须重启，重挂载也不行

- 现象：修好「切档位只改名字、不改行为」的缺陷后，把 profile patch 那一行删掉再插回来（等于重新挂载一次），
  再 POST 三个档位，`effective` 三组值完全一致 → 内存里仍是旧模块。
- 结论：`dsh-hmr` 在这个部署里不会让行重挂载时重新 import 模块文件；改 `index.js`/`lib/**` 只能靠重启一次 DSH。
  改配置、点档位不受影响（那是运行时改策略）。

### 8.3 由「实测」抓到的缺陷：切档位只改名字

- 根因：`normalizeConfig` 会把默认值全部物化，而 Loader 先把校验结果交给 `apply()`，`apply()` 再取
  「用户写的字段」去重新归一 —— 旧实现取到的是**已物化的策略**，于是 `{...raw, level:'light'}` 仍带着 standard 的
  `maxTokens: 4096`、`search: 'deny'`，切档位只换了名字。
- 修复：`normalizeConfig` 额外记录 `authored`（用户真正写过的字段），`rawOf()` 优先读它；`setLevel()` 只在该子集上改 level。
- 回归测试：`rawOf(normalizeConfig(...))` 只保留用户字段；以及走 Loader 路径（先 `Config['~standard'].validate` 再 `apply`）
  的 POST 断言四档 `effective` 全对。
