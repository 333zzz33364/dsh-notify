// dsh-notify 图标角标计数
// ---------------------------------------------------------------------------
// 数什么：任务完成（turn-end）的次数，也就是「有几轮活干完了但你还没看」。
// 谁加：index.js 的 notify() 在 turn-end 分支里调 bump()。
// 谁清：桌面壳（Electron 主进程）在窗口拿到焦点时 POST /api/dsh-notify/badge/clear；
//       没有桌面壳的部署（headless）就一直累着，反正也没人看。
// 存哪：$DSH_HOME/dsh-notify/badge.json —— 重启 DSH 不清零，只有回到窗口才清。
//
// 读盘只在启动时一次；之后内存里走，bump/clear 各写一次临时文件再改名。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './runtime-config.js'

/** 角标状态文件路径。 */
export function badgePath() {
  return join(configDir(), 'badge.json')
}

/** 从盘上读计数（坏文件当 0）。 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(badgePath(), 'utf8'))
    const count = Number.isFinite(parsed?.count) ? Math.max(0, Math.floor(parsed.count)) : 0
    const at = Number.isFinite(parsed?.at) ? parsed.at : 0
    return { count, at }
  } catch {
    return { count: 0, at: 0 }
  }
}

/**
 * 造一个角标计数器。
 * @param {{ logger?: { warn?: (m: string) => void } }} [deps]
 * @returns {{
 *   bump: () => number,
 *   clear: () => number,
 *   snapshot: () => { count: number, at: number },
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
    /** 未读 +1，返回新值。 */
    bump() {
      state = { count: state.count + 1, at: Date.now() }
      persist(state)
      return state.count
    },
    /** 清零，返回 0。 */
    clear() {
      state = { count: 0, at: Date.now() }
      persist(state)
      return 0
    },
    /** 当前计数（外壳轮询用）。 */
    snapshot() {
      return { count: state.count, at: state.at }
    },
    /** 状态文件路径（设置页显示用）。 */
    path: badgePath,
  }
}
