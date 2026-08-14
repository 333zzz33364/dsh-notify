// dsh-notify 插件入口 —— cordis function plugin（仅命名导出 name/inject/Config/apply，无 default export）。
// 职责：装配通道（HTTP + A2A + MCP + SAPI）→ 发送队列 → 两个触发源 + 模型主动通知工具；
// 所有注册经 ctx.on/ctx.effect/ctx.tools.register，dispose 时补发待发通知并 flush 队列
// （2 秒上限，headless 5 秒退出宽限内可发完）。
//
// Config 校验机制说明：vendored cordis 的 resolveConfig 要求 Config 是 StandardSchema
// 校验器（runtime.Config['~standard'].validate），纯对象会在加载时 TypeError。因此这里
// import @deepseek-ai/schemastery（dsh 生态自带，bundle 解析从宿主安装的 node_modules 走）。
// schemastery 的对象键缺省可选、缺失即跳过；实际默认值统一由代码内 DEFAULTS 深度合并兜底
// （patch 行完全省略 config 时 apply 收到 undefined 也安全）。

import z from '@deepseek-ai/schemastery'
import { createQueue } from './queue.js'
import { createA2aChannel } from './channels/a2a.js'
import { createHttpChannel } from './channels/http.js'
import { createMcpChannel } from './channels/mcp.js'
import { createSapiChannel } from './channels/sapi.js'
import { createNotifyTool } from './notify-tool.js'
import { installConfirmationTrigger, installTurnEndTrigger } from './triggers.js'
import { extractRecentText, localTimestamp, reasonLabel, truncate } from './templates.js'

/** Cordis 插件名（与 cordis.patch.yml 的 insert id 对应）。 */
export const name = 'notify'

/** tools 服务用于注册 notify 工具；sessionTitle/webServer/credentials 全部走 ctx.get 可选读取。 */
export const inject = ['tools', 'timer']

/** 全部默认值（单一事实源：Config 的 .default() 与 README 配置表都从这里取）。 */
export const DEFAULTS = {
  turnEnd: {
    // 触发 reason.kind 白名单：aborted 默认不打扰（用户主动取消），可配开
    reasons: ['completed', 'error', 'blocked', 'max-tokens'],
    cooldownMs: 10_000, // turn 结束后的安静窗口：窗口内有新 turn/start 就不发
    includeText: false, // 隐私最小化：正文预览默认不带
    textMaxChars: 500,
  },
  confirmation: {
    approval: true, // approval/asked 类默认开（headless 默认 policy=never，本就不会产生 asked）
    askUserQuestion: 'auto', // headless 误报开关：auto=探测到 web 层（webServer 服务）才发
    timeoutMs: 600_000, // 确认超时升级，0 = 关闭
    notifyDecided: false, // 结束信号默认静默，可配开
    includeQuestion: true, // 通知里带问题摘要（不含详情）
    questionMaxChars: 120,
  },
  rootOnly: true, // 只通知根会话；subagent 子会话不发
  http: {
    timeoutMs: 10_000,
    retries: 2,
    retryBaseMs: 500,
    channels: [], // 不配端点就不发 HTTP：纯监听不打扰
  },
  a2a: {
    timeoutMs: 10_000,
    retries: 2,
    retryBaseMs: 500,
    channels: [], // 不配端点就不发 A2A
  },
  mcp: {
    timeoutMs: 10_000,
    retries: 2,
    retryBaseMs: 500,
    channels: [], // 不配端点就不发 MCP
  },
  tools: {
    notify: {
      enabled: false, // 模型主动通知工具默认关闭：开启后模型可借 notify 工具往任意通道发消息，需显式授权
    },
  },
  sapi: {
    enabled: false, // Windows 专属语音，默认关
    template: '任务通知：{{title}}，状态：{{reason}}。',
    voice: 'auto', // 'auto' = zh-* 语音；也可填语音名匹配模式（如 'Huihui'）
    queue: 'merge', // 同一时刻最多 1 个 Speak：merge=合并保留最新 / drop=丢弃
  },
  escalation: {
    sapi: true, // 超时升级默认带语音
    channelIds: [], // 高优先级 webhook 通道 id 列表（可选）
  },
  queue: {
    concurrency: 2,
    flushTimeoutMs: 2_000, // dispose flush 上限；headless 进程退出有 5 秒宽限，2 秒内可发完
  },
}

