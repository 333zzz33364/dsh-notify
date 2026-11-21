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
| `lib/badge.js` | 未读完成数：`turn-end` 一次 +1，桌面壳读 `/api/dsh-notify/badge` 画到图标上，回到窗口清零；存 `$DSH_HOME/dsh-notify/badge.json`，重启不清 |

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

- **热改（设置页即时生效）**：`turnEnd.*`、`confirmation.*`、`rootOnly`、`badge.*`、`sapi.*`、`escalation.*`
- **要重启**：`http` / `a2a` / `mcp` 的通道列表（通道对象启动时建好）、`tools.notify.enabled`

## 图标角标（2026-11-17，现已被下一节取代）

插件只负责「数」，「画」在桌面壳那一半：

- `GET /api/dsh-notify/badge` → `{ count, enabled, banner, max, at, file }`
- `POST /api/dsh-notify/badge/clear` → 清零

桌面壳（`<DSH 安装目录>\resources\app\lib\main.js`，`createMainWindow` 内）每 3 秒读一次这个接口，
计数变了就画：Windows 用 `window.setOverlayIcon()` 叠一张 `lib/badge/<数字>.png`（红圆白字，32×32，
任务栏右下角的小徽标），macOS 用 `app.dock.setBadge()`（Dock 上的红圈）。窗口 `focus` 时清零。

配置三项：

| 键 | 默认 | 作用 |
|---|---|---|
| `badge.enabled` | `true` | 任务完成时在图标上显示数字；关掉就不数也不画 |
| `badge.banner` | `true` | 关掉 → `turn-end` 记完数就返回，不弹横幅、不发语音、不推通道（确认类通知不受影响） |
| `badge.max` | `99` | 显示上限；Windows 的小徽标放不下两位数，`>9` 一律画成「9+」 |

桌面壳那一半是改打包产物的，**DSH 升级会把 `main.js` 盖掉**，角标随之失灵（插件侧不受影响）。
盖掉以后把 `main.js.bak-20261117-badge` 里那段「任务完成角标」重新贴回 `createMainWindow`，
再把 `assets/badge/*.png` 拷回 `resources\app\lib\badge\` 即可（这套 32×32 的红圆白字图就放在插件目录里）。

## 壳补丁：任务栏角标（2026-11-20 重打）

11-17 那套 `main.js` 补丁随着 `resources\app` 被打成 `app.asar` 一起没了，本轮把它重新打进 asar。

- 打在哪：`D:\ai2\desktop\resources\app.asar` 里的 `lib/main.js`
  - 新增 `NOTIFY_BADGE_ICONS`（11 张 32×32 的 base64 图，来自本包 `assets/badge/`）
  - 新增 `attachNotifyBadge(window)`：每 2 秒读 `$DSH_HOME/dsh-notify/badge.json`（只读不写）
  - **只画任务栏图标右下角那一小块，不动托盘图标**（托盘换过一版，主人说不要换）
  - 图按 **13×13** 画 —— 那是 Windows 100% 缩放下那块徽标的实际尺寸；**5×7 点阵**（13−5=8，左右各留 4 像素，
    正好居中），1–9 清楚，超过 9 停在 9。之前用 4 宽字模，13−4=9 是奇数，怎么摆都偏半格
  - **清零**（v10，2026-11-21）：①点任务栏图标把窗口叫回来（`focus`）→ 立刻清，不用等；
    ②窗口一直在眼前（一直盯着、没切走）→ 数字露 3 秒就清。清法是壳自己
    `POST /api/dsh-notify/badge/clear`。首帧也要开始计时（`count > 0 && shownAt === 0` 就置 `shownAt`）
    ——否则启动时已经存在的数字会一直挂着，这是 v8 的 bug
  - 轮询改成 **1 秒一次**（`setInterval(tick, 1e3)`），3 秒那道判定才落得准；清零请求没落地
    （宿主没起来）会把计时还回去，下一秒再试
  - **v11 修的真根因（2026-11-21 10:05 实测）**：页面是 `dsh-app://app/`（自定义协议），旧代码只在
    `http:` / `https:` 才发清零请求，其余静默返回 —— **壳一次都没清过**。现在改成
    `webContents.executeJavaScript("fetch('/api/dsh-notify/badge/clear', …)")`，在页面里发同源请求，
    跟页面是什么协议无关；页面还没就绪时再退回主进程 fetch。实测日志：`paint count=4 focus=false
    visible=false url=` → 窗口显示后 `clear-now why=focus` → `clear-page ok=true` → `paint count=0`
  - 诊断日志：`$DSH_HOME/dsh-notify/shell-badge.log`，只在计数变化、清零时各写一行；出问题先看它
  - **v12 两处修正（2026-11-21 10:10）**：
    - **居中**：圆心原来按 `FillEllipse(0.4, 0.4, 12.2, 12.2)` 算，几何中心落在 **6.5**，而 5×7 字模的中心是
      **6.0** —— 差半格，13px 里就是肉眼可见的偏。改成先算字形中心，再把圆的直径取 `size-2` 让圆心压在
      6.0 上（`make-icons9.ps1`）。验证：新图 0 行与 12 行全透明、1 行与 11 行同为 5 宽、2/10 行同为 7 宽，
      上下左右完全镜像
    - **清不掉**：清零请求确实发出去也成功了（日志 `clear-page ok=true`、`epoch` 一路涨），是**画面残留** ——
      `setOverlayIcon(undefined, "")` 在 Windows 上不一定刷新掉，改成传 `null`
  - 源图由 `tools/shell-patch/make-icons.ps1` 现生成（13px 与 26px 两套），不入库
  - **壳内通知**：数字涨了并且 `ui-config.json` 的 `badge.banner` 没关，就用 `new Notification()` 弹一条
    （标题「任务通知」，正文「任务完成｜N 轮跑完了还没看」，点它把窗口叫回来）——弹窗不再依赖外挂的 9775 网关；
    窗口首帧只画不弹，免得重启时补弹历史
  - macOS 走 `app.dock.setBadge()`
