// dsh-notify MCP 通道 —— streamable-http MCP server 的通知桥：initialize 握手一次 + 每次通知 tools/call，零依赖。
// 契约：
// - 握手（惰性，第一次 send 时执行，成功缓存）：POST initialize，协议版本先试 2025-03-26、被拒再试 2024-11-05；
//   服务器接受的版本以响应为准；响应头的 mcp-session-id 缓存并随后续请求回传；随后补发 notifications/initialized
//   单向通知（best-effort，失败忽略）；两个版本都被拒 → 抛错交队列重试/降级（fail-soft，不阻塞主流程）；
// - 每次通知：POST tools/call { name: config.tool, arguments: 渲染后的参数 }；result.isError 视为失败（不重试）；
// - 响应可能为 application/json 或 SSE（text/event-stream）：由 rpc.js 按内容类型解析，SSE 只取第一帧结果；
// - 握手失败后 initialized 保持 false，下次 send 会重新握手（自愈）。

import { randomUUID } from 'node:crypto'
import { render, renderDeep } from '../templates.js'
import { resolveSecrets } from './http.js'
import { assertRpcResult, postRpc } from './rpc.js'

/** 探测顺序：新版本优先，被拒退旧版本。 */
const PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05']

/** 默认工具参数模板：通知字段五件套渲染成 text（配置可整体覆盖 arguments）。 */
const DEFAULT_ARGUMENTS = { text: '【{{reason}}】{{title}}｜{{duration}}' }

/**
 * 创建一条 MCP 通道（供队列使用）。发送失败抛错并按 retryable 分类。
 * @param {{
 *   id?: string, url: string, tool: string, arguments?: Record<string, unknown>,
 *   headers?: Record<string, unknown>, timeoutMs?: number, retries?: number, retryBaseMs?: number,
 * }} config - 通道配置（重试参数缺省由调用方合并全局默认）。
 * @param {{ getCredentials?: () => object | undefined, logger?: { warn?: (message: string) => void, debug?: (message: string) => void } }} deps
 * @returns {{ id: string, retries: number, retryBaseMs: number, send: (fields: Record<string, unknown>) => Promise<void> }}
 */
export function createMcpChannel(config, { getCredentials, logger } = {}) {
  let sessionId = undefined // mcp-session-id 响应头缓存（streamable-http 会话）
  let initialized = false // 握手成功缓存；失败保持 false，下次 send 重试握手
  const warn = message => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }

  /** 解析通道级配置请求头（{{}} 模板 + ${env:}/${credential:} 密钥）。 */
  async function resolveHeaders(fields) {
    const headers = {}
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = await resolveSecrets(
        String(value ?? ''),
        { getCredentials },
      ).then(text => render(text, fields))
    }
    return headers
  }

  /** initialize 握手：按版本顺序探测；成功后缓存并补发 initialized 通知。 */
  async function initialize(fields) {
    const url = await resolveSecrets(render(config.url, fields), { getCredentials })
    const headers = await resolveHeaders(fields)
    for (const protocolVersion of PROTOCOL_VERSIONS) {
      const response = await postRpc(url, {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'initialize',
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'dsh-notify', version: '0.1.0' },
        },
      }, { headers, timeoutMs: config.timeoutMs ?? 10_000 })
      if (response.sessionId !== null) sessionId = response.sessionId
      try {
        const result = assertRpcResult(response.payload, `MCP ${config.id}`)
        // 版本协商成功：以服务器返回版本为准，记录并补发 initialized 通知（单向，失败忽略）
        initialized = true
        try {
          await postRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
            headers: sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId },
            timeoutMs: config.timeoutMs ?? 10_000,
          })
        } catch {
          // initialized 通知失败不影响后续 tools/call（best-effort）
        }
        if (typeof logger?.debug === 'function') {
          logger.debug(`notify: MCP ${config.id} 握手成功（protocolVersion=${result?.protocolVersion ?? protocolVersion}）`)
        }
        return
      } catch (error) {
        if (error?.retryable === false) continue // 该版本被服务器拒绝：尝试更旧版本
        throw error // 网络/解析类错误：本次握手失败，交队列重试
      }
    }
    const error = new Error(`notify: MCP 通道 ${config.id} 初始化握手失败：协议版本 ${PROTOCOL_VERSIONS.join(' / ')} 均被拒绝`)
    error.retryable = true // 下次通知时重新握手（服务端升级版本后可自愈）
    throw error
  }

  return {
    id: config.id ?? 'mcp',
    retries: config.retries ?? 2,
    retryBaseMs: config.retryBaseMs ?? 500,
    /** 确保握手后调用工具；result.isError 视为失败（不重试）。 */
    async send(fields) {
      if (!initialized) await initialize(fields)
      const url = await resolveSecrets(render(config.url, fields), { getCredentials })
      const headers = await resolveHeaders(fields)
      const requestHeaders = sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId }
      const { payload, sessionId: newSessionId } = await postRpc(url, {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: { name: config.tool, arguments: renderDeep(config.arguments ?? DEFAULT_ARGUMENTS, fields) },
      }, { headers: requestHeaders, timeoutMs: config.timeoutMs ?? 10_000 })
      if (newSessionId !== null) sessionId = newSessionId
      const result = assertRpcResult(payload, `MCP ${config.id}`)
      if (result?.isError === true) {
        const error = new Error(`notify: MCP 工具 ${config.tool} 执行失败（${config.id}）`)
        error.retryable = false // 工具明确报错：重试只会重复失败
        throw error
      }
      if (sessionId === undefined) {
        warn(`notify: MCP ${config.id} 响应未携带 mcp-session-id，后续请求将不带会话头（服务器可能要求）`)
      }
    },
  }
}
