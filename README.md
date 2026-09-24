# dsh-ask-notify — 「需要你回答」右下角提醒

DSH Web GUI 的客户端插件。**当 agent 停下来等你作答时**（`ask_user_question`、审批、计划确认），
在页面**右下角**弹出提醒卡；如果你不在这个页面（切到了别的标签 / 别的窗口 / 别的程序），
再补一条**系统通知**并让**标签标题闪烁**。

## 安装

### 首选：插件市场（不敲命令，同事都用这条）

DSH 界面里 **设置 → 插件市场 → 搜 `dsh-ask-notify` → 安装**。

装完看市场卡片上的状态词，它直接告诉你还差什么：

| 卡片状态 | 还要做什么 |
| --- | --- |
| **已生效** | 只差**刷新页面**：`F5`，不行再 `Ctrl+F5` |
| **已安装，重启后生效** | **重启 `dsh web`**，然后 `Ctrl+F5` |
| 已安装，未生效 / 已停用 | 点卡片上的「为什么未生效？」看原因 —— 最常见是「有 agent 正在运行」，停掉再装一次 |

> ⚠️ **刷新这一步不能省**：插件条目是随**页面启动清单**（`window.__DSH_BOOT__`）下发的，
> 页面不重新加载，它就永远不知道有这个插件 —— 服务端再正常也没用。
> **"装了没效果"绝大多数就是这一条**（这时市场卡片写的通常是「已生效」）。

### 备选：命令行 / 本包 `install.ps1`

```sh
dsh plugin --profile web add github:liujianqiao701/dsh-ask-notify
```

这条路**必须重启 `dsh web`**：登记写的是 bundle 层，而 **bundle 层只在启动时读一次**。
（`install.ps1` 是同样的机制，走 junction + `link:` 依赖，也要重启。）

### 名字与路由（别用错）

- 加载器里的**行 id** 是 `ask-notify`（本包 `cordis.patch.yml` 里的 `- insert: - id: ask-notify`）；
- **但浏览器半区的路由用的是「包名」**：`/plugins/dsh-ask-notify/client.js` 对，
  `/plugins/ask-notify/client.js`（行 id）是 404。
- ⚠️ **别手敲这个 URL 来判活**：新代 harness 把路由键改成了
  `/plugins/<包名>/client.js?rev=<rev>`，**rev 是查表键的一部分 —— 不带 rev 手敲就是 404**，
  哪怕服务端一切正常。判活请用 `Ctrl+U` 搜 boot payload，或控制台 `__dshAskNotify.sources()`。

### 环境要求

- Windows + `dsh web`。
- **任何 harness 版本都能用（1.0.4 起）**。等待态"住哪"换过两次，插件按名字读三个源，优先级从新到旧：
  - `0.1.7`+ → `uiSession.sessionStatus`；
  - `0.1.2 ~ 0.1.6` → `uiSession.pendingInteractions`（实测 `0.1.5-rc.3` 属这一代）；
  - `≤ 0.1.1-rc.x` → 会话列表行上的 `pendingInteraction`。
  **再换名字也不用改插件**：三个源都读不到时，插件会**扫描 `uiSession` / `sessions` 上所有 map 型成员**，
  谁真的装着等待就自动认它 —— `sources().discovered` 会列出探测到的名字。这是"以后不必再改插件重传"的保证。
  还能**逐会话回落**：某个会话在高优先级源里没值，就自动去下一个源找。
- **不再有任何"必须先存在"的依赖（1.0.4 起）**：cordis 的 `exports.inject` 已清空（原为 `["sessions"]`），
  package.json 的 `dsh.client.inject` 也是空的。服务缺失时插件照样挂载、照样能被 `selftest()` 证明活着；
  15 秒仍读不到任何数据就**控制台报警 + 右下角弹一张提示卡**（数据源恢复后自动撤掉）—— 不会"静默不生效"。
- 1.0.1 的 `dsh.client.inject` 里钉着 `@deepseek-ai/dsh-client-runtime`（新代 harness 已没有这个包）。
  实测它**不会挡住挂载** —— 加载器对"图里不存在的依赖"是**静默跳过**的；但它本来就是指向
  一个已不发布包的死引用，1.0.2 起已清空。
- 挂载面跨版本稳定：`dsh-client-modules` 从最早 `0.0.1-rc.1` 到最新 `0.1.7-rc.1` 都要求
  `dsh.client.platform`（字符串）+ `exports["./client"]`，本包两个都有。
- 想确认自己在哪一代：跑 `_verify\diag\check-ask-notify.cmd`（E 段打印 harness 版本 +
  `dsh-client-ui-session present` / `dsh-client-runtime present`），
  或在页面控制台看 `__dshAskNotify.sources()`。

