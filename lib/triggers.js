// dsh-notify 触发源 —— 只依赖 ctx 的 on/timeout 与注入的 notify 回调，不 import cordis 本体。
// 契约：
// - 所有监听走 ctx.on（随 fiber 自动销毁），所有定时器走 ctx.timeout（effect 自动清理）；
// - 返回的 disposer 显式清掉 Map 与未到期定时器（幂等，可重复调用）；
// - turn/end 触发：reason.kind 白名单 + 根会话过滤 + per-session 冷却窗口（窗口内出现新 turn/start 即取消）；
// - 需确认触发：approval/asked 与 ask_user_question 的 tool/call，per-session Map 记录挂起项；
// - 结束信号：approval/decided（按 id）与 tool/result（按 message.source.callId）配对，清挂起项并可选发「已确认」；
// - 确认超时升级：per-session 单定时器，超时发 priority 升级通知（sapi + 高优先级 webhook）；
// - dispose 补发：disposer 先取消全部未到期定时器，再对「待发数据仍在」的条目直接补发通知。
//   冷却窗口/升级定时器只对仍活着的进程有意义；dispose 意味着进程即将退出（headless 一次性任务）
//   或插件热卸载（web），等待已无意义——把最后一条状态通知出去，两场景语义一致。

import { formatDuration, summarizeQuestions } from './templates.js'

/** approval/decided 与「已收到回答」的通知文案。 */
export const DECIDED_LABELS = {
  'allowed-once': '已确认',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法确认',
  answered: '已收到回答',
}

/**
 * 解析 ask_user_question 工具参数的 questions 数组。
 * @param {string} rawArguments - tool/call 的 arguments JSON 字符串（模型原文，可能解析失败）。
 * @returns {unknown[]} 问题数组；解析失败返回 []（触发方静默跳过，fail-soft）。
 */
export function parseQuestions(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments === '') return []
  try {
    const parsed = JSON.parse(rawArguments)
    return Array.isArray(parsed?.questions) ? parsed.questions : []
  } catch {
    return []
  }
}

/**
 * ask_user_question 触发开关裁决。
 * @param {{ askUserQuestion: 'auto' | 'on' | 'off' }} confirmation - 确认触发配置。
 * @param {() => boolean} hasWebLayer - 惰性探测：ctx.get('webServer') 存在即认为有 web 层（有人工应答者）。
 * @returns {boolean}
 */
export function askUserQuestionEnabled(confirmation, hasWebLayer) {
  const mode = confirmation?.askUserQuestion ?? 'auto'
  if (mode === 'on') return true
  if (mode === 'off') return false
  return hasWebLayer()
}

/**
 * 触发源 1：turn 结束自动通知（带 per-session 冷却去抖）。
 * @param {object} ctx - cordis 上下文（用 ctx.on / ctx.timeout）。
 * @param {{ turnEnd: { reasons: string[], cooldownMs: number }, rootOnly: boolean }} config - 插件配置。
 * @param {{
 *   notify: (kind: string, detail: Record<string, unknown>, options?: { priority?: boolean }) => void,
 *   isRootSession: (session: unknown) => boolean,
 * }} deps - notify 回调与根会话判断。
 * @returns {() => void} 合并 disposer。
 */
export function installTurnEndTrigger(ctx, config, { notify, isRootSession }) {
  // sessionId -> { startMs, timer, kind, duration, session }：
  // startMs 供时长计算；timer 是冷却窗口定时器；kind/duration/session 是待发数据
  // （仅 turn/end 写入；turn/start 覆盖时清空待发，timer 触发或 disposer 补发后删除条目）
  const state = new Map()
  const listener = ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined || event?.type === undefined) return
    if (event.type === 'turn/start') {
      const entry = state.get(sessionId)
      entry?.timer?.() // 冷却窗口内出现新 turn：取消待发通知
      state.set(sessionId, { startMs: event.time, timer: undefined })
      return
    }
    if (event.type !== 'turn/end') return
    const kind = event.data?.reason?.kind
    if (!config.turnEnd.reasons.includes(kind)) return
    if (!isRootSession(session)) return
    const entry = state.get(sessionId)
    const startMs = entry?.startMs
    const duration = typeof startMs === 'number' ? formatDuration(event.time - startMs) : ''
    const timer = ctx.timeout(() => {
      state.delete(sessionId)
      notify('turn-end', { kind, duration, session })
    }, config.turnEnd.cooldownMs)
    state.set(sessionId, { startMs, timer, kind, duration, session })
  })
  return () => {
    listener()
    for (const entry of state.values()) {
      entry.timer?.()
      // dispose 补发：冷却窗口定时器被取消后，有待发数据的条目直接补发
      //（进程退出前最后一次机会；窗口内已被新 turn/start 取消的条目无 kind，自然跳过）
      if (entry.kind !== undefined) {
        notify('turn-end', { kind: entry.kind, duration: entry.duration, session: entry.session })
      }
    }
    state.clear()
  }
}

