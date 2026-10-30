# 改动说明（相对上游 ikashana/dsh-notify v0.1.0）

上游只有宿主半边，所有开关都写在 profile 的 `cordis.patch.yml` 里，改一次要重启 DSH。
这份改动补了浏览器半边和一层运行时覆盖层，让常用开关能在设置页里改、改完就生效。

上游更新时，先看这份清单再决定怎么合并。

## 新增

| 文件 | 作用 |
|---|---|
| `lib/runtime-config.js` | 运行时配置覆盖层：设置页写 `$DSH_HOME/dsh-notify/ui-config.json`，`apply` 算出的静态配置外面包一层 Proxy，每次读 `cfg.x.y` 现取合并值 → 不用重启 DSH |
| `lib/settings-api.js` | 宿主侧接口 `/api/dsh-notify/*`（config / reset / test / status / sessions），经 `ctx.inject(['webServer'])` 挂载，headless 自动跳过；test 和 status 会探本机 HTTP 通道的 `/health`，死掉的本地中转能一眼看出来 |
| `lib/client.js` | 浏览器半端：设置 →「14. 任务通知」一页，走 `settings.section` 插槽 |
| `lib/supervisor.js` | 网关看护：本机常驻的弹窗进程掉了就按配置的 `http.supervisor.commands` 拉起来；`superviseStep` 是纯函数，冷却/loopback/命令白名单都在里面 |

## 修改

- `lib/templates.js`（2026-10-30）
  - `render` 新增条件段 `{{#key}}…{{/key}}`：字段为空（缺失 / `null` / 空串）时整段不输出，
    有值才渲染内文（内文里变量照常替换，条件段可嵌套）；数字 `0` 算有值，不会被吞
  - 花括号内允许空白（`{{ #key }}` / `{{ /key }}`）；自引用模板有 200 轮上限，正常模板一轮收敛
  - 动机：本机 `message` 模板写的是 `【{{reason}}】用时 {{duration}}`，「用时」是字面文本，
    而 `confirmation`（第一次弹确认请求）本来就不带 `duration`，于是渲染成「【需要人工确认】用时 」
    这种半截文案。有了条件段，配置侧改成 `{{#duration}}…{{/duration}}` 就能整段收起
- `lib/index.js`
  - `const cfg = createLiveConfig(withDefaults(config))`（原来是 `withDefaults(config)`）
  - SAPI 通道改成惰性重建：`getSapi()` 按「模板/音色/排队方式」的指纹重建，`sapi.enabled` 在 `lanesFor` 里每次现读
  - 新增 `sendTest(text)` 和 `installSettingsRoutes(...)`
  - 新增总开关 `enabled` 与新对话默认 `sessionDefault`；`notify()` 入口统一过 `sessionEnabled()`（总开关 → 会话覆盖 → 新会话默认）
  - 新增 `isSessionBusy()`：会话还有 `jobs` 在跑、或 goal 还是 `active` 时，`turn/end` 不发——「任务还在跑」能拿到的唯一硬信号
  - `turnEnd` 新增 `minIntervalMs`（同会话最小发送间隔）、`requireTools`（本轮没 `tool/call` 就不发）、`sources`（只认指定来源发起的轮次）；
    `cooldownMs` 默认值 10s → 15s
- `lib/triggers.js`
  - 记录每轮是否出现过 `tool/call`（`turn/start` 重置）与最近一条非注入来源的 `user/message.source.kind`
  - `turn/end` 依次过 `reasons` / `isRootSession` / `requireTools` / `sources` / `isSessionBusy`，再进冷却定时器
  - 定时器到达时按 `lastSentAt` + `minIntervalMs` 限流
  - 2026-10-30 新增 `createTurnTracker()`：两个触发源共用的运行窗口（`turn/start` 置忙、`turn/end` 置闲），
    目前只用来把**确认超时升级**攒到收尾 (`turnEnd.quietDuringTurn`)；首次提醒一律穿透。
  - 2026-10-30 `approval/asked` 增加沉默窗口判定（`confirmation.smartApproval`）：
    asked 之后先等 `smartApprovalWaitMs`（默认 1000ms）再发。依据是本机 `dsh-purge` 的 approval bypass
    在 `decide()` 里直接 `return 'allowed-once'`，asked 与 decided 同一个 tick 接踵而至——窗口内被放行的静默，
    没被放行的（拒绝/取消/不可用）带上结果说一声。动机：approval policy 被 purge 改成自动放行之后，
    每一个待审批调用都弹一条，全是噪音。
  - 新增 `pendingNote(held, firstMaxChars = 40)`：纯函数，没有待报项返回空串
- `lib/index.js`（2026-10-30）
  - `createTurnTracker()` 在 `apply` 里建一份，`installTurnEndTrigger` / `installConfirmationTrigger` 共用
  - `turnEnd` 新增 `quietDuringTurn`（默认 `true`）与 `reportPending`（默认 `true`）
  - `confirmation` 新增 `smartApproval`（默认 `true`）与 `smartApprovalWaitMs`（默认 `1000`）
  - `notify()` 的 `turn-end` 分支把 `detail.note` 前置到正文；这条不受 `includeText` 隐私开关约束（它说的是「有几次」不是回复内容）
