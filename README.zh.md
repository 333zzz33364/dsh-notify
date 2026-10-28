# dsh-notify

DeepSeek Harness（dsh）任务监控通知插件。agent 跑任务时，把关键状态推给你：

- **turn 结束**：任务完成/出错/被阻塞/超 token 时通知（默认带标题、原因、时长）
- **需人工确认**：approval 弹窗、`ask_user_question` 提问时通知（带问题摘要）
- **确认超时升级**：等待确认超过 10 分钟，语音播报 + 高优先级 webhook 再催一次
- **模型主动通知**：`notify` 工具（默认关闭），模型可主动把消息推给你

四类通道：HTTP webhook（QQ 机器人 / serverchan / 钉钉 / 企微 / ntfy 是同一通道的不同 endpoint 配置）、A2A agent（`message/send` 单向）、MCP 工具（streamable-http 通知桥）与 Windows SAPI 本地语音。纯 Node、零运行时依赖、免构建 bundle，照 dsh-desktop-shell 的 `dsh.bundle.patch` 形态安装。

## 这个 fork：加了一页设置界面

上游只有宿主半边，所有开关都写在 profile 的 `cordis.patch.yml` 里，改一次要重启。这个 fork 补了浏览器半边和一层运行时覆盖：

- **在哪**：**设置** → 左侧栏「`14. 任务通知`」。编号跟着这台机器的工具清单走；和你的清单撞了，就改 `lib/client.js` 里的 `label`。
- **改完不用重启**：设置写进 `$DSH_HOME/dsh-notify/ui-config.json`，读配置时用 `Proxy` 现合并，立刻生效。通道列表和 `tools.notify.enabled` 仍要重启（通道对象是启动时建的）。
- **能改什么**：五个 `turn/end` 触发原因、冷却秒数、带不带正文、审批提醒、提问提醒、超时升级、语音模板 / 音色 / 排队方式、只提醒主会话。全部过白名单——越界数字夹住、不认识的键丢掉、文件坏了当「没覆盖」。
- **接口**：`/api/dsh-notify/{config,reset,test,status}`，用 `ctx.inject(['webServer'])` 挂载，headless 部署完全不受影响。
- **网关体检**：`status` 和「发一条测试通知」会去探本机 HTTP 通道的 `/health`，本机中转进程死了会显示「没在跑」，而不是悄悄把通知吞掉。

和上游 0.1.0 的完整差异见 [`PATCH-NOTES.md`](./PATCH-NOTES.md)。


## 安装

```sh
dsh plugin --profile web add github:ikashana/dsh-notify
# headless 场景同样可用（语音/HTTP/A2A/MCP 照发）：
dsh plugin --profile headless add github:ikashana/dsh-notify
```

插件随 bundle patch 插入，默认**只监听不打扰**（HTTP/A2A/MCP 通道空、语音关、notify 工具关）。配置端点：

在 profile 自己的 `cordis.patch.yml` 里用同一 id 整段替换 config（**非 insert 的 patch 会替换目标行的整个 config 对象，覆盖时请把要保留的键全部重写**）：

```yaml
- id: notify
  config:
    http:
      channels:
        - id: ntfy
          url: 'https://ntfy.sh/my-topic'
    sapi:
      enabled: true
    tools:
      notify:
        enabled: true
```

> 本机私有配置（含密钥端点）建议放在本地 patch/config 文件里并 gitignore；公开仓库零硬编码。

## 触发源

### 1. turn 结束（自动）

监听 `session/event` 的 `turn/end`。`reason.kind` 白名单默认 `[completed, error, blocked, max-tokens]`（aborted 是用户主动取消，默认不打扰，可配开）。turn 结束后的冷却窗口（默认 10 秒）内出现新 `turn/start` 就取消发送——连续多轮任务只报最终状态。只通知根会话（subagent 子会话不发，可配开）。时长 = turn/start 与 turn/end 事件信封 time 之差。

**dispose 补发**：冷却窗口内的待发通知，在插件销毁（进程退出/HMR 热卸载）时不再等待冷却，直接补发——headless 一次性任务跑完即退出，这是最后一条状态送出去的时机。窗口内已被新 turn/start 取消的条目不补发（取消语义保持）。

### 2. 需人工确认

