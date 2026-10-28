// dsh-notify 运行时配置覆盖层
// ---------------------------------------------------------------------------
// 问题：这个插件的配置写在 profile 的 cordis.patch.yml 里，改一次要重启 DSH 才生效。
// 做法：设置页改的不是 patch，而是 $DSH_HOME/dsh-notify/ui-config.json；
//       apply 时算出的静态配置外面包一层 Proxy，每次读 cfg.x.y 都现取。
//       文件 mtime/size 没变就直接用上次合并结果，读盘开销可忽略。
//
// 能热生效的：turnEnd / confirmation / rootOnly / sapi / escalation（读的时候才取）
// 要重启的：http / a2a / mcp 的通道列表（通道对象在启动时就建好了）、tools.notify.enabled

import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 插件家目录：$DSH_HOME/dsh-notify。 */
export function configDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-notify')
}

/** 运行时覆盖文件路径。 */
export function configPath() {
  return join(configDir(), 'ui-config.json')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：overlay 盖在 base 上，数组整段替换。 */
function merge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (value === undefined || value === null) continue
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? merge(out[key], value) : value
  }
  return out
}

/** 数字字段的取值范围（防止设置页填出离谱值）。 */
const RANGES = {
  'turnEnd.cooldownMs': [0, 86_400_000],
  'confirmation.timeoutMs': [0, 86_400_000],
  'confirmation.questionMaxChars': [0, 2000],
  'turnEnd.textMaxChars': [0, 4000],
}

/** 设置页能改的字段白名单 —— 只有这里的键会被接受，别的原样丢弃。 */
export const EDITABLE = {
  'turnEnd.reasons': 'stringArray',
  'turnEnd.cooldownMs': 'number',
  'turnEnd.includeText': 'boolean',
  'turnEnd.textMaxChars': 'number',
  'confirmation.approval': 'boolean',
  'confirmation.askUserQuestion': 'enum:auto,on,off',
  'confirmation.timeoutMs': 'number',
  'confirmation.notifyDecided': 'boolean',
  'confirmation.includeQuestion': 'boolean',
  'confirmation.questionMaxChars': 'number',
  rootOnly: 'boolean',
  'sapi.enabled': 'boolean',
  'sapi.template': 'string',
  'sapi.voice': 'string',
  'sapi.queue': 'enum:merge,drop',
  'escalation.sapi': 'boolean',
}

function sanitizeValue(spec, value) {
  if (spec === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (spec === 'number') return Number.isFinite(value) ? value : undefined
  if (spec === 'string') {
    if (typeof value !== 'string') return undefined
    return value.length > 500 ? value.slice(0, 500) : value
  }
  if (spec === 'stringArray') {
    if (!Array.isArray(value)) return undefined
    return value.filter(item => typeof item === 'string' && item.length <= 64).slice(0, 16)
  }
  if (typeof spec === 'string' && spec.startsWith('enum:')) {
    const allowed = spec.slice(5).split(',')
    return typeof value === 'string' && allowed.includes(value) ? value : undefined
  }
  return undefined
}

/**
 * 把任意输入裁成只含白名单字段的覆盖对象（设置页 POST 上来的东西都过这一道）。
 * @param {unknown} input - 待校验对象。
 * @returns {Record<string, unknown>} 净化后的嵌套覆盖对象。
 */
export function sanitizeOverlay(input) {
  const out = {}
  if (!isPlainObject(input)) return out
  for (const [path, spec] of Object.entries(EDITABLE)) {
    const [group, key] = path.includes('.') ? path.split('.') : [null, path]
    const raw = group === null ? input[key] : (isPlainObject(input[group]) ? input[group][key] : undefined)
    if (raw === undefined) continue
    let value = sanitizeValue(spec, raw)
    if (value === undefined) continue
    const range = RANGES[path]
    if (Array.isArray(range) && typeof value === 'number') {
      value = Math.min(range[1], Math.max(range[0], value))
    }
    if (group === null) out[key] = value
    else {
      out[group] ??= {}
      out[group][key] = value
    }
  }
  return out
}

/** 读当前覆盖文件（坏文件当空对象，绝不抛）。 */
export function readOverlayFile() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 写覆盖文件（先写临时文件再改名，避免半截 JSON）。 */
export function writeOverlayFile(overlay) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const target = configPath()
  const temp = `${target}.tmp`
  writeFileSync(temp, `${JSON.stringify(sanitizeOverlay(overlay), null, 2)}\n`, 'utf8')
  renameSync(temp, target)
  return readOverlayFile()
}

/** 清空覆盖（回到 patch 里写的配置）。 */
export function clearOverlayFile() {
  const empty = {}
  writeOverlayFile(empty)
  return empty
}

/**
 * 给静态配置包一层「每次读都现合并覆盖文件」的 Proxy。
 * @param {Record<string, any>} base - withDefaults 算出来的配置。
 * @returns {Record<string, any>} 可当作普通对象用的活配置。
 */
export function createLiveConfig(base) {
  let stamp = null
  let merged = base
  function current() {
    const path = configPath()
    let next = 'missing'
    try {
      const st = statSync(path)
      next = `${st.mtimeMs}:${st.size}`
    } catch {
      next = 'missing'
    }
    if (stamp === next) return merged
    stamp = next
    merged = next === 'missing' ? base : merge(base, sanitizeOverlay(readOverlayFile()))
    return merged
  }
  return new Proxy({}, {
    get(_target, key) {
      return current()[key]
    },
    has(_target, key) {
      return key in current()
    },
    ownKeys() {
      return Reflect.ownKeys(current())
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(current(), key)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
  })
}
