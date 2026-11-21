# 桌面壳补丁：任务栏未读数字

插件自己只**记数**（`$DSH_HOME/dsh-notify/badge.json`）。要让数字出现在**任务栏图标右下角**，
必须改桌面壳 —— DSH 的 Electron 主进程文件 `lib/main.js`，它被打包在 `resources/app.asar` 里。

DSH 每升级一次，`app.asar` 会被整份替换，补丁随之消失。所以这套脚本的目标是**可重复地重打**，
而不是手工改一次就算。

## 先决条件

- `app.asar` 里 `package.json` 的 `main` 指向 `lib/main.js`（0.2.2-rc.5 是这样）
- exe 的 fuse 关掉了 asar 完整性校验和「只从 asar 加载」：
  - `EnableEmbeddedAsarIntegrityValidation` = disabled
  - `OnlyLoadAppFromAsar` = disabled
  - 否则改过的 asar 会被直接拒载
- 对 `<DSH_INSTALL>\resources\` 有写权限（通常需要管理员）
- Node 18+（脚本用 ESM 和全局 `fetch`）

## 五步

```sh
# 0) 备份（只需做一次，之后一直用它当重打源）
copy "<DSH_INSTALL>\resources\app.asar" "<DSH_INSTALL>\resources\app.asar.bak"

# 1) 生成图标（13px 和 26px 两套，数字 0–9）
powershell -ExecutionPolicy Bypass -File make-icons.ps1 ./icons

# 2) 从备份里抽出原始的 lib/main.js
node read-asar.mjs "<DSH_INSTALL>\resources\app.asar.bak" lib/main.js > main.orig.js

# 3) 打补丁（注入 attachNotifyBadge 和数字位图）
node patch-main.mjs main.orig.js main.patched.js ./icons

# 4) 重打包：只换 lib/main.js，其它文件与顺序原样保留，重算它的 integrity
node pack-asar.mjs "<DSH_INSTALL>\resources\app.asar.bak" main.patched.js app.new.asar

# 5) 校验：每个文件的数据都要对得上 header 里的 SHA256
node verify-asar.mjs app.new.asar

# 通过后再覆盖，覆盖前先完全退出 DSH
copy app.new.asar "<DSH_INSTALL>\resources\app.asar"
```

`inspect-asar.mjs` 用来看结构（条目数、unpacked 数、header 尺寸），排查时先跑它。

## 六个坑

按踩到时的代价排序，前两个各花了一轮完整排查。

### 1. 页面是 `dsh-app://` 自定义协议，不是一个 http 服务

想在主进程里清零，很自然会写成：

```js
const url = new URL(window.webContents.getURL())
if (url.protocol !== 'http:' && url.protocol !== 'https:') return
fetch(url.origin + '/api/...')
```

这段**永远不会执行到底**：DSH 的主窗口加载的是 `dsh-app://app/`，协议不是 http，直接 return，
而且静默返回、不报错、不写日志 —— 看着像"清零逻辑没跑"，其实是请求根本没发。

正确做法是在**页面里**发同源请求，页面自己知道 base：

```js
window.webContents.executeJavaScript(
  "fetch('/api/dsh-notify/badge/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })",
  true
)
```

页面还没就绪时再退回主进程那份。**任何"要从壳里访问宿主 HTTP 接口"的地方都适用这条。**

### 2. overlay 图标的尺寸和圆心

- Windows 100% 缩放下，任务栏那个小徽标实际约 **13×13**。给 16 或 32 会被非整数缩放，
  数字又糊又偏。要高分屏就用 `image.addRepresentation({ scaleFactor: 2, buffer })` 补一张 26×26，
  而不是直接把画布放大。
- **圆的几何中心必须压在字形中心上**。用 `FillEllipse` 画 13px 里的圆时，
  写 `(0.4, 0.4, 12.2, 12.2)` 圆心落在 6.5，而 5×7 字模放在 4..8 / 3..9 时中心是 **6.0** ——
  差半格，13 像素里就是肉眼可见的偏。
  算法：先算字形中心 `cx = x0 + 5*dot/2 - 0.5`，圆直径取 `size - 2`，从 `cx - d/2` 起画。
- 字模宽度用 **5** 而不是 4：`13-5=8` 左右各 4，正好对称；4 宽时 `13-4=9` 是奇数，
  怎么摆都要偏半格。

### 3. 清除用 `null`，不是 `undefined`

