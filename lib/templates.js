// dsh-notify 模板渲染与消息数据构造 —— 零依赖纯函数。
// 契约：
// - 通知字段统一五件套 { title, reason, text, duration, timestamp }，缺字段渲染为空串；
// - render 支持两种占位写法：{{key}} 直接替换；{{#key}}…{{/key}} 条件段（字段为空整段丢弃，可嵌套）；
// - 条件段的「空」= undefined / null / 空字符串；数字 0 算有值（{{#duration}} 在 0 秒时保留）；
// - render 只处理字符串模板，renderDeep 递归处理对象/数组里的字符串叶子；
// - 其余 helper 供触发源与 smoke 使用，全部可独立于 cordis 运行。

/** turn/end reason.kind → 中文通知文案。可扩展：未知 kind 原样输出。 */
export const REASON_LABELS = {
  completed: '任务完成',
  error: '任务出错',
  blocked: '任务被阻塞',
  'max-tokens': '超出 token 上限',
  aborted: '任务已中止',
  interrupted: '任务中断',
}

/** 把 reason.kind 映射成通知文案；未知值原样返回，空值返回空串。 */
export function reasonLabel(kind) {
  if (kind === undefined || kind === null) return ''
  return REASON_LABELS[kind] ?? String(kind)
}

/** 变量占位符：{{key}}。 */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/** 条件段（每次匹配最左的一段，内文可再含条件段）：{{#key}}…{{/key}}，花括号内允许空白。 */
const CONDITION_PATTERN = /\{\{\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/

/** 条件段的「空」判定：undefined/null/空串为空，数字 0 与 false 都算有值。 */
function isBlank(value) {
  return value === undefined || value === null || String(value) === ''
}

/** 先剥条件段（由内向外递归），最后再做变量替换。 */
function renderBlocks(template, fields) {
  let out = template
  // 上限只为防御「字段值里又写了条件段」这类自引用模板，正常模板一轮就收敛。
  for (let guard = 0; guard < 200; guard += 1) {
    const match = CONDITION_PATTERN.exec(out)
    if (match === null) break
    const [whole, key, inner] = match
    const replacement = isBlank(fields?.[key]) ? '' : renderBlocks(inner, fields)
    out = out.slice(0, match.index) + replacement + out.slice(match.index + whole.length)
  }
  return out.replace(VARIABLE_PATTERN, (_match, key) => {
    const value = fields?.[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * 渲染模板：{{key}} 替换为字段值；{{#key}}…{{/key}} 在字段为空时整段丢弃。
 * @param {string} template - 含 {{title}} {{reason}} {{text}} {{duration}} {{timestamp}} 的模板。
 * @param {Record<string, unknown>} fields - 字段表；缺失/null 字段输出空串。
 * @returns {string} 渲染结果。非字符串输入原样返回。
 */
export function render(template, fields) {
  if (typeof template !== 'string') return template
  return renderBlocks(template, fields)
}

/**
 * 深度渲染：字符串叶子走 {@link render}，对象/数组递归，其余值原样返回。
 * 用于 url/headers/body 等通道配置的整体渲染。
 * @param {unknown} value - 任意 JSON 值。
 * @param {Record<string, unknown>} fields - 模板字段表。
 * @returns {unknown} 渲染后的同构值。
 */
export function renderDeep(value, fields) {
  if (typeof value === 'string') return render(value, fields)
  if (Array.isArray(value)) return value.map(item => renderDeep(item, fields))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = renderDeep(item, fields)
    return out
  }
  return value
}

/**
 * 把毫秒数格式化为紧凑时长字符串，如 '12s'、'3m 12s'、'1h 2m 3s'、'2d 3h 4m'。
 * @param {number} ms - 非负毫秒数；NaN/负值返回空串（模板缺字段语义）。
 * @returns {string} 时长文案。
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/**
 * 本地时区时间戳 'YYYY-MM-DD HH:mm:ss'（无依赖，不跟随进程时区以外的区域设置）。
 * @param {number} ms - Unix 毫秒时间戳，默认当前时刻。
 * @returns {string} 本地时间字符串。
 */
export function localTimestamp(ms = Date.now()) {
  const date = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 截断文本到 maxChars 字符，超长加省略号。maxChars <= 0 返回空串。
 * @param {string} text - 原文。
 * @param {number} maxChars - 上限（字符数）。
 * @returns {string} 截断结果。
 */
export function truncate(text, maxChars) {
  const source = String(text ?? '')
  if (maxChars <= 0 || source === '') return ''
  if (source.length <= maxChars) return source
  return source.slice(0, maxChars - 1) + '…'
}

/**
 * 从会话事件序列提取最近一段 assistant 纯文本正文（隐私开关打开时用）。
 * 只取 assistant/message 的 text 块，倒序遍历到字符预算耗尽为止，输出保持会话时序。
 * @param {readonly unknown[]} events - 会话事件数组（信封 { type, data }）。
 * @param {number} maxChars - 输出字符上限。
 * @returns {string} 拼接后的正文（按时间正序），超限截断。
 */
export function extractRecentText(events, maxChars) {
  if (maxChars <= 0) return ''
  const parts = []
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const blocks = event?.data?.message?.content ?? []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.join('\n').length >= maxChars) break
  }
  return truncate(parts.reverse().join('\n'), maxChars)
}

/**
 * 汇总 ask_user_question 的问题列表：首问 + 数量后缀，超长截断。
 * @param {readonly unknown[]} questions - 工具参数里的 questions 数组（元素带 question 字段或为字符串）。
 * @param {number} maxChars - 摘要字符上限。
 * @returns {string} 问题摘要；解析不出任何问题时返回空串（触发方据此静默跳过）。
 */
export function summarizeQuestions(questions, maxChars) {
  const list = Array.isArray(questions) ? questions : []
  const first = list[0]
  const text = typeof first === 'string' ? first : typeof first?.question === 'string' ? first.question : ''
  if (text === '') return ''
  const suffix = list.length > 1 ? `（共 ${list.length} 个问题）` : ''
  return truncate(text + suffix, maxChars)
}