## 为什么需要它

内置的问题卡片会**接管输入框**——只有你**正看着这个页面**才知道 agent 停了。
你切去别的标签干别的活时，agent 就一直卡在等待里，而页面上没有任何东西能“喊”你。
本插件把“等你回答”这件事从页面里**主动推**出来。

## 三个提醒通道

| 通道 | 出现条件 | 解决什么 |
| --- | --- | --- |
| **右下角提醒卡** | 只要有等待（不管你在不在页面） | 你回到页面时一眼看见还剩什么问题 |
| **系统通知**（Windows 右下角气泡） | 页面**不可见或未聚焦** + 已授权通知 | 你在别的标签/程序时也能被喊到 |
| **标题闪烁**（`❓ DeepSeek Harness`） | 页面**不可见** | 在标签栏上一眼看出“有个标签在等我” |

卡片上的按钮：`去回答`（自动切到那个会话并把输入区滚到眼前）、`稍后提醒`（本次不再弹，下一条等待还会弹）、
`桌面提醒 开/关`、`声音 开/关`。

## 数据来源（不是 DOM 抓取）

```
旧代 ≤0.1.1-rc.x ：ctx.sessions.list.getSnapshot().byId[id].pendingInteraction       （字符串）
中代 0.1.2-0.1.6 ：ctx.get("uiSession").pendingInteractions.getSnapshot().get(id)    （{key,kind,sessionId}）
新代 0.1.7+      ：ctx.get("uiSession").sessionStatus.getSnapshot().get(id).pendingInteraction
  └─ ctx.sessions.binding(id).session.getSnapshot().pending[].payload → 问题原文
```

用的就是侧边栏「琥珀色小圆点」同一份运行时状态（kind ∈ `question` / `approval` / `plan-review`，新代是开放字符串），
所以页面改版、DOM 结构变化都不会让它失效。1.0.4 起**所有 harness 版本的数据源都读**：
新代读 `uiSession.sessionStatus`，中代读 `uiSession.pendingInteractions`，旧代读会话列表行上的
`pendingInteraction` —— 从新到旧依次取，某个会话在上一源没值就落到下一源；此外还会**自动探测**没见过的
map 型成员（`sources().discovered` 列出探测结果），所以下次 harness 再改名字，用户手里这一份自己就能认。
`sources().used` 报的是**真正给出数据的那一个源**（不是"第一个存在"的源）；一个都读不到就报警 + 弹提示卡。
订阅 + 2 秒轮询双保险。

## 生效与更新

**"要不要重启"取决于激活点写在哪一层，不是凭经验**：

| 你动的是什么 | 要重启 `dsh web`？ | 要刷新页面？ |
| --- | --- | --- |
| 市场安装（卡片显示「已生效」） | 否 —— 市场会热挂载进正在跑的进程 | **要（必须）** |
| 市场安装（卡片显示「重启后生效」） | **要** —— 市场自己判定这次没法热挂载 | 要 |
| 命令行 / `install.ps1` 安装 | **要** —— 登记的是 bundle 层，只在启动时读 | 要 |
| 改 `lib\client.js`（客户端半区的内容） | 否 | 否 —— 服务端按内容哈希经 `/plugins/events`（SSE）推 `rebuilt`，客户端 HMR 自动热换 |
| 改本包的 `cordis.patch.yml`（**bundle 层**） | **要** —— bundle 层只在启动时读一次 | 要 |
| 改 profile 的用户层 patch（`~\.dsh\profiles\web\cordis.patch.yml`、`$DSH_HOME\cordis.patch.yml`） | 否 —— 这两个文件被监听，**热生效** | 否 |

> 容易记混的一点：**热的是"用户层 patch 文件"和"客户端半区的内容"，不是 bundle 层**。
> 本包走 bundle 层（自带 `cordis.patch.yml`），所以"改挂载条目"这类改动一律要重启。

> ⚠️ **市场点「更新」没反应？先看界面上有没有正在跑的会话。** 市场自己会拦下来，并提示：
> 「有 agent 正在运行，请等待其完成或将其取消后再更新 —— 更新会直接替换插件文件，
> 运行中的 agent 可能中途报错或新旧版本混用」。这是**市场的保护机制**（实测 `dsh-market v1.62.0`），
> 与插件无关；等那个会话跑完（或先取消）再点即可。**注意：你和 agent 对话时它就在跑，
> 这条闸门必然触发** —— 这是最容易被误判成"插件坏了"的一种情况。

## 自检（不用真等一个问题）

在页面控制台执行：