```js
window.setOverlayIcon(count > 0 ? image : null, description)
```

传 `undefined` 时清零请求明明成功了（日志里 `count` 归零），任务栏上的红点却还留着。
Windows 上要传 `null` 才会真正擦掉。

### 4. 首帧也要开始计时

只在"数字变大"时记下出现时间是不够的：启动时 `badge.json` 里可能已经有数，
那一刻没有"变大"事件，计时器永远停在 0，于是"看够 N 秒就清"那条分支永远不成立 ——
数字从开机钉到关机。条件要写成：

```js
if (count > 0 && (grew || shownAt === 0)) shownAt = Date.now()
```

### 5. Windows PowerShell 5.1 会按 ANSI 读 `.ps1`

脚本里只要有一句中文注释、或者路径里有中文，5.1 就可能把双字节的尾字节当成引号，
解析直接崩，报的还是 `Unexpected token` 这种看不出根因的错。两种解法：

- 把文件存成 **UTF-8 with BOM**（5.1 认 BOM）
- 或者脚本里干脆不写中文，路径用参数传

### 6. asar 不是"zip 换个后缀"

16 字节头：`u32(4) / headerSize / (jsonLen + padding + 4) / jsonLen`，
JSON 从 offset 16 开始，数据区起点 `dataStart = 8 + headerSize`，
`padding = (4 - jsonLen % 4) % 4`。

改了哪个文件，就要**重算它的 `integrity`**（`algorithm: SHA256`、`hash`、`blockSize: 4194304`、
`blocks[]` 每 4MB 一块），并且重排所有 `offset`。`pack-asar.mjs` 做的就是这些，
`verify-asar.mjs` 逐文件对 `header` 里的摘要，全部通过才算成。

## 回滚

把备份覆盖回去，或者直接重装同版本 DSH：

```sh
copy "<DSH_INSTALL>\resources\app.asar.bak" "<DSH_INSTALL>\resources\app.asar"
```

补丁只在 `lib/main.js` 里多了 `attachNotifyBadge` 一段（含 base64 图），
不改别的文件，所以回滚不需要卸载任何东西。

## 补丁到底在不在：三步定位

从「改了没反应」到「知道断在哪一环」，按这个顺序走，别一上来就重打。

```sh
# ① 代码在不在 asar 里
node read-asar.mjs "<DSH_INSTALL>\resources\app.asar" lib/main.js > main.check.js
node check-patch.mjs main.check.js
```

```
OK    补丁函数已注入
OK    主窗口里调用了它
OK    清零走页面内同源请求
OK    3 秒兜底清零
OK    focus 立刻清
OK    清除传 null（不是 undefined）
OK    写了诊断日志
版本注释：2026-11-21 v12
```

有 `MISS` 就是没打进去，回上面五步。

```sh
# ② 代码跑没跑：日志里必须有 attach 那一行
tail -n 5 "$DSH_HOME/dsh-notify/shell-badge.log"
```

```
2026-11-21T02:32:58.507Z attach ok pid=75460
```

没有 `attach ok` = 补丁进 asar 了但 `createMainWindow` 没走到（或者页面换了创建路径）。

```sh
# ③ 跑了但不清：读同一段时间里的 paint / clear 行
```

- `paint count=N` 后面**没有** `clear-now` → 兜底条件没成立，看那行的 `focus=` / `visible=` / `min=`
- 有 `clear-now` 但紧跟 `clear-page-error` 或 `clear-main-skip` → 请求没发出去，看 `protocol=`
- 全绿（`clear-page ok=true` + `paint count=0`）但屏幕上数字还在 → **画面没刷新**，见坑 3

**一条通用经验：Electron 主进程的 `console.log` 在这套壳里看不到。** 想观测就得往文件写
（`appendFileSync`），而且要写在"谁调用、谁失败"两处，光写一个"我进来了"不够用。

## 诊断

壳会在 `$DSH_HOME/dsh-notify/shell-badge.log` 里写两种行，只在计数变化和清零时各写一行：

```
2026-11-21T02:30:05.094Z paint count=1 focus=true visible=true min=false url=dsh-app://app/ at=...
2026-11-21T02:30:08.108Z clear-now count=1 why=focus
2026-11-21T02:30:08.115Z clear-page ok=true
```

`url=` 一眼就能看出页面是什么协议；`focus/visible/min` 说明当时窗口状态；
`clear-now why=` 区分是 focus 触发还是 3 秒兜底触发。出问题先看这个文件。
