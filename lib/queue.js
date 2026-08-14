// dsh-notify 发送队列 —— 零依赖。
// 契约：
// - 并发上限：同时最多 concurrency 个任务在途；
// - 每个任务含若干「通道链」（lane）：主通道 + fallback 备用链，逐个尝试，首个成功即止；
// - 单通道失败按指数退避重试（error.retryable === false 时不再重试，直接走备用）；
// - push(job, { priority })：priority 任务插队（确认超时升级用）；
// - flush(capMs)：dispose 时清空队列，最多等待 capMs，超时丢弃剩余任务并计数返回。

/** 睡 ms 毫秒；供退避与 flush 轮询使用。 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带指数退避的任务执行：fn 抛错后按 baseMs * factor^attempt 等待重试。
 * @param {() => Promise<unknown>} fn - 待执行任务。
 * @param {{ retries?: number, baseMs?: number, factor?: number, onFail?: (error: Error, attempt: number) => void }} options
 *   retries 为最大重试次数（不含首次）；baseMs 首次退避毫秒；factor 退避倍增系数。
 * @returns {Promise<boolean>} 成功 true；重试耗尽或遇不可重试错误（error.retryable === false）false。
 */
export async function retryTask(fn, { retries = 2, baseMs = 500, factor = 2, onFail } = {}) {
  let attempt = 0
  for (;;) {
    try {
      await fn()
      return true
    } catch (error) {
      attempt += 1
      onFail?.(error, attempt)
      if (attempt > retries || error?.retryable === false) return false
      await sleep(baseMs * factor ** (attempt - 1))
    }
  }
}

/**
 * 创建发送队列。
 * @param {{ concurrency?: number, logger?: { warn?: (message: string) => void } }} options
 *   concurrency 并发上限（默认 2）；logger 可选，失败告警走它（缺省 console.warn）。
 * @returns {{
 *   push: (job: { fields: Record<string, unknown>, lanes: Array<{
 *     id: string, send: (fields: Record<string, unknown>) => Promise<unknown>,
 *     retries?: number, retryBaseMs?: number, fallback?: Array<object>
 *   }> }, options?: { priority?: boolean }) => boolean,
 *   flush: (capMs: number) => Promise<number>,
 *   size: number,
 * }}
 */
export function createQueue({ concurrency = 2, logger } = {}) {
  const normal = []
  const urgent = []
  let active = 0
  let closed = false
  const warn = message => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }

  /** 执行一条通道链：主通道 → fallback 备用，逐个重试，首个成功即止。 */
  async function runLane(lane, fields) {
    const order = [lane, ...(Array.isArray(lane.fallback) ? lane.fallback : [])]
    for (const channel of order) {
      const ok = await retryTask(
        () => channel.send(fields),
        {
          retries: channel.retries ?? 2,
          baseMs: channel.retryBaseMs ?? 500,
          onFail: (error, attempt) => {
            warn(`notify: 通道 ${channel.id} 第 ${attempt} 次发送失败: ${error?.message ?? error}`)
          },
        },
      )
      if (ok) return
    }
    warn(`notify: 通道链 ${order.map(channel => channel.id).join(' → ')} 全部失败`)
  }

  /** 执行一个任务：所有通道链并行（如多个端点同时通知），互不阻塞。 */
  async function runJob(job) {
    await Promise.all(job.lanes.map(lane => runLane(lane, job.fields)))
  }

  /** 按并发上限拉取任务；任务结束时回收名额并继续。flush 关闸后仍继续拉取（只拒新入队）。 */
  function pump() {
    while (active < concurrency) {
      const job = urgent.shift() ?? normal.shift()
      if (job === undefined) return
      active += 1
      runJob(job)
        .catch(() => {})
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }

  /**
   * 入队。closed 后（flush 已开始）返回 false 并丢弃。
   * @param {object} job - { fields, lanes }。
   * @param {{ priority?: boolean }} options - priority: true 时插队（升级通知）。
   * @returns {boolean} 是否受理。
   */
  function push(job, { priority = false } = {}) {
    if (closed || !Array.isArray(job?.lanes) || job.lanes.length === 0) return false
    ;(priority ? urgent : normal).push(job)
    pump()
    return true
  }

  /**
   * 关闭入口并清空队列（dispose flush）：不再受理新任务，等待在途与排队任务完成。
   * @param {number} capMs - 最大等待毫秒；超时丢弃剩余任务。
   * @returns {Promise<number>} 丢弃的任务数（0 表示全部发完）。
   */
  async function flush(capMs) {
    if (closed) return normal.length + urgent.length
    closed = true
    const deadline = Date.now() + capMs
    while ((active > 0 || normal.length > 0 || urgent.length > 0) && Date.now() < deadline) {
      pump()
      await sleep(20)
    }
    const dropped = normal.length + urgent.length
    normal.length = 0
    urgent.length = 0
    if (dropped > 0) warn(`notify: dispose flush 超时，丢弃 ${dropped} 条待发通知`)
    return dropped
  }

  return {
    push,
    flush,
    get size() {
      return normal.length + urgent.length + active
    },
  }
}