```js
__dshAskNotify.version                    // 装的到底是哪一版（当前 1.0.4）
__dshAskNotify.selftest()                 // 右下角卡片保持 12 秒，看样式
__dshAskNotify.sources()                  // 取数源体检：used / carries / discovered
__dshAskNotify.state()                    // 当前等待 / 偏好 / 通知权限 / 是否在页面
__dshAskNotify.collect()                  // 实时等待列表（真实状态，空数组 = 现在没人等你）
__dshAskNotify.show('approval', '试试审批样式')
__dshAskNotify.hide()
```

`sources()` 里有三个字段最有用：`used` = **真正在给出数据的源**；`carries` = 各源当前装着多少条；
`discovered` = 自动探测到、名字没见过的源（正常是空数组；**非空就说明 harness 又换代了，而插件已经自己认出来了**）。

`selftest()` 造的卡片**背后没有真实等待**，所以它有一个 12 秒的“保活窗口”——
窗口内实时轮询不会把它清掉（否则会被真实状态的 2 秒轮询立刻抹掉）。
提示卡（"提醒插件读不到数据"）正相反：它会一直留着，**直到数据源恢复**才自动撤掉。

不想开浏览器也能验：`node _verify\diag\selfcheck-client.cjs` —— 8 个场景全离线跑
（三代已知形状 + 一个没见过的未来形状 + 假阳性诱饵 + 服务缺失/迟到），不联网、不开浏览器。

## 偏好（localStorage）

| key | 含义 |
| --- | --- |
| `dsh-ask-notify:prefs` | `{question, approval, "plan-review", system, sound}`，布尔；`false` 即该类等待不提醒 |
| `dsh-ask-notify:autoasked` | 首次用户手势自动申请通知权限的一次性标记 |
| `dsh-ask-notify:lastshot` | 多标签去重（同一条等待 20 秒内只由一个标签弹系统通知） |

通知权限：**第一次点击/按键**时会自动申请一次（只申请一次）。被拒绝过就点卡片上的 `🔔 开启桌面提醒`，
或到地址栏左侧站点设置里允许；`http://127.0.0.1` 属安全上下文，允许即可用。

## 已知边界

- 右下角若已有鲸鱼吉祥物（`dsh-whale-mascot`），卡片会**叠在它上方**而不是压住它。
- 同一等待在多个标签页里会各显示一张卡片，但系统通知只弹一次（跨标签去重）。
- 声音用 WebAudio，浏览器未与页面交互过时会被静音策略挡掉——静默跳过，不报错。
- 问题原文从 payload 里**容错提取**（`questions[0].question` / `question` / `detail` / `title`…），
  取不到就显示「（在下方输入框或问题卡片里作答后我才能继续）」，不会因为字段改名而崩。

## 网络行为

**本插件不发起任何网络请求。** 数据全部来自宿主已经持有的会话运行时状态，
偏好只写在 `localStorage`，系统通知走浏览器的 `Notification` API。
`lib/client.js` 里没有任何 `fetch` / `XMLHttpRequest` / `WebSocket`，也没有任何 URL 常量。

## 排障

**先跑这两下，多数问题当场定位**（都在浏览器里，不用粘贴）：

1. 页面按 `Ctrl+F5`；
2. `F12` → Console，**手敲** `__dshAskNotify.selftest()` —— 右下角弹卡 12 秒 = 好了；`undefined` = 没加载。

`undefined` 时按下面往下分：

| 现象 | 含义 / 处理 |
| --- | --- |
| 跑了命令行/脚本安装，**没重启** | 必须重启 `dsh web` —— 登记在 bundle 层，只在启动时读 |
| 市场装完卡片写「已生效」，但没反应 | 只差**刷新页面**（条目随页面启动清单下发） |
| 市场卡片写「重启后生效」 | 市场判定这次热挂载没成功（入口不是简单 insert / 超时 / 加载器太旧 / 入口解析失败），重启即可 |
| 控制台 `__dshAskNotify.sources().used` = `"uiSession.status"` / `"uiSession.pending"` / `"list"`（或 `discovered` 里列出的名字） | 取数源正常；`pending: 0` 只是「当前没有等待」 |
| 控制台 `used: "none"` + 一条 `[dsh-ask-notify] 读不到等待态数据源` 警告 **+ 右下角一张提示卡** | 已知的源和自动探测都读不到 —— 把 `sources()` 的输出发给作者 |
| 想直接看服务端有没有下发 | 浏览器开 `http://127.0.0.1:3080/` → `Ctrl+U` 看源码 → `Ctrl+F` 搜 `ask-notify`（**别手敲 `/plugins/.../client.js` 判活**：新代 harness 的该路由带 `?rev=...`，手敲必 404；也别用 `curl`：前置鉴权插件会让脚本请求 401/404，浏览器带 cookie 才是通的） |
| 卡片不弹，但 `__dshAskNotify.collect()` 有内容 | 该类等待被偏好关掉了（卡片上的开关，存在 `localStorage`） |
| 系统通知不弹 | `__dshAskNotify.state().permission` 不是 `granted` → 点卡片上的 🔔，或在站点设置里允许；用局域网 IP 打开时浏览器会禁用通知 |
| 页面完全没反应且 `collect()` 是空数组 | 不是"没装上"：本插件只在**真有等待**时才有东西显示。用 `selftest()` 自证，别靠肉眼 |

