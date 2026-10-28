# 改动说明（相对上游 ikashana/dsh-notify v0.1.0）

上游只有宿主半边，所有开关都写在 profile 的 `cordis.patch.yml` 里，改一次要重启 DSH。
这份改动补了浏览器半边和一层运行时覆盖层，让常用开关能在设置页里改、改完就生效。

上游更新时，先看这份清单再决定怎么合并。

## 新增

| 文件 | 作用 |
|---|---|
| `lib/runtime-config.js` | 运行时配置覆盖层：设置页写 `$DSH_HOME/dsh-notify/ui-config.json`，`apply` 算出的静态配置外面包一层 Proxy，每次读 `cfg.x.y` 现取合并值 → 不用重启 DSH |
| `lib/settings-api.js` | 宿主侧接口 `/api/dsh-notify/*`（config / reset / test / status），经 `ctx.inject(['webServer'])` 挂载，headless 自动跳过；test 和 status 会探本机 HTTP 通道的 `/health`，死掉的本地中转能一眼看出来 |
| `lib/client.js` | 浏览器半端：设置 →「14. 任务通知」一页，走 `settings.section` 插槽 |

## 修改

- `lib/index.js`
  - `const cfg = createLiveConfig(withDefaults(config))`（原来是 `withDefaults(config)`）
  - SAPI 通道改成惰性重建：`getSapi()` 按「模板/音色/排队方式」的指纹重建，`sapi.enabled` 在 `lanesFor` 里每次现读
  - 新增 `sendTest(text)` 和 `installSettingsRoutes(...)`
- `package.json`
  - `exports` 加 `"./client": "./lib/client.js"`
  - `dsh` 加 `client` 声明（`platform: web` + inject 三个客户端包）
- `README.md` / `README.zh.md`：顶部补一节「这个 fork 加了设置页」

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
