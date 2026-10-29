// dsh-notify 网关看护 —— 本机常驻网关（toast 弹窗那种小进程）掉了就自己拉起来。
// 契约：
// - 只照看「配置里给了启动命令」且是 loopback 的 HTTP 通道；远端通道永远不碰；
// - 探活失败 + 过了冷却才拉，冷却默认 60 秒，避免拉起失败时疯狂重试；
// - 拉起的进程 detached + stdio ignore（不占管道，宿主退出也不连带杀掉）；
// - 全部依赖注入，核心逻辑 `superviseStep` 是纯函数，可离线测。

import { spawn } from 'node:child_process'

/**
 * 探一个本机网关的 /health。
 * @param {string} url - 通道的 notify 地址（会取 origin 拼 /health）。
 * @param {number} timeoutMs - 探测超时。
 * @returns {Promise<boolean>} 活着返回 true。
 */
export async function probeHealth(url, timeoutMs = 1500) {
  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return false
  }
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

/** loopback 地址才允许被看护（不给远端机器乱开进程）。 */
export function isLoopback(url) {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * 一轮看护决策（纯逻辑，不碰网络也不起进程）。
 * @param {{
 *   channels: Array<{ id: string, url?: string }>,
 *   supervisor: { enabled?: boolean, commands?: Record<string, string[]>, cooldownMs?: number },
 *   alive: (url: string) => boolean,
 *   now: number,
 *   lastLaunch: Map<string, number>,
 * }} input
 * @returns {Array<{ id: string, command: string[] }>} 这一轮该拉起的通道。
 */
export function superviseStep({ channels, supervisor, alive, now, lastLaunch }) {
  const due = []
  if (supervisor?.enabled !== true) return due
  const commands = supervisor.commands ?? {}
  const cooldown = Number.isFinite(supervisor.cooldownMs) ? supervisor.cooldownMs : 60_000
  for (const channel of Array.isArray(channels) ? channels : []) {
    const id = typeof channel?.id === 'string' ? channel.id : ''
    const command = commands[id]
    if (id === '' || !Array.isArray(command) || command.length === 0) continue
    const url = typeof channel?.url === 'string' ? channel.url : ''
    if (!isLoopback(url)) continue
    if (alive(url)) continue
    const last = lastLaunch.get(id)
    if (typeof last === 'number' && now - last < cooldown) continue
    due.push({ id, command })
  }
  return due
}

/**
 * 起一个看护循环。
 * @param {object} ctx - cordis 上下文（用 ctx.timeout 定时）。
 * @param {{
 *   getSupervisor: () => { enabled?: boolean, intervalMs?: number, cooldownMs?: number, commands?: Record<string, string[]> },
 *   getChannels: () => Array<{ id: string, url?: string }>,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 *   probe?: (url: string) => Promise<boolean>,
 *   launch?: (id: string, command: string[]) => void,
 *   now?: () => number,
 * }} deps
 * @returns {() => void} disposer。
 */
export function startGatewaySupervisor(ctx, { getSupervisor, getChannels, logger, probe = probeHealth, launch, now = () => Date.now() }) {
  const lastLaunch = new Map()
  let stopped = false
  let timer

  function schedule() {
    if (stopped) return
    const interval = Number(getSupervisor()?.intervalMs)
    const wait = Number.isFinite(interval) ? Math.max(5_000, Math.min(600_000, interval)) : 30_000
    timer = ctx.timeout(() => {
      if (stopped) return
      tick().catch(error => {
        logger?.warn?.(`notify: 网关看护出错 ${error?.message ?? error}`)
        schedule()
      })
    }, wait)
  }

  async function tick() {
    const supervisor = getSupervisor()
    if (supervisor?.enabled !== true) {
      schedule()
      return
    }
    const channels = getChannels()
    const aliveCache = new Map()
    const alive = url => {
      // 同一个 origin 的一轮里只探一次；这里地图由 async 填充，见下面并行探测
      return aliveCache.get(url) === true
    }
    // 先并行探活，再走纯逻辑决策
    const verdicts = await Promise.all((Array.isArray(channels) ? channels : []).map(async channel => {
      const url = typeof channel?.url === 'string' ? channel.url : ''
      if (!isLoopback(url)) return [url, true]
      const ok = await probe(url)
      return [url, ok]
    }))
    for (const [url, ok] of verdicts) aliveCache.set(url, ok)
    const due = superviseStep({ channels, supervisor, alive, now: now(), lastLaunch })
    for (const item of due) {
      lastLaunch.set(item.id, now())
      logger?.info?.(`notify: 网关 ${item.id} 没在跑，拉起一次`)
      if (typeof launch === 'function') launch(item.id, item.command)
      else spawnCommand(item.id, item.command, logger)
    }
    schedule()
  }

  schedule()
  return () => {
    stopped = true
    if (typeof timer === 'function') timer()
  }
}

/**
 * 默认拉起动作：隐藏窗口、不占管道。
 * 注意**不能**加 detached —— Windows 上 DETACHED_PROCESS 会让子进程没有控制台，
 * PowerShell 5.1 在这种环境下加载 WinRT（toast 通知）会直接退出，进程起来就没了。
 */
export function spawnCommand(id, command, logger) {
  try {
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore', windowsHide: true })
    child.on('error', error => logger?.warn?.(`notify: 拉起网关 ${id} 失败：${error?.message ?? error}`))
    child.unref()
  } catch (error) {
    logger?.warn?.(`notify: 拉起网关 ${id} 失败：${error?.message ?? error}`)
  }
}
