# dsh-notify

A DeepSeek Harness (dsh) task-monitoring notification plugin. While the agent works, it pushes key states to you:

- **turn/end**: notifies on task completion/error/blocked/max-tokens (title, reason, duration by default)
- **human confirmation needed**: notifies on approval dialogs and `ask_user_question` (with a question summary)
- **confirmation timeout escalation**: after 10 minutes without a decision, re-alerts via SAPI voice + high-priority webhooks
- **model-initiated notify tool**: `notify` tool (off by default) lets the model push a message to you proactively

Four channel kinds: HTTP webhooks (QQ bot / serverchan / DingTalk / WeCom / ntfy are the same channel with different endpoints), A2A agents (one-way `message/send`), MCP tools (streamable-http notification bridges), and Windows SAPI local voice. Pure Node, zero runtime dependencies, build-free bundle, installed in the same `dsh.bundle.patch` shape as dsh-desktop-shell.

## Installation

```sh
dsh plugin --profile web add github:ikashana/dsh-notify
# headless works too (voice/HTTP/A2A/MCP all still send):
dsh plugin --profile headless add github:ikashana/dsh-notify
```

The plugin is inserted via a bundle patch and defaults to **listen-only, no disturbance** (no HTTP/A2A/MCP channels, voice off, notify tool off). Configure endpoints by replacing the whole config under the same id in your profile's `cordis.patch.yml` (**a non-insert patch replaces the target entry's entire config object — rewrite every key you want to keep**):

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

> Keep private config (endpoints with secrets) in a local patch/config file and gitignore it; the public repo has zero hardcoded secrets.

## Triggers

### 1. turn/end (automatic)

Listens to `session/event` `turn/end`. The `reason.kind` whitelist defaults to `[completed, error, blocked, max-tokens]` (aborted is a user-initiated cancel and stays quiet by default; configurable). If a new `turn/start` appears inside the cooldown window after a turn ends (default 10 s), the pending notification is cancelled — multi-turn jobs report only the final state. Only root sessions notify (subagent children stay silent; configurable). Duration = envelope `time` of turn/end minus turn/start.

**Dispose resend**: a notification still inside its cooldown window is sent immediately when the plugin disposes (process exit / HMR unload) instead of waiting — for a one-shot headless task that exits right after turn/end, this is the moment the last state gets out. Entries already cancelled by a new turn/start are not resent (the cancel semantics hold).

### 2. Human confirmation needed

- `approval/asked`: notifies when an approval dialog appears (summary = tool name + reason).
- `ask_user_question` `tool/call`: parses the arguments JSON for the question summary. **Headless false-positive switch**: headless has no userQuestions provider, so the ask fails immediately but `tool/call` still fires — `askUserQuestion: 'auto'` (default) only sends when a web layer is detected (a `webServer` service exists); `'on'` forces, `'off'` disables.

After the resolution signal arrives (`approval/decided` by id, `tool/result` by `message.source.callId`), the default is silence; `notifyDecided: true` sends "confirmed/rejected/…".

### 3. Confirmation timeout escalation

Per-session pending table + a `ctx.timeout()` timer (effect-managed, cleaned up on dispose). On timeout (default 10 min, `timeoutMs: 0` disables) sends a priority escalation: SAPI voice + the high-priority channels in `escalation.channelIds` (queue-jumping).

**Dispose resend**: if confirmations are still pending when the plugin disposes, one escalation is resent (escalation only — never the confirmation first-report, which was already sent when the event happened); no resend when escalation is disabled (`timeoutMs: 0`).

### 4. notify tool (model-initiated, off by default)

With `tools.notify.enabled: true`, the model gains a `notify` tool: `{ message: string, channel?: string, priority?: boolean }`. `message` is the model's verbatim text, enqueued as a `kind='model-message'` notification through the regular channel chain; `channel` restricts sending to that channel id; `priority` jumps the queue. Subagent sessions are silently skipped (consistent with the root-session filter).

**Privacy note**: a model-initiated message is explicit content — it bypasses the `turnEnd.includeText` privacy switch and appears verbatim in the notification. The tool is off by default for exactly this reason: enabling it authorizes the model to push arbitrary text to every configured channel.

## Channels

### HTTP (lib/channels/http.js)

`url`/`headers`/`body` are fully template-rendered; 10 s timeout + exponential backoff with 2 retries (429/5xx/network errors retry, other 4xx fail over immediately); a failed primary channel falls back to the `fallback` chain. Secrets never sit in plain text:

- `${env:XXX}` — read from the environment
- `${credential:REF}` — resolved via the dsh credentials service (optional; errors if the service is absent)

### A2A (lib/channels/a2a.js)