/** 单条 HTTP 通道配置的校验。 */
const httpChannelConfig = z.object({
  id: z.string(),
  url: z.string(),
  method: z.string(),
  headers: z.dict(z.string()),
  body: z.union([z.string(), z.object({}), z.array(z.any())]),
  timeoutMs: z.number(),
  retries: z.number(),
  retryBaseMs: z.number(),
  fallback: z.array(z.string()),
})

/** 单条 A2A 通道配置的校验。 */
const a2aChannelConfig = z.object({
  id: z.string(),
  agentUrl: z.string(),
  template: z.string(),
  timeoutMs: z.number(),
  retries: z.number(),
  retryBaseMs: z.number(),
  fallback: z.array(z.string()),
})

/** 单条 MCP 通道配置的校验。 */
const mcpChannelConfig = z.object({
  id: z.string(),
  url: z.string(),
  tool: z.string(),
  arguments: z.dict(z.any()),
  headers: z.dict(z.string()),
  timeoutMs: z.number(),
  retries: z.number(),
  retryBaseMs: z.number(),
  fallback: z.array(z.string()),
})

/** notify 工具参数 schema（schemastery z 对象）：运行时校验器 + JSON Schema 单一事实源。 */
export const notifyToolParams = z.object({
  message: z.string().required().description('通知正文（模型原文，将原样推送给主人，无隐私过滤）'),
  channel: z.string().description('可选：只发送到指定通道 id（缺省发送到全部已配置通道）'),
  priority: z.boolean().description('可选：true 时插队发送（紧急消息）'),
})

// 说明：schemastery 对缺失键填 .default()（克隆），对显式给出的值照单校验 ——
// 因此「用户显式配空数组」= 真的关闭，「用户整段不配 config」= 拿到全部默认值。
/** 插件配置校验（schemastery，StandardSchema）。键全部可选，缺省填 DEFAULTS。 */
export const Config = z.object({
  turnEnd: z.object({
    reasons: z.array(z.string()).default(DEFAULTS.turnEnd.reasons),
    cooldownMs: z.number().default(DEFAULTS.turnEnd.cooldownMs),
    includeText: z.boolean().default(DEFAULTS.turnEnd.includeText),
    textMaxChars: z.number().default(DEFAULTS.turnEnd.textMaxChars),
  }),
  confirmation: z.object({
    approval: z.boolean().default(DEFAULTS.confirmation.approval),
    askUserQuestion: z.union([z.const('auto'), z.const('on'), z.const('off')]).default(DEFAULTS.confirmation.askUserQuestion),
    timeoutMs: z.number().default(DEFAULTS.confirmation.timeoutMs),
    notifyDecided: z.boolean().default(DEFAULTS.confirmation.notifyDecided),
    includeQuestion: z.boolean().default(DEFAULTS.confirmation.includeQuestion),
    questionMaxChars: z.number().default(DEFAULTS.confirmation.questionMaxChars),
  }),
  rootOnly: z.boolean().default(DEFAULTS.rootOnly),
  http: z.object({
    timeoutMs: z.number().default(DEFAULTS.http.timeoutMs),
    retries: z.number().default(DEFAULTS.http.retries),
    retryBaseMs: z.number().default(DEFAULTS.http.retryBaseMs),
    channels: z.array(httpChannelConfig).default(DEFAULTS.http.channels),
  }),
  a2a: z.object({
    timeoutMs: z.number().default(DEFAULTS.a2a.timeoutMs),
    retries: z.number().default(DEFAULTS.a2a.retries),
    retryBaseMs: z.number().default(DEFAULTS.a2a.retryBaseMs),
    channels: z.array(a2aChannelConfig).default(DEFAULTS.a2a.channels),
  }),
  mcp: z.object({
    timeoutMs: z.number().default(DEFAULTS.mcp.timeoutMs),
    retries: z.number().default(DEFAULTS.mcp.retries),
    retryBaseMs: z.number().default(DEFAULTS.mcp.retryBaseMs),
    channels: z.array(mcpChannelConfig).default(DEFAULTS.mcp.channels),
  }),
  tools: z.object({
    notify: z.object({
      enabled: z.boolean().default(DEFAULTS.tools.notify.enabled),
    }),
  }),
  sapi: z.object({
    enabled: z.boolean().default(DEFAULTS.sapi.enabled),
    template: z.string().default(DEFAULTS.sapi.template),
    voice: z.string().default(DEFAULTS.sapi.voice),
    queue: z.union([z.const('merge'), z.const('drop')]).default(DEFAULTS.sapi.queue),
  }),
  escalation: z.object({
    sapi: z.boolean().default(DEFAULTS.escalation.sapi),
    channelIds: z.array(z.string()).default(DEFAULTS.escalation.channelIds),
  }),
  queue: z.object({
    concurrency: z.number().default(DEFAULTS.queue.concurrency),
    flushTimeoutMs: z.number().default(DEFAULTS.queue.flushTimeoutMs),
  }),
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深度合并 DEFAULTS 与用户配置（用户侧数组整段替换，null/undefined 跳过）。 */
function withDefaults(config) {
  const merge = (base, patch) => {
    const out = Array.isArray(base) ? [...base] : { ...base }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined || value === null) continue
      out[key] = isPlainObject(out[key]) && isPlainObject(value) ? merge(out[key], value) : value
    }
    return out
  }
  return merge(DEFAULTS, config)
}

