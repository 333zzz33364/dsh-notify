// dsh-notify A2A 通道 —— 向 A2A 协议 1.0 agent 单向发送 message/send（JSON-RPC 2.0 over POST），零依赖。
// 契约：
// - 请求：{ jsonrpc, id, method: 'message/send', params: { message: { messageId, role: 'agent', parts: [{ kind: 'text', text }] } } }；
// - messageId 与请求 id 都用 node:crypto randomUUID：接收端按 messageId 去重防重放，id 用于配对响应；
// - 文本体走 {{}} 模板渲染（默认 '【{{reason}}】{{title}}｜{{duration}}'，配置可覆盖）；agentUrl 支持模板与 ${env:} 密钥解析；
// - 响应：无 JSON-RPC error 即发送成功；result 里的 taskId/contextId（Task.id/Task.contextId 或 Message.taskId/contextId）仅作 debug 日志；
// - 单向通知：不建 SSE 流、不轮询任务结果；失败按 retryable 分类交给队列重试/降级链。

import { randomUUID } from 'node:crypto'
import { render } from '../templates.js'
import { resolveSecrets } from './http.js'
import { assertRpcResult, postRpc } from './rpc.js'

/** 默认消息模板：不含正文（与 turn-end 隐私默认一致），配置可覆盖为含 {{text}} 的模板。 */
const DEFAULT_TEMPLATE = '【{{reason}}】{{title}}｜{{duration}}'

/**
 * 创建一条 A2A 通道（供队列使用）。发送失败抛错并按 retryable 分类。
 * @param {{
 *   id?: string, agentUrl: string, template?: string, timeoutMs?: number,
 *   retries?: number, retryBaseMs?: number,
 * }} config - 通道配置（重试参数缺省由调用方合并全局默认）。
 * @param {{ getCredentials?: () => object | undefined, logger?: { debug?: (message: string) => void } }} deps
 *   getCredentials 与 HTTP 通道一致（${credential:REF} 解析用）；logger 可选。
 * @returns {{ id: string, retries: number, retryBaseMs: number, send: (fields: Record<string, unknown>) => Promise<void> }}
 */
export function createA2aChannel(config, { getCredentials, logger } = {}) {
  return {
    id: config.id ?? 'a2a',
    retries: config.retries ?? 2,
    retryBaseMs: config.retryBaseMs ?? 500,
    /** 渲染消息 → message/send；失败抛错（retryable 标记决定队列是否重试/降级）。 */
    async send(fields) {
      const url = await resolveSecrets(render(config.agentUrl, fields), { getCredentials })
      const text = render(config.template ?? DEFAULT_TEMPLATE, fields)
      const { payload } = await postRpc(url, {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: {
          message: {
            messageId: randomUUID(), // 接收端按此去重，防同一通知被重放
            role: 'agent',
            parts: [{ kind: 'text', text }],
          },
        },
      }, { timeoutMs: config.timeoutMs ?? 10_000 })
      const result = assertRpcResult(payload, `A2A ${config.id}`)
      // result 形态随服务端实现而异：Task 对象（id/contextId）或 Message（taskId/contextId），仅日志不校验
      const taskId = result?.id ?? result?.taskId
      const contextId = result?.contextId
      if (typeof logger?.debug === 'function' && (taskId !== undefined || contextId !== undefined)) {
        logger.debug(`notify: A2A ${config.id} 已受理（taskId=${taskId ?? '-'}, contextId=${contextId ?? '-'}）`)
      }
    },
  }
}
