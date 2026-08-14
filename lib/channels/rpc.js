// dsh-notify JSON-RPC 2.0 over POST 传输助手 —— A2A / MCP 两通道共用，零依赖。
// 契约：
// - postRpc：POST JSON-RPC 载荷 + 超时；Accept 声明 application/json 优先、text/event-stream 兼容；
//   返回 { payload, sessionId }，sessionId 来自 mcp-session-id 响应头（streamable-http 会话缓存）；
// - 网络错误/超时/5xx/429 → retryable=true；其余 4xx → retryable=false；响应体解析失败 → retryable=true；
// - parseResponseBody：application/json 直接解析；text/event-stream 按 SSE 解析，只取第一帧的 data 行
//   （JSON-RPC 请求的响应落在首帧，最小实现，不做多帧流式消费）；
// - assertRpcResult：JSON-RPC error 存在时抛 retryable=false（服务器明确拒绝，重试无意义）。

/**
 * 解析 JSON-RPC 响应体：JSON 直解；SSE 取第一帧 data 行合并解析。
 * @param {string} bodyText - 响应体原文。
 * @param {string} [contentType] - 响应 Content-Type。
 * @returns {unknown} 解析后的 JSON-RPC 消息（对象）。
 */
export function parseResponseBody(bodyText, contentType = '') {
  if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
    for (const frame of String(bodyText).split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trimStart())
        .join('\n')
      if (data !== '') return JSON.parse(data)
    }
    throw new Error('SSE 响应中没有 data 帧')
  }
  return JSON.parse(bodyText)
}

/**
 * POST 一条 JSON-RPC 请求。失败抛错并按 retryable 分类（供队列重试/降级）。
 * @param {string} url - 端点地址（已渲染/解析完的最终 URL）。
 * @param {unknown} payload - JSON-RPC 消息（对象，含 jsonrpc/method）。
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options] - 额外请求头与超时。
 * @returns {Promise<{ payload: unknown, sessionId: string | null }>}
 */
export async function postRpc(url, payload, { headers = {}, timeoutMs = 10_000 } = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const wrapped = new Error(`notify: RPC 请求失败: ${error?.message ?? error}`, { cause: error })
    wrapped.retryable = true // 网络错误/超时：重试
    throw wrapped
  }
  const sessionId = response.headers.get('mcp-session-id')
  if (!response.ok) {
    const wrapped = new Error(`notify: RPC HTTP ${response.status} ${response.statusText}`)
    wrapped.retryable = response.status === 429 || response.status >= 500 // 其余 4xx 不重试
    throw wrapped
  }
  let bodyText
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  let parsed
  try {
    parsed = parseResponseBody(bodyText, response.headers.get('content-type'))
  } catch (error) {
    const wrapped = new Error(`notify: RPC 响应解析失败: ${error?.message ?? error}`, { cause: error })
    wrapped.retryable = true // 响应体损坏可能是中间链路问题：重试
    throw wrapped
  }
  return { payload: parsed, sessionId }
}

/**
 * 检查 JSON-RPC error：存在则抛 retryable=false；否则返回 result。
 * @param {unknown} payload - postRpc 返回的 payload。
 * @param {string} label - 通道标识（错误文案用）。
 * @returns {unknown} JSON-RPC result 值。
 */
export function assertRpcResult(payload, label) {
  const error = payload?.error
  if (error !== undefined && error !== null) {
    const wrapped = new Error(
      `notify: ${label} JSON-RPC 错误 ${error.code ?? ''}: ${error.message ?? 'unknown'}`,
    )
    wrapped.retryable = false // 服务器明确拒绝：重试无意义
    throw wrapped
  }
  return payload?.result
}