/**
 * Apply 插件：装配通道与队列，安装触发源。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 * @param {Record<string, unknown> | undefined} config - 经 Config 校验的配置（可能为 undefined）。
 */
export function apply(ctx, config) {
  const cfg = withDefaults(config)
  const logger = ctx.logger
  const warn = message => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }

  // ---- 通道装配 ----
  // credentials 服务惰性读取：启动顺序/HMR 安全，每次发送前取最新引用
  const getCredentials = () => ctx.get('credentials')
  // 全部外发通道（HTTP/A2A/MCP）按 id 共用一个 Map：fallback 降级链与 escalation.channelIds
  // 可以引用任意类型通道
  const allChannels = new Map()
  for (const raw of cfg.http.channels) {
    const channel = createHttpChannel(
      {
        ...raw,
        timeoutMs: raw.timeoutMs ?? cfg.http.timeoutMs,
        retries: raw.retries ?? cfg.http.retries,
        retryBaseMs: raw.retryBaseMs ?? cfg.http.retryBaseMs,
      },
      { getCredentials, logger },
    )
    channel.fallbackIds = raw.fallback ?? [] // createHttpChannel 不携带 fallback 配置，这里补上
    allChannels.set(channel.id, channel)
  }
  for (const raw of cfg.a2a.channels) {
    const channel = createA2aChannel(
      {
        ...raw,
        timeoutMs: raw.timeoutMs ?? cfg.a2a.timeoutMs,
        retries: raw.retries ?? cfg.a2a.retries,
        retryBaseMs: raw.retryBaseMs ?? cfg.a2a.retryBaseMs,
      },
      { getCredentials, logger },
    )
    channel.fallbackIds = raw.fallback ?? []
    allChannels.set(channel.id, channel)
  }
  for (const raw of cfg.mcp.channels) {
    const channel = createMcpChannel(
      {
        ...raw,
        timeoutMs: raw.timeoutMs ?? cfg.mcp.timeoutMs,
        retries: raw.retries ?? cfg.mcp.retries,
        retryBaseMs: raw.retryBaseMs ?? cfg.mcp.retryBaseMs,
      },
      { getCredentials, logger },
    )
    channel.fallbackIds = raw.fallback ?? []
    allChannels.set(channel.id, channel)
  }

  /** 组装一条通道链：主通道 + fallback 备用通道（按 id 解析，防环）。 */
  function laneFor(channel) {
    const fallback = []
    const seen = new Set([channel.id])
    for (const id of channel.fallbackIds ?? []) {
      if (seen.has(id)) continue
      const target = allChannels.get(id)
      if (target === undefined) {
        warn(`notify: 备用通道 ${id} 未配置，忽略`)
        continue
      }
      seen.add(id)
      fallback.push(target)
    }
    return { ...channel, fallback }
  }

  // SAPI 语音通道：setTimer 用 unref 定时器（估算播报时长释放名额，不阻止进程退出）
  const sapi = cfg.sapi.enabled
    ? createSapiChannel({
        template: cfg.sapi.template,
        voice: cfg.sapi.voice,
        queueMode: cfg.sapi.queue,
        logger,
      })
    : undefined

  // ---- 发送队列 ----
  const queue = createQueue({ concurrency: cfg.queue.concurrency, logger })

  /** 各通知 kind 的通道组合；channelId 指定时只走该通道（notify 工具定向发送用）。 */
  function lanesFor(kind, channelId) {
    if (kind === 'escalation') {
      // 升级：只走升级通道（高优先级 webhook）+ 可选语音
      const lanes = []
      for (const id of cfg.escalation.channelIds) {
        const channel = allChannels.get(id)
        if (channel === undefined) {
          warn(`notify: 升级通道 ${id} 未配置，忽略`)
          continue
        }
        lanes.push(laneFor(channel))
      }
      if (cfg.escalation.sapi && sapi !== undefined) lanes.push(sapi)
      return lanes
    }
    if (channelId !== undefined) {
      // 定向发送：只走指定通道（不自动带语音）
      const channel = allChannels.get(channelId)
      if (channel === undefined) {
        warn(`notify: 通道 ${channelId} 未配置，忽略`)
        return []
      }
      return [laneFor(channel)]
    }
    // 常规：全部外发通道 + 可选语音
    const lanes = [...allChannels.values()].map(laneFor)
    if (sapi !== undefined) lanes.push(sapi)
    return lanes
  }

  // ---- 会话辅助 ----
  /** 标题：可选 sessionTitle 服务；取不到回退「无标题」。 */
  function titleOf(session) {
    const service = ctx.get('sessionTitle')
    const title = typeof service?.get === 'function' ? service.get(session)?.title : undefined
    return typeof title === 'string' && title.trim() !== '' ? title : '无标题'
  }

  /** 根会话判断：header.origin 非 subagent 且 delegationDepth 为 0。 */
  function isRootSession(session) {
    if (!cfg.rootOnly) return true
    return session?.header?.origin !== 'subagent' && (session?.header?.delegationDepth ?? 0) === 0
  }

  /** 探测 web 层（ask_user_question 误报开关用）：webServer 服务只存在于 web profile。 */
  const hasWebLayer = () => ctx.get('webServer') !== undefined

  // ---- 消息构造与发送 ----
  /**
   * 由 kind + 触发方提供的 detail 组装通知字段五件套并入队。
   * @param {string} kind - 'turn-end' | 'confirmation' | 'decided' | 'escalation' | 'model-message'。
   * @param {Record<string, unknown>} detail - { kind?, duration?, text?, session?, sessionId? }。
   * @param {{ priority?: boolean, channel?: string }} options - priority: true 插队；channel 定向通道 id。
   * @returns {boolean} 是否受理入队（无可用通道或未知 kind 返回 false）。
   */
  function notify(kind, detail = {}, options = {}) {
    const session = detail.session
    let reason
    let text = ''
    let duration = typeof detail.duration === 'string' ? detail.duration : ''
    switch (kind) {
      case 'turn-end':
        reason = reasonLabel(detail.kind)
        text = cfg.turnEnd.includeText
          ? extractRecentText(session?.events ?? [], cfg.turnEnd.textMaxChars)
          : ''
        break
      case 'confirmation':
        reason = '需要人工确认'
        text = cfg.confirmation.includeQuestion
          ? truncate(String(detail.text ?? ''), cfg.confirmation.questionMaxChars)
          : ''
        break
      case 'decided':
        reason = '确认已结束'
        text = String(detail.text ?? '')
        break
      case 'escalation':
        reason = '等待确认超时'
        text = cfg.confirmation.includeQuestion
          ? truncate(String(detail.text ?? ''), cfg.confirmation.questionMaxChars)
          : ''
        break
      case 'model-message':
        // 模型主动发送的显式内容：直接发，不套 includeText 隐私开关（README 提醒）
        reason = '模型消息'
        text = String(detail.text ?? '')
        break
      default:
        return false // 未知 kind：静默
    }
    const fields = {
      title: titleOf(session),
      reason,
      text,
      duration,
      timestamp: localTimestamp(Date.now()),
    }
    const lanes = lanesFor(kind, options.channel)
    if (lanes.length === 0) {
      if (typeof logger?.debug === 'function') logger.debug(`notify: ${kind} 无可用通道，跳过`)
      return false
    }
    return queue.push({ kind, fields, lanes }, { priority: options.priority === true })
  }

  // ---- 触发源 ----
  const disposeTurnEnd = installTurnEndTrigger(ctx, cfg, { notify, isRootSession })
  const disposeConfirmation = installConfirmationTrigger(ctx, cfg, { notify, isRootSession, hasWebLayer })

  // ---- 模型主动通知工具（默认关闭，config tools.notify.enabled: true 开启）----
  if (cfg.tools.notify.enabled) {
    ctx.tools.register(createNotifyTool({
      params: notifyToolParams,
      notify: (message, channel, priority, session) => {
        return notify('model-message', { text: message, session }, { channel, priority })
      },
      sessionOf: exec => exec?.agent?.session,
      isRootSession,
    }))
  }

  // dispose flush：effect 清理钩子里清触发源状态并等队列发完（async 清理会被 cordis await）
  ctx.effect(() => () => {
    disposeTurnEnd()
    disposeConfirmation()
    return queue.flush(cfg.queue.flushTimeoutMs)
  })
}