- `approval/asked`：approval 弹窗出现即通知（摘要 = 工具名 + 原因）。
- `ask_user_question` 的 `tool/call`：解析 arguments JSON 取问题摘要。**headless 误报开关**：headless 没有 userQuestions provider，ask 立即失败但 `tool/call` 照发——`askUserQuestion: 'auto'`（默认）只在探测到 web 层（`webServer` 服务存在）时才发，`'on'` 强制发、`'off'` 关。

结束信号到达（`approval/decided` 按 id、`tool/result` 按 `message.source.callId` 配对）后默认静默，`notifyDecided: true` 可发「已确认/已拒绝…」。

### 3. 确认超时升级

per-session 挂起表 + `ctx.timeout()` 定时器（effect 管理，插件销毁自动清理）。超时（默认 10 分钟，`timeoutMs: 0` 关闭）发优先级升级通知：SAPI 语音 + `escalation.channelIds` 里的高优先级 webhook（插队发送）。

**dispose 补发**：仍有未决确认项时，插件销毁前补发一次升级通知（只补发 escalation，不补发 confirmation 首报——首报在事件发生时已发过）；升级功能关闭（`timeoutMs: 0`）时不补发。

### 4. notify 工具（模型主动通知，默认关闭）

`tools.notify.enabled: true` 开启后，模型多一个 `notify` 工具：`{ message: string, channel?: string, priority?: boolean }`。message 是模型原文，作为 `kind='model-message'` 通知入队走常规通道链；channel 指定只发该通道 id；priority 插队。子会话调用静默不发送（与触发源根会话过滤一致）。

**隐私提醒**：模型主动发的就是显式内容，不套 `turnEnd.includeText` 隐私开关——message 原样出现在通知里。默认关闭正是为此：开启即授权模型往你配置的所有通道推任意文本。

## 通道

### HTTP（lib/channels/http.js）

`url`/`headers`/`body` 全部模板渲染，超时 10s + 指数退避重试 2 次（429/5xx/网络错误可重试，其余 4xx 直接降级），主通道失败降级到 `fallback` 备用通道。密钥占位符不落明文：

- `${env:XXX}` —— 从环境变量读
- `${credential:REF}` —— 经 dsh credentials 服务解析（可选，未提供该服务则报错）

### A2A（lib/channels/a2a.js）

向 A2A 协议 1.0 agent 单向发送：POST JSON-RPC 2.0 `message/send` 到 `agentUrl`，`params.message = { messageId, role: 'agent', parts: [{ kind: 'text', text }] }`。`messageId` 与请求 `id` 都用 `node:crypto` 随机 UUID（接收端按 messageId 去重防重放）。文本走 `template` 模板（默认 `【{{reason}}】{{title}}｜{{duration}}`）。不建 SSE、不轮询任务结果——响应无 JSON-RPC error 即受理成功。失败分类与重试/降级链同 HTTP 通道。

### MCP（lib/channels/mcp.js）

streamable-http MCP server 的通知桥：第一次发送时 `initialize` 握手一次（协议版本先试 2025-03-26、被拒降级 2024-11-05，以服务器接受为准），握手结果缓存，随后每次通知 `tools/call`（`{ name: config.tool, arguments: 渲染后的参数 }`），响应头的 `mcp-session-id` 缓存并回传。握手失败 fail-soft：抛错交队列重试/降级，下次发送自动重新握手。响应可能为 SSE（`text/event-stream`），最小实现只解析第一帧结果，`application/json` 优先。

### SAPI 语音（lib/channels/sapi.js，仅 Windows）

spawn **powershell.exe**（Windows PowerShell 5.1，不是 pwsh）`-NoProfile -NonInteractive -EncodedCommand`，脚本以 UTF-16LE Base64 传输杜绝中文 GBK 乱码；System.Speech 合成、自动选 zh-CN 语音；`windowsHide: true` + `stdio: 'ignore'` 无黑窗，spawn 后不 await、unref，子进程独立播放。**fail-soft**：任何失败静默跳过。语音排队：同一时刻最多 1 个 Speak，新通知 `merge`（合并保留最新）或 `drop`（丢弃）。

### 队列（lib/queue.js）

并发 2、单通道指数退避重试、主通道→备用通道降级（fallback 可跨通道类型引用 id）、priority 任务插队；dispose 时 flush（默认 2 秒上限，headless 进程退出有 5 秒宽限，发得完）。

## 模板变量

`{{title}}`（会话标题，取不到为「无标题」）`{{reason}}` `{{text}}` `{{duration}}` `{{timestamp}}`，缺字段渲染为空串。