**最省事的一刀 —— 市场自己的日志**（`%USERPROFILE%\.dsh\profiles\web\.dsh-market\log.ndjson`）：

| 日志里出现 | 结论 |
| --- | --- |
| `install ... hot=true` + `hot-mount ... live` | 服务端已热挂载，**只差 F5** |
| `install ... hot=false` | **必须重启** `dsh web` |
| 完全没有 `install` 行 | 压根没装成（多半是「有 agent 正在运行」409，或构建脚本被 pnpm 拦） |
| `hot-mount failed` / `restart required` | 市场写明了回退原因，照它做 |

本仓库 `_verify\diag\check-ask-notify.cmd`（只读，双击即可）会自动把这些查一遍并出报告文件。

## 卸载

在 GUI 里 **设置 → 插件管理** 卸载（下次启动生效）。命令行等价写法：

```sh
dsh plugin --profile web remove dsh-ask-notify
```

用本仓库脚本装的，跑 `uninstall.ps1`（会撤掉 junction、`link:` 依赖、遗留的用户层 insert，
以及 `dsh.profile.bundles` 里的条目）。

> ⚠️ **无论怎么卸，都要把 `dsh.profile.bundles` 里那条 `"dsh-ask-notify"` 一起撤掉。**
> 启动时会解析清单里的**每一个**条目，解析不到就直接拒绝启动：
> `cannot resolve profile bundle "dsh-ask-notify" ...`。
> 只删 `node_modules` 里的目录（或只删依赖行）而留着清单条目，等于把"插件没生效"升级成"DSH 起不来"。

## 本地开发（可选）

想把源码挂进 profile 边改边调，用 `link:` 装法：

| 角色 | 说明 |
| --- | --- |
| 源码（唯一真源） | 你的克隆目录 |
| 挂进 profile | `~\.dsh\profiles\web\node_modules\dsh-ask-notify`（junction 或 `link:` 依赖） |
| 激活点 | `dsh.profile.bundles` 里含 `dsh-ask-notify` —— 由本包自带的 `cordis.patch.yml` 负责挂载 |

> ⚠️ **不要在 profile 用户层（`~\.dsh\profiles\web\cordis.patch.yml`）里再手写一条
> `- id: ask-notify` 的 insert。** 本包的 bundle patch 已经负责挂载，两处都有会导致**同一个 id 挂载两次**，
> `dsh web` 会直接起不来并报 `duplicate loader entry id: ask-notify`。
>
> 另外**记清哪一层是热的**：用户层 patch 文件（profile 的 `cordis.patch.yml`）**热生效**，
> 而本包所在的 **bundle 层只在启动时读** —— 改本包的 `cordis.patch.yml` 必须重启，改源码 `lib\client.js` 不用。

## 文件清单

```
dsh-ask-notify\
├── package.json          声明 dsh.bundle.patch 与 dsh.client.platform=web
├── cordis.patch.yml      bundle 层挂载条目（- insert: - id: ask-notify）
├── lib\index.js          host 侧空实现（本插件纯浏览器侧）
├── lib\client.js         全部逻辑：检测 / 卡片 / 系统通知 / 标题闪烁 / 声音 / 自检
├── install.ps1           备选装法：junction + link: 依赖 + bundle 层登记（装完要重启）
├── uninstall.ps1         反向撤掉上面那几处登记
├── 安装说明.md            给接收方的分步说明（市场 / 脚本两条路）
├── screenshots.json      市场截图清单
├── assets\               市场截图
└── _verify\diag\         只读诊断：check-ask-notify.cmd（体检）/ 重启并验证.cmd（停→起→验证）
```

## 作者 / Author

**liujianqiao701** — https://github.com/liujianqiao701

问题反馈、建议或想法请开 Issue：
https://github.com/liujianqiao701/dsh-ask-notify/issues

## 许可 / License

MIT — 见 [LICENSE](LICENSE)
