// dsh-notify HTTP 通道 —— 零依赖（仅 node 内置 fetch）。
// QQ 机器人(OneBot)/serverchan/钉钉/企微/ntfy 都是同一通道的不同 endpoint 配置。
// 契约：
// - url/headers/body 全量模板渲染（{{title}} {{reason}} {{text}} {{duration}} {{timestamp}}）；
// - 密钥占位符 ${env:XXX} 从环境变量读取（不落明文），${credential:REF} 可选走 dsh credentials 服务；
// - 超时 + 非 2xx/网络错误分类：5xx/429/网络错误可重试，其余 4xx 直接判败走备用通道；
// - 残留未解析占位符在发送时报错（fail loud at send，由队列降级处理）。

import { render, renderDeep } from '../templates.js'

const ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const CREDENTIAL_PATTERN = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g
const LEFTOVER_PATTERN = /\$\{[^{}]*\}/

/**
 * 解析字符串里的密钥占位符：${env:XXX} 同步替换；${credential:REF} 经 credentials.resolve 异步解析。
 * 解析不到的占位符抛错（发送前失败，好过把占位符原文发给对方）。
 * @param {string} text - 含占位符的字符串。
 * @param {{ env?: Record<string, string>, getCredentials?: () => { resolve: (ref: string) => Promise<{ value: string } | undefined> } | undefined }} deps
 *   env 环境变量表（默认 process.env）；getCredentials 惰性取 dsh credentials 服务（可选）。
 * @returns {Promise<string>} 解析后的字符串。
 */
export async function resolveSecrets(text, { env = process.env, getCredentials } = {}) {
  if (typeof text !== 'string') return text
  let out = text.replace(ENV_PATTERN, (match, name) => {
    const value = env?.[name]
    if (value === undefined || value === '') throw new Error(`notify: 环境变量 ${name} 未设置，无法解析 ${match}`)
    return value
  })
  const refs = []
  let match
  while ((match = CREDENTIAL_PATTERN.exec(out)) !== null) {
    refs.push({ index: match.index, text: match[0], ref: match[1] })
  }
  if (refs.length > 0) {
    const credentials = typeof getCredentials === 'function' ? getCredentials() : undefined
    if (credentials === undefined) {
      throw new Error('notify: 配置使用了 ${credential:...} 但 dsh 未提供 credentials 服务')
    }
    for (const { index, text, ref } of refs.reverse()) { // 从后往前替换，避免索引漂移
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined) throw new Error(`notify: credential 引用 ${ref} 未配置`)
      out = out.slice(0, index) + resolved.value + out.slice(index + text.length)
    }
  }
  if (LEFTOVER_PATTERN.test(out)) {
    throw new Error(`notify: 存在无法解析的占位符：${String(LEFTOVER_PATTERN.exec(out)?.[0])}`)
  }
  return out
}

/**
 * 把一条通道配置渲染成可发送的 HTTP 请求参数（模板 + 密钥解析）。
 * @param {{
 *   url: string, method?: string, headers?: Record<string, unknown>,
 *   body?: string | Record<string, unknown> | unknown[],
 * }} channel - 单条通道配置。
 * @param {Record<string, unknown>} fields - 通知字段五件套。
 * @param {Parameters<typeof resolveSecrets>[1]} deps - env / getCredentials。
 * @returns {Promise<{ url: string, method: string, headers: Record<string, string>, body: string | undefined }>}
 */
export async function prepareRequest(channel, fields, deps) {
  const url = await resolveSecrets(render(channel.url, fields), deps)
  const headers = {}
  for (const [key, value] of Object.entries(renderDeep(channel.headers ?? {}, fields))) {
    headers[key] = await resolveSecrets(value === null || value === undefined ? '' : String(value), deps)
  }
  const rendered = renderDeep(channel.body, fields)
  let body
  if (rendered === undefined || rendered === null) {
    body = undefined
  } else if (typeof rendered === 'string') {
    body = await resolveSecrets(rendered, deps)
  } else {
    // 对象/数组 body：整体序列化后再统一做密钥解析（占位符是普通字符串）
    body = await resolveSecrets(JSON.stringify(rendered), deps)
  }
  return { url, method: (channel.method ?? 'POST').toUpperCase(), headers, body }
}

/**
 * 创建一条 HTTP 通道（供队列使用）。发送失败抛错并按 retryable 分类。
 * @param {{
 *   id?: string, url: string, method?: string, headers?: Record<string, unknown>,
 *   body?: string | Record<string, unknown> | unknown[], timeoutMs?: number,
 *   retries?: number, retryBaseMs?: number,
 * }} config - 通道配置（重试参数缺省由调用方合并全局默认）。
 * @param {{ env?: Record<string, string>, getCredentials?: () => object | undefined, logger?: { warn?: (message: string) => void } }} deps
 * @returns {{ id: string, retries: number, retryBaseMs: number, send: (fields: Record<string, unknown>) => Promise<void> }}
 */
export function createHttpChannel(config, { env = process.env, getCredentials, logger } = {}) {
  return {
    id: config.id ?? 'http',
    retries: config.retries ?? 2,
    retryBaseMs: config.retryBaseMs ?? 500,
    /** 渲染 + 发送一次；失败抛错（retryable 标记决定队列是否重试/降级）。 */
    async send(fields) {
      const request = await prepareRequest(config, fields, { env, getCredentials })
      let response
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(config.timeoutMs ?? 10000),
        })
      } catch (error) {
        const wrapped = new Error(`notify: HTTP 请求失败（${config.id}）: ${error?.message ?? error}`, { cause: error })
        wrapped.retryable = true // 网络错误/超时：重试
        throw wrapped
      }
      if (!response.ok) {
        const wrapped = new Error(`notify: HTTP ${response.status} ${response.statusText}（${config.id}）`)
        wrapped.retryable = response.status === 429 || response.status >= 500 // 其余 4xx 不重试
        throw wrapped
      }
    },
  }
}
