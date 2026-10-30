// dsh-notify 触发源 —— 只依赖 ctx 的 on/timeout 与注入的 notify 回调，不 import cordis 本体。
// 契约：
// - 所有监听走 ctx.on（随 fiber 自动销毁），所有定时器走 ctx.timeout（effect 自动清理）；
// - 返回的 disposer 显式清掉 Map 与未到期定时器（幂等，可重复调用）；
// - turn/end 触发：reason.kind 白名单 + 根会话过滤 + per-session 冷却窗口（窗口内出现新 turn/start 即取消）；
//   外加两道「任务进行中不打扰」的闸：requireTools（本轮没 tool/call 不发）与 minIntervalMs（同会话最小发送间隔）；
//   再加一道 turnTracker 运行窗口（turn/start → turn/end）：窗口内的确认类通知只记账，随 turn-end 合并成一条；
// - 需确认触发：approval/asked 与 ask_user_question 的 tool/call，per-session Map 记录挂起项；
// - 结束信号：approval/decided（按 id）与 tool/result（按 message.source.callId）配对，清挂起项并可选发「已确认」；
// - 确认超时升级：per-session 单定时器，超时发 priority 升级通知（sapi + 高优先级 webhook）；
// - dispose 补发：disposer 先取消全部未到期定时器，再对「待发数据仍在」的条目直接补发通知。
//   冷却窗口/升级定时器只对仍活着的进程有意义；dispose 意味着进程即将退出（headless 一次性任务）
//   或插件热卸载（web），等待已无意义——把最后一条状态通知出去，两场景语义一致。

import { formatDuration, summarizeQuestions, truncate } from './templates.js'

/** 这些 user/message.source.kind 是上下文注入，不代表「谁要的这一轮」，不参与 sources 判定。 */
const INJECTION_SOURCES = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'agent-instructions',
  'user-approval',
])

/** approval/decided 与「已收到回答」的通知文案。 */
export const DECIDED_LABELS = {
  'allowed-once': '已确认',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无法确认',
  answered: '已收到回答',
}

/** 合并文案里「首条摘要」的字符上限（只是提示，不追求完整）。 */
const NOTE_FIRST_MAX_CHARS = 40

/**
 * 会话运行态追踪器 —— 两个触发源共用的「这一轮还在跑吗」硬信号。
 *
 * 为什么需要它：`isSessionBusy`（jobs / goal）只能看见后台任务与 goal 模式，
 * 看不见「模型还在同一个 turn 里连续调工具」。审批类通知恰好在这段时间里最密
 * （approval policy = ask 时一次审批一条），所以这里补一个 turn/start → turn/end 的窗口标记，
 * 让确认触发源在窗口内只累计、不发送，等 turn 结束合并成一条。
 *
 * 结构：sessionId -> { running, held, first }。
 * - running：turn/start 置真、turn/end 置假；没有条目一律视为假（老会话、headless 安全）。
 * - held / first：窗口内被吞掉的待确认条数与首条摘要；turn-end 取走后清零。
 * @returns {{
 *   markStart: (sessionId: string) => void,
 *   markEnd: (sessionId: string) => void,
 *   isRunning: (sessionId: string) => boolean,
 *   hold: (sessionId: string, summary?: string) => boolean,
 *   takeHeld: (sessionId: string) => { count: number, first: string } | null,
 * }} 追踪器。
 */