| reason 文案 | |
|---|---|
| turn/end | 任务完成 / 任务出错 / 任务被阻塞 / 超出 token 上限 / 任务已中止 / 任务中断 |
| confirmation | 需要人工确认 |
| decided | 确认已结束（text 携带 已确认/已拒绝/已取消/无法确认/已收到回答） |
| escalation | 等待确认超时（duration 为已等待时长） |
| model-message | 模型消息（text 为模型原文） |

## 配置表（默认值即代码 DEFAULTS，Config 用 schemastery 校验，键均可省略）

| 键 | 默认 | 说明 |
|---|---|---|
| `turnEnd.reasons` | `[completed, error, blocked, max-tokens]` | 触发白名单；显式 `[]` 关闭本触发源 |
| `turnEnd.cooldownMs` | `10000` | turn 结束后的安静窗口（ms），窗口内新 turn 则取消 |
| `turnEnd.includeText` | `false` | 正文预览开关（最近 assistant 文本） |
| `turnEnd.textMaxChars` | `500` | 正文截断字符数 |
| `confirmation.approval` | `true` | approval/asked 通知开关 |
| `confirmation.askUserQuestion` | `'auto'` | `'auto'`/`'on'`/`'off'`：auto=有 web 层才发 |
| `confirmation.timeoutMs` | `600000` | 确认超时升级阈值，`0` 关闭 |
| `confirmation.notifyDecided` | `false` | 结束信号到达后是否发「已确认」 |
| `confirmation.includeQuestion` | `true` | 通知带问题摘要（不含选项等详情） |
| `confirmation.questionMaxChars` | `120` | 问题摘要截断字符数 |
| `rootOnly` | `true` | 只通知根会话（origin/delegationDepth 判断） |
| `http.timeoutMs` | `10000` | HTTP 请求超时 |
| `http.retries` | `2` | 单通道重试次数 |
| `http.retryBaseMs` | `500` | 指数退避基数（500, 1000, 2000…） |
| `http.channels` | `[]` | HTTP 通道列表，见下 |
| `a2a.timeoutMs` / `a2a.retries` / `a2a.retryBaseMs` | 同 http | A2A 全局默认 |
| `a2a.channels` | `[]` | A2A 通道列表：`{ id, agentUrl, template?, fallback? }` |
| `mcp.timeoutMs` / `mcp.retries` / `mcp.retryBaseMs` | 同 http | MCP 全局默认 |
| `mcp.channels` | `[]` | MCP 通道列表：`{ id, url, tool, arguments?, headers?, fallback? }` |
| `tools.notify.enabled` | `false` | notify 工具开关（模型主动通知） |
| `sapi.enabled` | `false` | 语音开关（仅 Windows 有效） |
| `sapi.template` | `'任务通知：{{title}}，状态：{{reason}}。'` | 播报模板 |
| `sapi.voice` | `'auto'` | `'auto'`=自动 zh-CN；或语音名匹配（如 `'Huihui'`） |
| `sapi.queue` | `'merge'` | 同时最多 1 个 Speak：`merge` 合并 / `drop` 丢弃 |
| `escalation.sapi` | `true` | 升级通知带语音（需 sapi.enabled） |
| `escalation.channelIds` | `[]` | 升级专用高优先级通道 id 列表（可引用任意通道类型） |
| `queue.concurrency` | `2` | 发送并发上限 |
| `queue.flushTimeoutMs` | `2000` | dispose flush 等待上限 |

`http.channels` 每条：`{ id, url, method='POST', headers={}, body, timeoutMs, retries, retryBaseMs, fallback: [备用通道id] }`。`body` 为对象/数组时自动 JSON 序列化。`a2a.channels`/`mcp.channels` 的 `fallback` 与 HTTP 共用同一降级链，可引用任意已配置通道的 id。

## 平台配置示例

### ntfy（最简单）

```yaml
- id: ntfy
  url: 'https://ntfy.sh/{{your-topic}}'
  headers:
    Authorization: 'Bearer ${env:NTFY_TOKEN}'   # 私有 topic 用，可选
  body: |
    【{{reason}}】{{title}}
    时长：{{duration}} ｜ {{timestamp}}
```

### serverchan 方糖

```yaml
- id: serverchan
  url: 'https://sctapi.ftqq.com/${env:SERVERCHAN_SENDKEY}.send'
  method: POST
  headers:
    Content-Type: 'application/x-www-form-urlencoded'
  body: 'title={{reason}}：{{title}}&desp={{text}}%0A时长 {{duration}}'
```