One-way send to an A2A protocol 1.0 agent: POST JSON-RPC 2.0 `message/send` to `agentUrl` with `params.message = { messageId, role: 'agent', parts: [{ kind: 'text', text }] }`. Both `messageId` and the request `id` use `node:crypto` random UUIDs (receivers dedupe by messageId to prevent replays). The text renders through the `template` config (default `【{{reason}}】{{title}}｜{{duration}}`). No SSE stream, no task polling — a response without a JSON-RPC error means accepted. Failure classification, retries, and fallback behave exactly like the HTTP channel.

### MCP (lib/channels/mcp.js)

A streamable-http MCP server notification bridge: the first send performs one `initialize` handshake (protocol version tries 2025-03-26 first, falls back to 2024-11-05 if rejected; the server's accepted version wins), the handshake result is cached, and every subsequent notification calls `tools/call` (`{ name: config.tool, arguments: rendered params }`), caching and echoing the `mcp-session-id` response header. Handshake failures are fail-soft: the error goes to the queue's retry/failover chain and the next send re-handshakes automatically. Responses may be SSE (`text/event-stream`); the minimal implementation parses only the first frame, preferring `application/json`.

### SAPI voice (lib/channels/sapi.js, Windows only)

Spawns **powershell.exe** (Windows PowerShell 5.1, not pwsh) with `-NoProfile -NonInteractive -EncodedCommand`; the script travels as UTF-16LE Base64 so Chinese never mangles through GBK; System.Speech synthesizes with an auto-picked zh-CN voice; `windowsHide: true` + `stdio: 'ignore'` means no console window, and the child is unref'ed so it plays independently. **Fail-soft**: any failure is silently skipped. Voice queue: at most 1 Speak at a time; new notifications `merge` (keep the latest) or `drop`.

### Queue (lib/queue.js)

Concurrency 2, per-channel exponential backoff, primary → fallback failover (fallback ids can reference any channel type), priority queue-jumping; dispose flushes (default 2 s cap — inside the 5 s headless exit grace, so messages get out).

## Template variables

`{{title}}` (session title, 「无标题」/“Untitled” when unavailable), `{{reason}}`, `{{text}}`, `{{duration}}`, `{{timestamp}}`; missing fields render as empty strings.

| reason text | |
|---|---|
| turn/end | 任务完成 / 任务出错 / 任务被阻塞 / 超出 token 上限 / 任务已中止 / 任务中断 |
| confirmation | 需要人工确认 |
| decided | 确认已结束 (text carries 已确认/已拒绝/已取消/无法确认/已收到回答) |
| escalation | 等待确认超时 (duration = time waited) |
| model-message | 模型消息 (text = model's verbatim message) |

## Configuration table (defaults = code DEFAULTS; Config validated with schemastery; all keys optional)

| Key | Default | Meaning |
|---|---|---|
| `turnEnd.reasons` | `[completed, error, blocked, max-tokens]` | trigger whitelist; explicit `[]` disables this trigger |
| `turnEnd.cooldownMs` | `10000` | quiet window after turn end (ms); a new turn inside it cancels |
| `turnEnd.includeText` | `false` | body preview switch (recent assistant text) |
| `turnEnd.textMaxChars` | `500` | body truncation length |
| `confirmation.approval` | `true` | approval/asked notification switch |
| `confirmation.askUserQuestion` | `'auto'` | `'auto'`/`'on'`/`'off'`: auto = only with a web layer |
| `confirmation.timeoutMs` | `600000` | escalation threshold, `0` disables |
| `confirmation.notifyDecided` | `false` | send “confirmed” after resolution signals |
| `confirmation.includeQuestion` | `true` | include the question summary (no option details) |
| `confirmation.questionMaxChars` | `120` | question summary truncation |
| `rootOnly` | `true` | notify root sessions only (origin/delegationDepth check) |
| `http.timeoutMs` | `10000` | HTTP request timeout |
| `http.retries` | `2` | per-channel retry count |
| `http.retryBaseMs` | `500` | exponential backoff base (500, 1000, 2000…) |
| `http.channels` | `[]` | HTTP channel list, see below |
| `a2a.timeoutMs` / `a2a.retries` / `a2a.retryBaseMs` | same as http | A2A global defaults |
| `a2a.channels` | `[]` | A2A channel list: `{ id, agentUrl, template?, fallback? }` |
| `mcp.timeoutMs` / `mcp.retries` / `mcp.retryBaseMs` | same as http | MCP global defaults |
| `mcp.channels` | `[]` | MCP channel list: `{ id, url, tool, arguments?, headers?, fallback? }` |
| `tools.notify.enabled` | `false` | notify tool switch (model-initiated notifications) |
| `sapi.enabled` | `false` | voice switch (Windows only) |
| `sapi.template` | `'任务通知：{{title}}，状态：{{reason}}。'` | speech template |
| `sapi.voice` | `'auto'` | `'auto'` = auto zh-CN; or a voice-name match (e.g. `'Huihui'`) |
| `sapi.queue` | `'merge'` | at most 1 Speak at a time: `merge` keeps latest / `drop` discards |
| `escalation.sapi` | `true` | escalation includes voice (requires sapi.enabled) |
| `escalation.channelIds` | `[]` | high-priority channel ids for escalation (any channel type) |
| `queue.concurrency` | `2` | send concurrency cap |
| `queue.flushTimeoutMs` | `2000` | dispose flush wait cap |

Each `http.channels` entry: `{ id, url, method='POST', headers={}, body, timeoutMs, retries, retryBaseMs, fallback: [backup channel ids] }`. Object/array `body` values are JSON-serialized automatically. `fallback` on `a2a.channels`/`mcp.channels` shares the same failover chain and can reference any configured channel id.

## Platform examples

### ntfy (simplest)

```yaml
- id: ntfy
  url: 'https://ntfy.sh/{{your-topic}}'
  headers:
    Authorization: 'Bearer ${env:NTFY_TOKEN}'   # private topics only, optional
  body: |
    【{{reason}}】{{title}}
    时长：{{duration}} ｜ {{timestamp}}
```

### serverchan

```yaml
- id: serverchan
  url: 'https://sctapi.ftqq.com/${env:SERVERCHAN_SENDKEY}.send'
  method: POST
  headers:
    Content-Type: 'application/x-www-form-urlencoded'
  body: 'title={{reason}}：{{title}}&desp={{text}}%0A时长 {{duration}}'
```

### DingTalk custom robot

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

### WeCom robot

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

### QQ bot (OneBot 11 HTTP, e.g. NapCat/LLOneBot)

```yaml
- id: qq
  url: 'http://127.0.0.1:3000/send_private_msg'
  headers:
    Authorization: 'Bearer ${env:ONEBOT_TOKEN}'
    Content-Type: 'application/json'
  body:
    user_id: 3021778961        # replace with your QQ id, or use send_group_msg + group_id
    message: '【{{reason}}】{{title}}\n时长：{{duration}}'
```

### SAPI voice

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

### MCP notification bridge (streamable-http)

```yaml
mcp:
  channels:
    - id: mail-bridge
      url: 'http://127.0.0.1:8080/mcp'
      headers:
        Authorization: 'Bearer ${env:MCP_TOKEN}'   # optional
      tool: send
      arguments:
        to: 'you@example.com'
        text: '【{{reason}}】{{title}}｜时长 {{duration}}'
```

### Primary/backup failover

```yaml
- id: primary
  url: 'https://ntfy.sh/a'
  fallback: ['backup']
- id: backup
  url: 'https://sctapi.ftqq.com/${env:SENDKEY}.send'
  body: 'title={{reason}}：{{title}}'
```

## Privacy defaults

Notifications carry only **title + reason + duration + timestamp** by default. Body preview (`turnEnd.includeText`) and question details are off; question summaries cap at 120 chars. Secrets go through `${env:}`/credentials references, never plain config text. **Exception — the notify tool**: a model-initiated message is explicit content, sent verbatim with no privacy filter — the tool is off by default; enabling it is the authorization.

## Development

```sh
node --check lib/*.js lib/channels/*.js scripts/smoke.mjs   # syntax gate
node scripts/smoke.mjs                                     # zero-dependency smoke (32 items; PASS = green)
```

The smoke suite covers all templates/queue logic, HTTP channel rendering and secret resolution, SAPI script construction, A2A `message/send` structure, MCP initialize handshake/version fallback/SSE parsing, notify-tool schema projection and execution, and both triggers (fake ctx drives events and timers, including dispose-resend semantics).

## Known Limitations

- **SMTP not implemented**: email notifications go through an MCP mail bridge (see the example above — any mail MCP server's send tool).
- **SAPI unavailable in non-interactive sessions**: System.Speech needs a desktop interactive session (Windows Session 0 services or SSH sessions have no audio device); use webhook/A2A/MCP channels there.
- **A2A is one-way `message/send` only**: no SSE subscription, no task polling — accepted means sent; use a full A2A client if you need to read task results.
- **MCP is a minimal implementation**: SSE responses parse only the first frame; an expired session makes the next call fail into the retry/failover chain (the retry re-handshakes, so it self-heals).
- Notifications are not persisted: dispose flushes only 2 s, the rest is dropped.
- `askUserQuestion: 'auto'` treats the `webServer` service as “has a web layer”; a third-party frontend that doesn't register that service looks like headless — set `'on'` to force.
- After an escalation fires, that session's pending table is cleared, so later resolution signals no longer trigger “confirmed” (avoids duplicate noise).