export function createTurnTracker() {
  const state = new Map() // sessionId -> { running: boolean, held: number, first: string }

  function get(id) {
    return typeof id === 'string' && id !== '' ? state.get(id) : undefined
  }

  return {
    /** turn/start：进入运行窗口。上一轮攒下的 held 不动（要等 turn-end 才消费）。 */
    markStart(id) {
      if (typeof id !== 'string' || id === '') return
      let entry = state.get(id)
      if (entry === undefined) {
        entry = { running: true, held: 0, first: '' }
        state.set(id, entry)
        return
      }
      entry.running = true
    },
    /** turn/end：退出运行窗口。没有待报项就直接删条目，Map 不随会话数无限长。 */
    markEnd(id) {
      const entry = get(id)
      if (entry === undefined) return
      entry.running = false
      if (entry.held === 0) state.delete(id)
    },
    /** 这一轮是否还在跑。 */
    isRunning(id) {
      return get(id)?.running === true
    },
    /**
     * 尝试「吞下」一条通知：只有轮次正在跑时才算吞下。
     * @returns {boolean} true = 已记账、调用方不要发送；false = 轮次空闲，照常发送。
     */
    hold(id, summary) {
      const entry = get(id)
      if (entry === undefined || entry.running !== true) return false
      entry.held += 1
      if (entry.first === '' && typeof summary === 'string') entry.first = summary
      return true
    },
    /** 取走并清零累计的待报项；没有则返回 null。 */
    takeHeld(id) {
      const entry = get(id)
      if (entry === undefined || entry.held === 0) return null
      const out = { count: entry.held, first: entry.first }
      entry.held = 0
      entry.first = ''
      if (entry.running !== true) state.delete(id)
      return out
    },
  }
}

/**
 * 把累计的待确认项拼成一句提示，附在 turn-end 通知正文前面。
 * @param {{ count: number, first: string } | null} held - takeHeld 的结果。
 * @param {number} firstMaxChars - 首条摘要上限。
 * @returns {string} 形如 `期间有 3 次待确认（首条：编辑 xxx.txt）`；无内容返回空串。
 */
export function pendingNote(held, firstMaxChars = NOTE_FIRST_MAX_CHARS) {
  if (held === null || held === undefined) return ''
  const count = Number(held.count)
  if (!Number.isFinite(count) || count <= 0) return ''
  const first = truncate(String(held.first ?? '').trim(), firstMaxChars)
  const tail = first === '' ? '' : `（首条：${first}）`
  return `期间有 ${count} 次待确认${tail}`
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
 *   turnTracker?: ReturnType<typeof createTurnTracker>,
 * }} deps - notify 回调与根会话判断；turnTracker 用来标运行窗口（确认类通知靠它闭嘴）。
 * @returns {() => void} 合并 disposer。
 */