### 钉钉自定义机器人

```yaml
- id: dingtalk
  url: 'https://oapi.dingtalk.com/robot/send?access_token=${env:DINGTALK_TOKEN}'
  headers:
    Content-Type: 'application/json'
  body:
    msgtype: text
    text:
      content: '【{{reason}}】{{title}}\n时长：{{duration}}\n{{text}}'
```

### 企业微信机器人

```yaml
- id: wecom
  url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${env:WECOM_KEY}'
  headers:
    Content-Type: 'application/json'
  body:
    msgtype: text
    text:
      content: '【{{reason}}】{{title}}\n时长：{{duration}}'
```

### QQ 机器人（OneBot 11 HTTP，如 NapCat/LLOneBot）

```yaml
- id: qq
  url: 'http://127.0.0.1:3000/send_private_msg'
  headers:
    Authorization: 'Bearer ${env:ONEBOT_TOKEN}'
    Content-Type: 'application/json'
  body:
    user_id: 3021778961        # 改成你的 QQ 号，或换 send_group_msg + group_id
    message: '【{{reason}}】{{title}}\n时长：{{duration}}'
```

### SAPI 语音

```yaml
sapi:
  enabled: true
  template: '任务通知：{{title}}，状态：{{reason}}。'
  voice: auto
```

### A2A agent

```yaml
a2a:
  channels:
    - id: hermes-agent
      agentUrl: 'http://127.0.0.1:9900/a2a'
      template: '【{{reason}}】{{title}}｜时长 {{duration}}'
```

### MCP 通知桥（streamable-http）

```yaml
mcp:
  channels:
    - id: mail-bridge
      url: 'http://127.0.0.1:8080/mcp'
      headers:
        Authorization: 'Bearer ${env:MCP_TOKEN}'   # 可选
      tool: send
      arguments:
        to: 'you@example.com'
        text: '【{{reason}}】{{title}}｜时长 {{duration}}'
```

### 主备降级

```yaml
- id: primary
  url: 'https://ntfy.sh/a'
  fallback: ['backup']
- id: backup
  url: 'https://sctapi.ftqq.com/${env:SENDKEY}.send'
  body: 'title={{reason}}：{{title}}'
```

## 隐私默认

默认通知只含 **标题 + reason + 时长 + 时间戳**。正文预览（`turnEnd.includeText`）与问题详情默认不含；问题摘要 120 字符内。密钥一律走 `${env:}`/credentials 引用，不落配置文件明文。**notify 工具例外**：模型主动发送的 message 是显式内容，原样推送、无隐私过滤——工具默认关闭，开启即视为授权。

## 开发

```sh
node --check lib/*.js lib/channels/*.js scripts/smoke.mjs   # 语法门
node scripts/smoke.mjs                                     # 零依赖冒烟（32 项，PASS 即通过）
```

冒烟覆盖 templates/queue 全部逻辑、HTTP 通道配置渲染与密钥解析、SAPI 脚本构造、A2A `message/send` 结构、MCP initialize 握手/版本降级/SSE 解析、notify 工具 schema 投影与执行、两个触发源（假 ctx 驱动事件与定时器，含 dispose 补发语义）。

## 已知限制

- **SMTP 未实现**：邮箱通知请走 MCP 邮箱桥（如上例：任意 mail MCP server 的 send 工具）。
- **SAPI 非交互会话不可用**：System.Speech 需要桌面交互会话（Windows Session 0 服务或 SSH 会话无音频设备）；非交互环境请改用 webhook/A2A/MCP 通道。
- **A2A 仅 `message/send` 单向**：不订阅 SSE 流、不轮询任务结果，发送受理即成功；需要读取任务结果的场景请用完整 A2A 客户端。
- **MCP 最小实现**：响应为 SSE 时只解析第一帧；会话过期后下一次调用失败并走降级/重试链（重试时会重新握手，可自愈）。
- 通知不持久化：进程退出时只 flush 2 秒，未发完的丢弃。
- `askUserQuestion: 'auto'` 以 `webServer` 服务为「有 web 层」依据；若第三方前端不注册该服务会被误判为 headless，可配 `'on'` 强制。
- 升级通知发出后该会话的挂起项即清空，此后的决定信号不再触发「已确认」（避免重复打扰）。