- 清零（2026-11-21）：`lib/client.js` 里改成**窗口在眼前时数字出现 3 秒自动零**；切走之后涨起来的留着，
  回到窗口再清。原来只在 blur→focus 时清，一直坐在窗口前就永远清不掉
  - 在 `createMainWindow` 里 `mainWindow = window;` 之后调用它
  - 清零仍归浏览器半端（窗口重新被看到时它自己 POST `/badge/clear`），壳不写文件 —— 免得内存与盘上的数打架
- 备份：`D:\ai2\desktop\resources\app.asar.bak-20261120-badge`（原件，209083008 字节）
- 回滚：双击 `工具\通知\角标回滚.bat`
- DSH 升级后重打：完全退出 DSH，双击 `工具\通知\重打角标补丁.bat`
- 工具与产物：`tools/shell-patch/`（`inspect-asar.mjs` / `read-asar.mjs` / `patch-main.mjs` /
  `pack-asar.mjs` / `verify-asar.mjs` / `make-icons.ps1`）。**重打步骤和六个坑都写在
  `tools/shell-patch/README.md`** —— 下次 DSH 升级后先看那份，别从头摸一遍
- 校验过的事：新 asar 21722 个条目、1666 个 unpacked、20056 份数据逐个对 header 的 SHA256 全部一致；
  header 的 16 字节结构与 padding 规则与原文件完全相同（headerSize 5671400、dataStart 5671408）
- 前置条件查过：`EnableEmbeddedAsarIntegrityValidation` = disabled、`OnlyLoadAppFromAsar` = disabled，
  所以改 asar 不会被 fuse 拦

## 未读数字改画在浏览器半端（2026-11-20）

**为什么改**：11-17 那套壳补丁写在 `resources\app\lib\main.js`（未打包的 app 目录）。11-18 19:34 那次
DSH 升级把资源重新打成 `resources\app.asar`，`main.js` 那一段就没了 —— 现在在 `app.asar` 里搜
`setOverlayIcon` / `setBadgeCount` / `getFocusedWindow` / `requestUserAttention` / `dsh-notify` 全是 0 命中，
只剩 Electron 自己的 `BrowserWindow` 和 `tray.ico`。于是：`badge.json` 一直在写数，却没有任何人读它。

**改法**：数还是插件记，画交给浏览器半端，不再依赖壳。

- `lib/badge.js`：状态从 `{ count, at }` 扩到 `{ count, at, lastReason, epoch }`；`bump(reason)` 记下这一条的原因；
  `clear()` 保留 `at`、只把 `epoch` 继续往上推（客户端靠 epoch 判断「变过了」）；旧文件缺字段补空值，坏文件当 0
- `lib/index.js`：`badge.bump(detail.kind)`；新增 `badge.digits`（默认 `true`），关掉就只记账不画
- `lib/settings-api.js`：`GET /api/dsh-notify/badge` 多返回 `lastReason`、`epoch`、`digits`；
  `POST /badge/clear` 返回清零后的 `epoch`
- `lib/client.js`：新增 `未读徽章`，注册进 `sidebar.toggle.badge` 插槽（`DesktopUpdateBadge` 也占这个位置，两者并排）；
  每 5 秒轮询 `/badge`（页面隐藏时跳过），红底白字小圆、超过 `badge.max` 显示 `99+`、点一下清零；
  同时给窗口标题贴 `(4)` 前缀，并用 `MutationObserver` 盯着 `<title>`（会话标题会整个重写，得改回来）；
  从别处切回来（blur→focus、标签页重新可见）才清零 —— 一直盯着窗口不清，新数要留在眼前
- 设置页：「图标角标」改名「未读数字」，加「在界面上画出来」一行，说明改成实际情形

**要恢复任务栏图标那块小徽标**：得动 `app.asar`（解包 → 在 `createMainWindow` 里贴回那段补丁 + 把
`assets/badge/*.png` 放到 `app` 目录 → 重打包）。改坏了 DSH 起不来，单开一轮再评估。

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