/**
 * 触发源 2 + 超时升级：需人工确认通知（approval/asked、ask_user_question）与确认超时升级。
 * per-session Map<sessionId, { items, timer, askedAt, session }>：items 按 key 记录挂起确认。
 * @param {object} ctx - cordis 上下文。
 * @param {{
 *   confirmation: {
 *     approval: boolean, askUserQuestion: 'auto' | 'on' | 'off',
 *     timeoutMs: number, notifyDecided: boolean, questionMaxChars: number,
 *   },
 *   rootOnly: boolean,
 * }} config - 插件配置。
 * @param {{
 *   notify: (kind: string, detail: Record<string, unknown>, options?: { priority?: boolean }) => void,
 *   isRootSession: (session: unknown) => boolean,
 *   hasWebLayer: () => boolean,
 * }} deps
 * @returns {() => void} 合并 disposer。
 */
export function installConfirmationTrigger(ctx, config, { notify, isRootSession, hasWebLayer }) {
  const { confirmation } = config
  const pending = new Map() // sessionId -> { items: Map<key, summary>, timer, askedAt, session }

  /** 发出升级通知并清掉该会话的挂起表（超时触发与 dispose 补发共用）。 */
  function fireEscalation(sessionId, entry) {
    const first = [...entry.items.values()][0] ?? ''
    const waitMs = typeof entry.askedAt === 'number' ? Date.now() - entry.askedAt : undefined
    pending.delete(sessionId)
    notify(
      'escalation',
      {
        text: first,
        duration: typeof waitMs === 'number' ? formatDuration(waitMs) : '',
        sessionId,
        session: entry.session, // 供标题等会话信息使用
      },
      { priority: true },
    )
  }

  /** 为会话武装/重置升级定时器（每次新增挂起项都重置：以最新确认的等待起点计）。 */
  function armTimer(sessionId) {
    const entry = pending.get(sessionId)
    if (entry === undefined || confirmation.timeoutMs <= 0) return
    entry.timer?.()
    entry.timer = ctx.timeout(() => {
      const overdue = pending.get(sessionId)
      if (overdue === undefined) return
      fireEscalation(sessionId, overdue)
    }, confirmation.timeoutMs)
  }

  /** 记录一条挂起确认并（重新）武装升级定时器。 */
  function addPending(sessionId, key, summary, session) {
    let entry = pending.get(sessionId)
    if (entry === undefined) {
      entry = { items: new Map(), timer: undefined, askedAt: Date.now(), session }
      pending.set(sessionId, entry)
    }
    entry.items.set(key, summary)
    armTimer(sessionId)
  }

  /** 结束信号到达：清挂起项；该会话不再有挂起项时撤定时器。 */
  function removePending(sessionId, key) {
    const entry = pending.get(sessionId)
    if (entry === undefined) return
    entry.items.delete(key)
    if (entry.items.size === 0) {
      entry.timer?.()
      pending.delete(sessionId)
    }
  }

  const listener = ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined || event?.type === undefined) return

    if (event.type === 'approval/asked') {
      if (!confirmation.approval || !isRootSession(session)) return
      const { id, toolName, reason } = event.data ?? {}
      const summary = `${toolName ?? ''}${reason ? `：${reason}` : ''}`
      addPending(sessionId, `approval:${id}`, summary, session)
      notify('confirmation', { text: summary, session })
      return
    }

    if (event.type === 'approval/decided') {
      const key = `approval:${event.data?.id}`
      const entry = pending.get(sessionId)
      const existed = entry?.items.has(key) ?? false
      removePending(sessionId, key)
      if (existed && confirmation.notifyDecided) {
        notify('decided', { text: DECIDED_LABELS[event.data?.outcome] ?? '确认结束', session })
      }
      return
    }

    if (event.type === 'tool/call') {
      // headless 误报开关：无 web 层的 headless 里 ask 立即失败，tool/call 照发 —— auto 模式下探测 webServer
      if (event.data?.name !== 'ask_user_question') return
      if (!askUserQuestionEnabled(confirmation, hasWebLayer)) return
      if (!isRootSession(session)) return
      const questions = parseQuestions(event.data?.arguments)
      if (questions.length === 0) return // 参数解析失败：静默跳过
      const summary = summarizeQuestions(questions, confirmation.questionMaxChars)
      if (summary === '') return
      addPending(sessionId, `tool:${event.data?.callId}`, summary, session)
      notify('confirmation', { text: summary, session })
      return
    }

    if (event.type === 'tool/result') {
      // tool/result 与 tool/call 经 message.source.callId 配对（结果消息里带着调用 id）
      const callId = event.data?.message?.source?.callId
      if (callId === undefined) return
      const key = `tool:${callId}`
      const entry = pending.get(sessionId)
      const existed = entry?.items.has(key) ?? false
      removePending(sessionId, key)
      if (existed && confirmation.notifyDecided) {
        notify('decided', { text: DECIDED_LABELS.answered, session })
      }
    }
  })

  return () => {
    listener()
    for (const [sessionId, entry] of pending) {
      entry.timer?.()
      // dispose 补发：仍有未决确认项的会话补发一次 escalation（升级功能开启时）。
      // 只补发升级通知，不补发 confirmation 首报——首报在事件发生时已经发过。
      if (entry.items.size > 0 && confirmation.timeoutMs > 0) {
        fireEscalation(sessionId, entry)
      }
    }
    pending.clear()
  }
}