- `lib/runtime-config.js`
  - `EDITABLE` / `RANGES` 增加 `enabled`、`sessionDefault`、`turnEnd.minIntervalMs`、`turnEnd.requireTools`、`turnEnd.sources`
  - 2026-10-30：`EDITABLE` 增加 `turnEnd.quietDuringTurn`、`turnEnd.reportPending`、
    `confirmation.smartApproval`、`confirmation.smartApprovalWaitMs`（设置页开关，写完即生效）
  - `EDITABLE` 增加 `style.appName` / `style.icon`（2026-10-29）：只用来记住设置页用过什么，真正生效靠宿主转给本机网关卡
  - 新增按会话覆盖表 `sessions.json`（`readSessionOverrides` / `writeSessionOverride` / `clearSessionOverrides`），与 `ui-config.json` 分开存
  - 新增 `homeDir()`，供设置页定位 `storages/session_projcache`
- `lib/settings-api.js`
  - 新增 `GET/POST /sessions`：最近 30 个对话（标题 + 时间 + 是否单独改过 + 是否正在跑）与单个对话的开关
  - 列表跳过 `storages/workspace.json` 里 `global.archivedSessionIds` 记录的已归档对话
  - 列表跳过空对话：投影缓存里 `titleInput.count` 为 0 且没有标题的（点进去没说话就离开留下的壳），侧栏里不显示，这里也不列
  - 新增 `POST /style`（2026-10-29）：把 `{appName | iconBase64+iconName | iconPath | resetIcon}` 转给本机 toast 网关的
    `POST /style`，成功后把最终值记进覆盖层。只发给 loopback 通道——样式改的是本机开始菜单快捷方式，
    远端 webhook 没有这个东西
  - `GET /config` / `GET /status` 多回一个 `gatewayStyle`：网关实际生效的 `{appName, icon, aumid}`，
    设置页拿它显示「当前值」，问不到就是 `null`
- `lib/client.js`
  - 设置页新增「通知开关」一段：总开关、新对话默认、按对话管理列表
  - 「什么时候提醒」补三项：同对话最小间隔、这轮没干活就不提醒、只提醒你发起的
  - 2026-10-30：「什么时候提醒」再补两项 —— 「干活时别打扰」（`turnEnd.quietDuringTurn`）、
    「收尾时报一下攒了几次」（`turnEnd.reportPending`）
  - 2026-10-30：「要你动手的时候」补两项 —— 「自动放行就别吵」（`confirmation.smartApproval`）、
    「等几秒算『真在等人』」（`confirmation.smartApprovalWaitMs`）
  - 2026-10-29：所有分类改成可折叠表头（`段` 组件），展开状态按标题记在 `localStorage`，
    默认只有「通知开关」是展开的
  - 2026-10-29：新增「通知样式」一段：改通知头部的应用名、选本地图片当图标（读成 base64 交给网关）、
    恢复默认图标、试发一条。图标文件不占配置体积，落在网关目录的 `custom-icon.*`
- `package.json`
  - `exports` 加 `"./client": "./lib/client.js"`
  - `dsh` 加 `client` 声明（`platform: web` + inject 三个客户端包）
- `README.md` / `README.zh.md`：顶部补一节「这个 fork 加了设置页」，配置表补新键

## 设置页的编号

`settings.section` 的 `label` 和 `order` 是按某个具体机器的工具清单排的（`14. 任务通知` / `order 40`）。
换一台机器或清单变了，直接改 `lib/client.js` 里那一行：

```js
{ name: 'settings.section', id: 'dsh-notify', order: 40, label: '14. 任务通知' }
```

`order` 只决定左侧栏顺序，取个没被占的数就行；`label` 是显示文字。

## 能热改 / 要重启

- **热改（设置页即时生效）**：`turnEnd.*`、`confirmation.*`、`rootOnly`、`sapi.*`、`escalation.*`
- **要重启**：`http` / `a2a` / `mcp` 的通道列表（通道对象启动时建好）、`tools.notify.enabled`

## 边界

- 设置页只写白名单字段（见 `EDITABLE`），越界数字被夹住，非法枚举丢弃，`http.channels` 一类不允许从界面改
- 覆盖文件坏了按「无覆盖」处理，不会把插件弄挂

## 安装依赖

插件只 peerDepend `@deepseek-ai/schemastery`。如果插件目录是 `link:` 进 profile 的、而且和宿主的
`node_modules` 不在同一棵树上（比如分在不同的盘），Node 从真实路径向上找不到它——在插件目录里补一个：

```sh
mkdir -p node_modules/@deepseek-ai
ln -s <profile>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
# Windows:
mklink /J node_modules\@deepseek-ai\schemastery <profile>\node_modules\@deepseek-ai\schemastery
```
