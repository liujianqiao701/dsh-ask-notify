# dsh-ask-notify — 「需要你回答」右下角提醒

DSH Web GUI 的客户端插件。**当 agent 停下来等你作答时**（`ask_user_question`、审批、计划确认），
在页面**右下角**弹出提醒卡；如果你不在这个页面（切到了别的标签 / 别的窗口 / 别的程序），
再补一条**系统通知**并让**标签标题闪烁**。

## 安装

```sh
dsh plugin --profile web add github:liujianqiao701/dsh-ask-notify
```

装完**刷新一次页面（F5）**：新增的插件条目要由页面启动清单下发。

插件在页面里的 id 是 `ask-notify`，浏览器半区由 `/plugins/ask-notify/client.js` 提供。
本包自带 `cordis.patch.yml`，其中的 `- insert: - id: ask-notify` 就是挂载点。

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
ctx.sessions.list.getSnapshot()        → SessionSummary.pendingInteraction   （哪个会话在等、等什么）
  └─ ctx.sessions.binding(id).session.getSnapshot().pending[].payload → 问题原文
```

用的是侧边栏「琥珀色小圆点」同一份运行时状态（`@deepseek-ai/dsh-client-runtime` 的
`PendingInteraction`，kind ∈ `question` / `approval` / `plan-review`），所以页面改版、DOM 结构变化都不会让它失效。
订阅 + 2 秒轮询双保险。

## 生效与更新

1. **首次需要刷新一次页面（F5）**：新增的插件条目要由页面启动清单下发。
2. 之后改 `lib\client.js` **无需刷新**——服务端按文件 mtime/内容哈希通过 `/plugins/events`（SSE）推 `rebuilt` 帧，
   客户端 HMR 自动热换。
3. 重新安装 / 换机器：重跑上面的 `dsh plugin add` 即可（幂等）。

## 自检（不用真等一个问题）

在页面控制台执行：

```js
__dshAskNotify.selftest()                 // 右下角卡片保持 12 秒，看样式
__dshAskNotify.state()                    // 当前等待 / 偏好 / 通知权限 / 是否在页面
__dshAskNotify.collect()                  // 实时等待列表（真实状态，空数组 = 现在没人等你）
__dshAskNotify.show('approval', '试试审批样式')
__dshAskNotify.hide()
```

`selftest()` 造的卡片**背后没有真实等待**，所以它有一个 12 秒的“保活窗口”——
窗口内实时轮询不会把它清掉（否则会被真实状态的 2 秒轮询立刻抹掉）。

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

| 现象 | 处理 |
| --- | --- |
| 刷新后没有任何反应 | 控制台跑 `__dshAskNotify` → 若是 `undefined`，说明页面启动清单里没有它：确认 `dsh.profile.bundles` 里有 `dsh-ask-notify`，然后硬刷新（Ctrl+F5） |
| 卡片不弹 | `__dshAskNotify.collect()` 有内容但没卡 → 该类等待被偏好关掉了（`prefs`） |
| 系统通知不弹 | `__dshAskNotify.state().permission` 不是 `granted` → 点卡片上的 🔔，或在站点设置里允许通知 |
| 想看服务端有没有下发它 | `curl http://127.0.0.1:3080/` 搜 `dsh-ask-notify`；或直接 `curl http://127.0.0.1:3080/plugins/ask-notify/client.js` |

## 卸载

在 GUI 的 **设置 → 插件 → 插件管理**里卸载（下次启动生效）。命令行等价写法：

```sh
dsh plugin --profile web remove dsh-ask-notify
```

## 本地开发（可选）

想把源码挂进 profile 边改边调，用 `link:` 装法：

| 角色 | 说明 |
| --- | --- |
| 源码（唯一真源） | 你的克隆目录 |
| 挂进 profile | `~\.dsh\profiles\web\node_modules\dsh-ask-notify`（junction 或 `link:` 依赖） |
| 激活点 | `dsh.profile.bundles` 里含 `dsh-ask-notify` —— 由本包自带的 `cordis.patch.yml` 负责挂载 |

> ⚠️ **不要在 profile 用户层（`~\.dsh\profiles\web\cordis.patch.yml`）里再手写一条
> `- id: ask-notify` 的 insert。** 本包的 bundle patch 已经负责挂载，两处都有会导致**同一个 id 挂载两次**。
> 用 bundle 那一份就够，它是热重载的，改完即时生效。

## 文件清单

```
dsh-ask-notify\
├── package.json          声明 dsh.bundle.patch 与 dsh.client.platform=web
├── cordis.patch.yml      挂载条目（- insert: - id: ask-notify）
├── lib\index.js          host 侧空实现（本插件纯浏览器侧）
├── lib\client.js         全部逻辑：检测 / 卡片 / 系统通知 / 标题闪烁 / 声音 / 自检
├── screenshots.json      市场截图清单
└── assets\               市场截图
```

## 许可

MIT