export function installTurnEndTrigger(ctx, config, { notify, isRootSession, isSessionBusy, turnTracker }) {
  // sessionId -> { startMs, timer, kind, duration, session, usedTools }：
  // startMs 供时长计算；timer 是冷却窗口定时器；kind/duration/session 是待发数据
  // （仅 turn/end 写入；turn/start 覆盖时清空待发，timer 触发或 disposer 补发后删除条目）；
  // usedTools 记录本轮是否调过工具（requireTools 开关用）。
  const state = new Map()
  // sessionId -> 上次真正发出 turn-end 的毫秒时间（minIntervalMs 限流用，无上限增长但一个会话一条）
  const lastSentAt = new Map()
  // sessionId -> 本会话最近一条「真正发起请求」的 user/message.source.kind（sources 过滤用）
  const ownerSource = new Map()
  const listener = ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined || event?.type === undefined) return
    if (event.type === 'user/message') {
      // 只记发起者：运行时上下文/时间上下文/技能表这类注入不是「谁要的这一轮」
      const source = event.data?.source?.kind
      if (typeof source === 'string' && !INJECTION_SOURCES.has(source)) ownerSource.set(sessionId, source)
      return
    }
    if (event.type === 'turn/start') {
      const entry = state.get(sessionId)
      entry?.timer?.() // 冷却窗口内出现新 turn：取消待发通知
      state.set(sessionId, { startMs: event.time, timer: undefined, usedTools: false })
      turnTracker?.markStart(sessionId) // 进入运行窗口：确认类通知开始只累计不发送
      return
    }
    if (event.type === 'tool/call') {
      // 只标记「这一轮碰过工具」，不在这里做任何发送判断
      const entry = state.get(sessionId)
      if (entry !== undefined) entry.usedTools = true
      return
    }
    if (event.type !== 'turn/end') return
    // 任何分支都要退出运行窗口：轮次已收尾，之后的确认立刻照发才有意义
    turnTracker?.markEnd(sessionId)
    const kind = event.data?.reason?.kind
    if (!config.turnEnd.reasons.includes(kind)) return
    if (!isRootSession(session)) return
    const entry = state.get(sessionId)
    const startMs = entry?.startMs
    const usedTools = entry?.usedTools === true
    // requireTools：这一轮没碰工具 = 在陪聊，不是任务，静默跳过
    if (config.turnEnd.requireTools !== false && !usedTools) {
      state.delete(sessionId)
      return
    }
    // sources：只给这些来源发起的轮次发通知（定时任务/QQ桥/B站插件等自动轮次静默）。
    // 来源不可知（headless、老会话）时放行，避免静默掉真通知。
    const sources = config.turnEnd.sources
    const owner = ownerSource.get(sessionId)
    if (Array.isArray(sources) && sources.length > 0 && typeof owner === 'string' && !sources.includes(owner)) {
      state.delete(sessionId)
      return
    }
    // 任务还在跑（后台 job 没结束 / goal 还 active）：这不是「完成」，静默等它真的收尾
    if (typeof isSessionBusy === 'function' && isSessionBusy(session)) {
      state.delete(sessionId)
      return
    }
    const duration = typeof startMs === 'number' ? formatDuration(event.time - startMs) : ''
    const timer = ctx.timeout(() => {
      state.delete(sessionId)
      // minIntervalMs：同一会话两次通知之间的最小间隔（任务收尾后又被追着问，不再连弹）
      const minInterval = config.turnEnd.minIntervalMs ?? 0
      const last = lastSentAt.get(sessionId)
      if (minInterval > 0 && typeof last === 'number' && Date.now() - last < minInterval) return
      lastSentAt.set(sessionId, Date.now())
      // 运行窗口内攒下的待确认：在这里消费，随这条通知一起报出去（关掉 reportPending 则只清零不显示）
      const held = turnTracker?.takeHeld(sessionId) ?? null
      const note = config.turnEnd.reportPending === false ? '' : pendingNote(held)
      notify('turn-end', { kind, duration, session, note })
    }, config.turnEnd.cooldownMs)
    state.set(sessionId, { startMs, timer, kind, duration, session, usedTools })
  })
  return () => {
    listener()
    for (const entry of state.values()) {
      entry.timer?.()
      // dispose 补发：冷却窗口定时器被取消后，有待发数据的条目直接补发
      //（进程退出前最后一次机会；窗口内已被新 turn/start 取消的条目无 kind，自然跳过）
      if (entry.kind !== undefined) {
        const held = turnTracker?.takeHeld(entry.session?.id) ?? null
        const note = config.turnEnd.reportPending === false ? '' : pendingNote(held)
        notify('turn-end', { kind: entry.kind, duration: entry.duration, session: entry.session, note })
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
 *   turnEnd?: { quietDuringTurn?: boolean },
 *   rootOnly: boolean,
 * }} config - 插件配置。
 * @param {{
 *   notify: (kind: string, detail: Record<string, unknown>, options?: { priority?: boolean }) => void,
 *   isRootSession: (session: unknown) => boolean,
 *   hasWebLayer: () => boolean,
 *   turnTracker?: ReturnType<typeof createTurnTracker>,
 * }} deps
 * @returns {() => void} 合并 disposer。
 */
export function installConfirmationTrigger(ctx, config, { notify, isRootSession, hasWebLayer, turnTracker }) {
  const { confirmation } = config
  const pending = new Map() // sessionId -> { items: Map<key, summary>, timer, askedAt, session }
  // key -> { timer, summary, session }：已发出 approval/asked、还在等回声判定的条目。
  // 自动放行的审批会在同一个 tick 里补上 approval/decided，靠这个窗口把它们筛掉。
  const echo = new Map()

  /**
   * 「这一轮还在跑，先别弹」的裁决 —— **只给确认超时升级用**。
   *
   * 为什么不再拦首次确认：`approval/asked` 的噪音已经被 `smartApproval` 的沉默判定解决了
   * （自动放行的根本不发），剩下能走到这里的都是「真的在等人」——拦了就是漏报。
   * 只有「等了很久还没人管」的升级通知，才算可以攒到收尾一起说。
   * @param {string} sessionId - 会话 id。
   * @param {string} summary - 待确认摘要。
   * @returns {boolean} true = 已吞下，调用方直接 return。
   */
  function swallowWhileRunning(sessionId, summary) {
    if (turnTracker === undefined) return false
    if (config.turnEnd?.quietDuringTurn === false) return false
    return turnTracker.hold(sessionId, summary)
  }

  /**
   * 发一条「需要人工确认」并登记挂起项。
   * @param {string} sessionId - 会话 id。
   * @param {string} key - 挂起键（`approval:<id>` / `tool:<callId>`）。
   * @param {string} summary - 摘要。
   * @param {unknown} session - 会话对象。
   * @param {string} [text] - 覆盖通知正文（拒绝/取消这类要带上结果）。
   */
  function announce(sessionId, key, summary, session, text) {
    addPending(sessionId, key, summary, session)
    notify('confirmation', { text: text ?? summary, session })
  }

  /** 发出升级通知并清掉该会话的挂起表（超时触发与 dispose 补发共用）。 */
  function fireEscalation(sessionId, entry) {
    const first = [...entry.items.values()][0] ?? ''
    const waitMs = typeof entry.askedAt === 'number' ? Date.now() - entry.askedAt : undefined
    pending.delete(sessionId)
    // 这一轮还在跑：升级先攒着，收尾时一并说（reportPending 决定报不报条数）
    if (swallowWhileRunning(sessionId, first)) return
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
      const key = `approval:${id}`
      const summary = `${toolName ?? ''}${reason ? `：${reason}` : ''}`

      // smartApproval：先静一小会儿等回声，再决定发不发。
      // 依据是本机 dsh-purge 的 approval bypass 直接 `return 'allowed-once'`，
      // asked 与 decided 在同一个 tick 里接踵而至；人真的去点不可能这么快。
      const waitMs = Number(confirmation.smartApprovalWaitMs ?? 1000)
      if (confirmation.smartApproval === false || !(waitMs > 0)) {
        announce(sessionId, key, summary, session)
        return
      }
      echo.get(key)?.timer?.() // 同一个 id 重放：先撤掉旧的
      const timer = ctx.timeout(() => {
        echo.delete(key)
        // 等到点了还没人决定 = 真的挂在那儿等人
        announce(sessionId, key, summary, session)
      }, waitMs)
      echo.set(key, { timer, summary, session })
      return
    }

    if (event.type === 'approval/decided') {
      const key = `approval:${event.data?.id}`
      const outcome = event.data?.outcome
      const waiting = echo.get(key)
      if (waiting !== undefined) {
        // 回声到了：说明它在沉默窗口内就被决定了 —— 自动放行，不值得弹
        waiting.timer?.()
        echo.delete(key)
        if (outcome !== 'allowed-once') {
          // 没被放行（拒绝/取消/不可用）不是噪音：这一步没做成，得说一声
          notify('confirmation', {
            text: `${waiting.summary}（${DECIDED_LABELS[outcome] ?? '未放行'}）`,
            session,
          })
        }
        return
      }
      const entry = pending.get(sessionId)
      const existed = entry?.items.has(key) ?? false
      removePending(sessionId, key)
      if (existed && confirmation.notifyDecided) {
        notify('decided', { text: DECIDED_LABELS[outcome] ?? '确认结束', session })
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
      // 提问**不吞**：问出口的这一轮就卡在这儿等人回话，不会再自己往下跑。
      // 吞掉等于「有事找你但一声不吭」，比多弹一条严重得多——它必须穿透运行窗口。
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
    // dispose 时还在沉默窗口里等的审批：进程要走了，判定没意义——
    // 还没等到 decided 就当它是「真的在等人」，说一声更安全
    for (const [key, waiting] of echo) {
      waiting.timer?.()
      notify('confirmation', { text: waiting.summary, session: waiting.session })
      void key
    }
    echo.clear()
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
