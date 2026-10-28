# 本地改动说明（相对上游 ikashana/dsh-notify v0.1.0）

这个目录是上游仓库的本地副本，加了「设置页」这一层。上游更新时，先看这份清单再决定怎么合并。

## 新增

| 文件 | 作用 |
|---|---|
| `lib/runtime-config.js` | 运行时配置覆盖层：设置页写 `$DSH_HOME/dsh-notify/ui-config.json`，`apply` 算出的静态配置外面包一层 Proxy，每次读 `cfg.x.y` 现取合并值 → 不用重启 DSH |
| `lib/settings-api.js` | 宿主侧接口 `/api/dsh-notify/*`（config / reset / test / status），经 `ctx.inject(['webServer'])` 挂载，headless 自动跳过 |
| `lib/client.js` | 浏览器半端：设置 → 「7. 任务通知」一页，走 `settings.section` 插槽（序号沿用本机其他插件的排法：order 31→39 对应 1→10，36 空着就是 7） |

## 修改

- `lib/index.js`
  - `const cfg = createLiveConfig(withDefaults(config))`（原来是 `withDefaults(config)`）
  - SAPI 通道改成惰性重建：`getSapi()` 按「模板/音色/排队方式」的指纹重建，`sapi.enabled` 在 `lanesFor` 里每次现读
  - 新增 `sendTest(text)` 和 `installSettingsRoutes(...)`
- `package.json`
  - `exports` 加 `"./client": "./lib/client.js"`
  - `dsh` 加 `client` 声明（platform: web + inject 三个客户端包，抄 dsh-bili-subagent 的写法）
- `node_modules/@deepseek-ai/schemastery` —— 指向 profile 那份的 junction，因为插件装在 D 盘，Node 从真实路径向上找不到宿主依赖

## 能热改 / 要重启

- **热改（设置页即时生效）**：`turnEnd.*`、`confirmation.*`、`rootOnly`、`sapi.*`、`escalation.*`
- **要重启**：`http` / `a2a` / `mcp` 的通道列表（通道对象启动时建好）、`tools.notify.enabled`

## 边界

- 设置页只写白名单字段（见 `EDITABLE`），越界数字被夹住，非法枚举丢弃，`http.channels` 一类不允许从界面改
- 覆盖文件坏了按「无覆盖」处理，不会把插件弄挂
