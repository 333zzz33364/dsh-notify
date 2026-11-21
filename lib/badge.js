// 图标角标计数（未读完成数）
// ---------------------------------------------------------------------------
// 数什么：任务完成（turn-end）的次数，再加上设置页「发一条测试通知」那一下（原因记 test）。
// 谁加：index.js 的 notify() 在 turn-end 分支里调 bump(reason)；sendTest() 调 bump('test')。
// 谁清：两种都有人管 ——
//   ① 客户端（lib/client.js）：窗口重新可见 / 从别处点回窗口时 POST /api/dsh-notify/badge/clear，
//      在徽章上点一下也清；
//   ② 桌面壳（resources/app.asar 里的 lib/main.js，本机补丁）：每 1 秒读一次 badge.json 画到
//      任务栏图标上，窗口在眼前露脸 3 秒、或者 focus 事件一来（点图标回来）就请宿主清零。
//      诊断日志在 $DSH_HOME/dsh-notify/shell-badge.log。
// 存哪：$DSH_HOME/dsh-notify/badge.json —— 重启 DSH 不清零，只有回到窗口才清。
// 字段：count 未读数 / at 最后一条的时间 / lastReason 最后一条的原因 / epoch 写盘序号。
//       epoch 只增不减，客户端拿它判断「这期间有没有新东西」，省掉一次深比较。
// 兼容：老文件只有 { count, at }，缺的字段按空值补齐，不报错也不丢数。
// 读盘只在启动时一次；之后内存里走，bump/clear 各写一次临时文件再改名。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './runtime-config.js'

/** 角标状态文件路径。 */
export function badgePath() {
  return join(configDir(), 'badge.json')
}

/** 任意来源的对象 → 干净的角标状态（缺字段按默认值补）。 */
function normalize(raw) {
  const count = Number.isFinite(raw?.count) ? Math.max(0, Math.floor(raw.count)) : 0
  const at = Number.isFinite(raw?.at) ? raw.at : 0
  const lastReason = typeof raw?.lastReason === 'string' ? raw.lastReason.slice(0, 32) : ''
  const epoch = Number.isFinite(raw?.epoch) ? Math.max(0, Math.floor(raw.epoch)) : 0
  return { count, at, lastReason, epoch }
}

/** 从盘上读计数（坏文件当 0）。 */
function readState() {
  try {
    return normalize(JSON.parse(readFileSync(badgePath(), 'utf8')))
  } catch {
    return normalize(undefined)
  }
}

/**
 * 造一个角标计数器。
 * @param {{ logger?: { warn?: (m: string) => void } }} [deps]
 * @returns {{
 *   bump: (reason?: string) => number,
 *   clear: () => number,
 *   snapshot: () => { count: number, at: number, lastReason: string, epoch: number },
 *   path: () => string,
 * }}
 */
export function createBadgeStore({ logger } = {}) {
  let state = readState()

  function persist(next) {
    try {
      mkdirSync(configDir(), { recursive: true })
      const target = badgePath()
      const temp = `${target}.tmp`
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      renameSync(temp, target)
    } catch (error) {
      // 写不了盘不该把通知本身弄挂：内存里的数照常涨
      if (typeof logger?.warn === 'function') {
        logger.warn(`notify: 角标计数写盘失败 ${error?.message ?? error}`)
      }
    }
  }

  return {
    /**
     * 未读 +1，返回新值。
     * @param {string} [reason] - 这一条的原因（completed / error / blocked / max-tokens）。
     */
    bump(reason) {
      state = {
        count: state.count + 1,
        at: Date.now(),
        lastReason: typeof reason === 'string' ? reason.slice(0, 32) : '',
        epoch: state.epoch + 1,
      }
      persist(state)
      return state.count
    },
    /** 清零，返回 0。epoch 照涨：清过了也是一次变化，客户端要知道。 */
    clear() {
      state = { count: 0, at: state.at, lastReason: '', epoch: state.epoch + 1 }
      persist(state)
      return 0
    },
    /** 当前计数（客户端轮询 / 设置页显示用）。 */
    snapshot() {
      return { ...state }
    },
    /** 状态文件路径（设置页显示用）。 */
    path: badgePath,
  }
}
