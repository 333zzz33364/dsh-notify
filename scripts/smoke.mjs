// dsh-notify 冒烟自测：零依赖直接跑 node scripts/smoke.mjs，全部通过输出 PASS。
// 覆盖：templates.js 渲染与格式化、queue.js 并发/重试/降级/flush、http 通道配置渲染与
// 密钥解析、sapi 脚本构造、A2A 通道 message/send、MCP 通道 initialize/tools/call 握手、
// notify 工具 schema 投影与执行、triggers.js 两个触发源（用假 ctx 驱动事件与定时器，
// 含 dispose 补发语义）。

import assert from 'node:assert/strict'
import { createQueue, retryTask, sleep } from '../lib/queue.js'
import { createHttpChannel, prepareRequest, resolveSecrets } from '../lib/channels/http.js'
import { createA2aChannel } from '../lib/channels/a2a.js'
import { createMcpChannel } from '../lib/channels/mcp.js'
import { assertRpcResult, parseResponseBody } from '../lib/channels/rpc.js'
import { buildSpeechScript, encodePowerShell, estimateSpeakMs } from '../lib/channels/sapi.js'
import { createNotifyTool, zToJsonSchema } from '../lib/notify-tool.js'
import {
  extractRecentText, formatDuration, localTimestamp, reasonLabel, render, renderDeep,
  summarizeQuestions, truncate,
} from '../lib/templates.js'
import {
  askUserQuestionEnabled, installConfirmationTrigger, installTurnEndTrigger, parseQuestions,
} from '../lib/triggers.js'

let passed = 0
const failed = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed.push(name)
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}

/** 假 ctx：on 注册监听、timeout 注册可手动推进的定时器、get 返回注入服务。 */
function fakeCtx(services = {}) {
  const listeners = new Map()
  const timers = []
  const ctx = {
    services,
    get: name => services[name],
    on: (eventName, listener) => {
      const list = listeners.get(eventName) ?? []
      list.push(listener)
      listeners.set(eventName, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    emit: (eventName, ...args) => {
      for (const listener of [...(listeners.get(eventName) ?? [])]) listener(...args)
    },
    timeout: (callback, ms) => {
      const record = { at: Date.now() + ms, callback, fired: false }
      timers.push(record)
      return () => {
        record.fired = true // 取消
      }
    },
    /** 推进假时钟：到点且未取消的定时器按注册顺序触发一次。 */
    advance: ms => {
      const now = Date.now() + ms
      const due = timers.filter(t => !t.fired && t.at <= now).sort((a, b) => a.at - b.at)
      for (const record of due) {
        if (!record.fired) {
          record.fired = true
          record.callback()
        }
      }
    },
  }
  return ctx
}

const mkSession = (id, header = {}) => ({ id, header, events: [] })
const ev = (type, data, time = Date.now()) => ({ type, data, time })

await test('render：五个占位符全部替换、缺失字段空串', () => {
  const template = '{{title}}|{{reason}}|{{text}}|{{duration}}|{{timestamp}}|{{missing}}'
  const out = render(template, { title: '标题', reason: '完成', text: '', duration: 0, timestamp: '2026-01-01' })
  assert.equal(out, '标题|完成||0|2026-01-01|')
})

await test('renderDeep：对象/数组递归渲染，非字符串原样', () => {
  const out = renderDeep(
    { a: 'x{{title}}', b: ['{{reason}}', { c: '{{missing}}' }], d: 42 },
    { title: 'T', reason: 'R' },
  )
  assert.deepEqual(out, { a: 'xT', b: ['R', { c: '' }], d: 42 })
})

await test('formatDuration：紧凑时长', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(12_000), '12s')
  assert.equal(formatDuration(75_000), '1m 15s')
  assert.equal(formatDuration(3_723_000), '1h 2m 3s')
  assert.equal(formatDuration(-1), '')
  assert.equal(formatDuration(Number.NaN), '')
})

await test('localTimestamp/reasonLabel/truncate', () => {
  assert.match(localTimestamp(1_700_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(reasonLabel('completed'), '任务完成')
  assert.equal(reasonLabel('whatever'), 'whatever')
  assert.equal(truncate('你好世界', 2), '你…')
  assert.equal(truncate('短', 10), '短')
  assert.equal(truncate('x', 0), '')
})

await test('extractRecentText：只取 assistant/message 的 text 块', () => {
  const events = [
    ev('user/message', {}),
    ev('assistant/message', { message: { content: [{ type: 'text', text: '第一段' }, { type: 'thinking', text: '不该出现' }] } }),
    ev('assistant/message', { message: { content: [{ type: 'text', text: '第二段' }] } }),
    ev('tool/result', {}),
  ]
  assert.equal(extractRecentText(events, 100), '第一段\n第二段')
  assert.equal(extractRecentText(events, 2), '第…')
})

await test('summarizeQuestions/parseQuestions', () => {
  assert.equal(summarizeQuestions([{ id: 'a', question: '要删除吗？' }, { id: 'b', question: '确认？' }], 50), '要删除吗？（共 2 个问题）')
  assert.equal(summarizeQuestions(['直接字符串'], 50), '直接字符串')
  assert.equal(summarizeQuestions([], 50), '')
  assert.deepEqual(parseQuestions('{"questions":[{"id":"a","question":"q?"}]}').length, 1)
  assert.deepEqual(parseQuestions('not json'), [])
  assert.deepEqual(parseQuestions('{"questions":"nope"}'), [])
})

await test('retryTask：重试后成功 / 不可重试立即失败', async () => {
  let calls = 0
  const ok = await retryTask(async () => {
    calls += 1
    if (calls < 3) throw new Error('boom')
  }, { retries: 3, baseMs: 1 })
  assert.equal(ok, true)
  assert.equal(calls, 3)

  const bad = new Error('bad request')
  bad.retryable = false
  calls = 0
  const fail = await retryTask(async () => {
    calls += 1
    throw bad
  }, { retries: 3, baseMs: 1 })
  assert.equal(fail, false)
  assert.equal(calls, 1)
})

await test('queue：并发上限 2', async () => {
  const queue = createQueue({ concurrency: 2 })
  let active = 0
  let peak = 0
  const lane = {
    id: 'l',
    retries: 0,
    send: async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(20)
      active -= 1
    },
  }
  queue.push({ fields: {}, lanes: [lane] })
  queue.push({ fields: {}, lanes: [lane] })
  queue.push({ fields: {}, lanes: [lane] })
  queue.push({ fields: {}, lanes: [lane] })
  assert.equal(await queue.flush(2_000), 0)
  assert.ok(peak <= 2, `峰值并发 ${peak} 超过 2`)
})

await test('queue：主通道失败降级备用通道（重试耗尽后走 fallback）', async () => {
  const calls = []
  const primary = {
    id: 'primary',
    retries: 1,
    retryBaseMs: 1,
    send: async () => {
      calls.push('primary')
      throw new Error('down')
    },
  }
  const backup = {
    id: 'backup',
    retries: 0,
    send: async () => {
      calls.push('backup')
    },
  }
  const queue = createQueue({ concurrency: 1 })
  queue.push({ fields: {}, lanes: [{ ...primary, fallback: [backup] }] })
  assert.equal(await queue.flush(2_000), 0)
  assert.deepEqual(calls, ['primary', 'primary', 'backup'])
})

await test('queue：priority 任务插队', async () => {
  const order = []
  const mk = id => ({ id, retries: 0, send: async () => { await sleep(10); order.push(id) } })
  const queue = createQueue({ concurrency: 1 })
  queue.push({ fields: {}, lanes: [mk('normal-1')] })
  queue.push({ fields: {}, lanes: [mk('normal-2')] })
  queue.push({ fields: {}, lanes: [mk('urgent')] }, { priority: true })
  assert.equal(await queue.flush(2_000), 0)
  assert.deepEqual(order, ['normal-1', 'urgent', 'normal-2'])
})

await test('queue：flush 超时丢弃并计数', async () => {
  const queue = createQueue({ concurrency: 1 })
  const slow = { id: 'slow', retries: 0, send: async () => { await sleep(300) } }
  queue.push({ fields: {}, lanes: [slow] })
  queue.push({ fields: {}, lanes: [slow] })
  queue.push({ fields: {}, lanes: [slow] })
  const dropped = await queue.flush(120)
  assert.ok(dropped >= 1, '应该至少丢弃一条')
})

await test('prepareRequest：url/headers/body 模板渲染 + ${env:} 解析 + 缺环境变量报错', async () => {
  const channel = {
    url: 'https://example.com/{{title}}?key=${env:API_KEY}',
    method: 'post',
    headers: { Authorization: 'Bearer ${env:API_KEY}', 'X-Title': '{{title}}' },
    body: { title: '{{title}}', reason: '{{reason}}', n: 1 },
  }
  const req = await prepareRequest(channel, { title: '标题', reason: '完成' }, { env: { API_KEY: 'secret' } })
  assert.equal(req.url, 'https://example.com/标题?key=secret')
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer secret')
  assert.equal(req.headers['X-Title'], '标题')
  assert.deepEqual(JSON.parse(req.body), { title: '标题', reason: '完成', n: 1 })

  await assert.rejects(
    () => prepareRequest(channel, { title: 't' }, { env: {} }),
    /环境变量 API_KEY 未设置/,
  )
})

await test('resolveSecrets：残留占位符报错 / credential 引用无服务报错', async () => {
  await assert.rejects(() => resolveSecrets('x${credential:TOKEN}', {}), /credentials 服务/)
  await assert.rejects(() => resolveSecrets('x${unknown:THING}', { env: {} }), /无法解析的占位符/)
})

await test('sapi：脚本构造（zh 语音/转义）与 EncodedCommand 编码往返', () => {
  const script = buildSpeechScript("主人's 任务完成了", 'auto')
  assert.ok(script.includes('System.Speech'))
  assert.ok(script.includes("zh-*"))
  assert.ok(script.includes("主人''s 任务完成了"))
  const named = buildSpeechScript('x', 'Huihui')
  assert.ok(named.includes("-like 'Huihui'"))
  assert.equal(Buffer.from(encodePowerShell(script), 'base64').toString('utf16le'), script)
  assert.ok(estimateSpeakMs('短') >= 2_000)
  assert.equal(estimateSpeakMs('x'.repeat(10_000)), 30_000)
})

await test('http：4xx 不重试、5xx 重试（经队列）', async () => {
  let sent = 0
  const channel = createHttpChannel({
    id: 'mock',
    url: 'https://mock.invalid/{{title}}',
    retries: 2,
    retryBaseMs: 1,
    timeoutMs: 1000,
  })
  // 用假 fetch 直接测 send 的错误分类：4xx retryable=false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' })
  try {
    await assert.rejects(() => channel.send({ title: 't' }), error => error.retryable === false)
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Busy' })
    await assert.rejects(() => channel.send({ title: 't' }), error => error.retryable === true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('触发源1：turn/end 冷却去抖 + 白名单 + 根会话过滤', async () => {
  const ctx = fakeCtx()
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const isRoot = session => session.header.origin !== 'subagent'
  const dispose = installTurnEndTrigger(ctx, {
    turnEnd: { reasons: ['completed', 'error', 'blocked', 'max-tokens'], cooldownMs: 1000 },
    rootOnly: true,
  }, { notify, isRootSession: isRoot })

  const root = mkSession('s1')
  const sub = mkSession('s2', { origin: 'subagent' })
  const t0 = Date.now()
  ctx.emit('session/event', root, ev('turn/start', { turn: 1 }, t0))
  ctx.emit('session/event', root, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 60_000))
  assert.equal(got.length, 0, '冷却窗口内不应发送')
  ctx.emit('session/event', root, ev('turn/start', { turn: 2 }, t0 + 61_000))
  ctx.emit('session/event', root, ev('turn/end', { turn: 2, reason: { kind: 'aborted' } }, t0 + 62_000))
  ctx.advance(2_000)
  assert.equal(got.length, 0, 'aborted 不在默认白名单')
  ctx.emit('session/event', sub, ev('turn/start', { turn: 1 }, t0))
  ctx.emit('session/event', sub, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 5_000))
  ctx.advance(2_000)
  assert.equal(got.length, 0, 'subagent 子会话不发')
  ctx.emit('session/event', root, ev('turn/start', { turn: 3 }, t0))
  ctx.emit('session/event', root, ev('turn/end', { turn: 3, reason: { kind: 'error' } }, t0 + 30_000))
  ctx.advance(2_000)
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'turn-end')
  assert.equal(got[0].detail.kind, 'error')
  assert.equal(got[0].detail.duration, '30s')
  dispose()
})

await test('触发源2：approval asked→decided（默认静默）+ ask_user_question auto 探测', async () => {
  const ctx = fakeCtx({ webServer: {} })
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const cfg = {
    confirmation: {
      approval: true,
      askUserQuestion: 'auto',
      timeoutMs: 10_000,
      notifyDecided: false,
      questionMaxChars: 120,
    },
    rootOnly: true,
  }
  const dispose = installConfirmationTrigger(ctx, cfg, {
    notify,
    isRootSession: () => true,
    hasWebLayer: () => ctx.get('webServer') !== undefined,
  })

  const session = mkSession('s1')
  ctx.emit('session/event', session, ev('approval/asked', { id: 'a1', toolName: 'bash', reason: '需要写文件' }))
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, 'confirmation')
  assert.equal(got[0].detail.text, 'bash：需要写文件')

  ctx.emit('session/event', session, ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }))
  assert.equal(got.length, 1, 'notifyDecided=false 默认静默')

  ctx.emit('session/event', session, ev('tool/call', {
    turn: 1, step: 1, callId: 'c1', name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q', question: '要删除吗？' }] }),
  }))
  assert.equal(got.length, 2, 'auto 模式探测到 webServer 应发')
  assert.equal(got[1].detail.text, '要删除吗？')

  ctx.emit('session/event', session, ev('tool/result', {
    turn: 1, step: 1,
    message: { source: { kind: 'tool', callId: 'c1' }, content: [] },
  }))
  assert.equal(got.length, 2, 'tool/result 默认静默')
  dispose()
})

await test('触发源2：headless auto 不发 ask_user_question，on 模式强制发', async () => {
  const headlessCtx = fakeCtx({})
  const got = []
  const notify = (kind, detail) => got.push({ kind, detail })
  const cfg = {
    confirmation: { approval: true, askUserQuestion: 'auto', timeoutMs: 10_000, notifyDecided: false, questionMaxChars: 120 },
    rootOnly: true,
  }
  const dispose = installConfirmationTrigger(headlessCtx, cfg, {
    notify,
    isRootSession: () => true,
    hasWebLayer: () => headlessCtx.get('webServer') !== undefined,
  })
  const session = mkSession('s1')
  headlessCtx.emit('session/event', session, ev('tool/call', {
    turn: 1, step: 1, callId: 'c9', name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q', question: '确认？' }] }),
  }))
  assert.equal(got.length, 0, 'headless（无 webServer）auto 模式应静默')
  assert.equal(askUserQuestionEnabled({ askUserQuestion: 'on' }, () => false), true)
  assert.equal(askUserQuestionEnabled({ askUserQuestion: 'off' }, () => true), false)
  dispose()
})

await test('触发源2：确认超时升级（priority）+ 决定到达撤定时器', async () => {
  const ctx = fakeCtx({ webServer: {} })
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const cfg = {
    confirmation: { approval: true, askUserQuestion: 'auto', timeoutMs: 10_000, notifyDecided: true, questionMaxChars: 120 },
    rootOnly: true,
  }
  const dispose = installConfirmationTrigger(ctx, cfg, {
    notify,
    isRootSession: () => true,
    hasWebLayer: () => true,
  })
  const session = mkSession('s1')
  ctx.emit('session/event', session, ev('approval/asked', { id: 'a2', toolName: 'bash' }))
  ctx.advance(20_000)
  assert.equal(got.length, 2, '应发 escalation')
  assert.equal(got[1].kind, 'escalation')
  assert.equal(got[1].options.priority, true)
  // 超时后决定到达：已无挂起项，不应再发 decided
  ctx.emit('session/event', session, ev('approval/decided', { id: 'a2', outcome: 'rejected' }))
  assert.equal(got.length, 2)
  // 新确认 + 及时决定 → 发 confirmation 与 decided，且无 escalation
  ctx.emit('session/event', session, ev('approval/asked', { id: 'a3', toolName: 'write' }))
  ctx.emit('session/event', session, ev('approval/decided', { id: 'a3', outcome: 'allowed-once' }))
  assert.equal(got.length, 4)
  assert.equal(got[2].kind, 'confirmation')
  assert.equal(got[3].kind, 'decided')
  assert.equal(got[3].detail.text, '已确认')
  ctx.advance(20_000)
  assert.equal(got.length, 4, '决定后定时器应已撤销，不再升级')
  dispose()
})

await test('触发源1：turn/end 后立即 dispose 补发通知（headless 退出场景）', () => {
  const ctx = fakeCtx()
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const dispose = installTurnEndTrigger(ctx, {
    turnEnd: { reasons: ['completed', 'error', 'blocked', 'max-tokens'], cooldownMs: 60_000 },
    rootOnly: true,
  }, { notify, isRootSession: () => true })

  const root = mkSession('s1')
  const t0 = Date.now()
  ctx.emit('session/event', root, ev('turn/start', { turn: 1 }, t0))
  ctx.emit('session/event', root, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 42_000))
  assert.equal(got.length, 0, '冷却窗口（60s）内不应发送')
  dispose() // 进程退出：冷却等待无意义，必须补发
  assert.equal(got.length, 1, 'dispose 应补发待发通知')
  assert.equal(got[0].kind, 'turn-end')
  assert.equal(got[0].detail.kind, 'completed')
  assert.equal(got[0].detail.duration, '42s')
})

await test('触发源1：冷却窗口内出现新 turn/start 后 dispose 不补发', () => {
  const ctx = fakeCtx()
  const got = []
  const notify = (kind, detail) => got.push({ kind, detail })
  const dispose = installTurnEndTrigger(ctx, {
    turnEnd: { reasons: ['completed'], cooldownMs: 60_000 },
    rootOnly: true,
  }, { notify, isRootSession: () => true })

  const root = mkSession('s1')
  const t0 = Date.now()
  ctx.emit('session/event', root, ev('turn/start', { turn: 1 }, t0))
  ctx.emit('session/event', root, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, t0 + 42_000))
  ctx.emit('session/event', root, ev('turn/start', { turn: 2 }, t0 + 43_000)) // 取消待发
  dispose()
  assert.equal(got.length, 0, '待发已被新 turn/start 取消，dispose 不应补发')
})

await test('触发源2：approval 挂起未决时 dispose 补发 escalation', () => {
  const ctx = fakeCtx({ webServer: {} })
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const cfg = {
    confirmation: { approval: true, askUserQuestion: 'auto', timeoutMs: 600_000, notifyDecided: false, questionMaxChars: 120 },
    rootOnly: true,
  }
  const dispose = installConfirmationTrigger(ctx, cfg, {
    notify,
    isRootSession: () => true,
    hasWebLayer: () => true,
  })
  const session = mkSession('s1')
  ctx.emit('session/event', session, ev('approval/asked', { id: 'a9', toolName: 'write', reason: '改文件' }))
  assert.equal(got.length, 1, '首报 confirmation 已发')
  dispose() // 超时（10 分钟）未到但进程要退：补发一次升级
  assert.equal(got.length, 2)
  assert.equal(got[1].kind, 'escalation')
  assert.equal(got[1].options.priority, true)
  assert.equal(got[1].detail.text, 'write：改文件')
  assert.ok(got[1].detail.duration.length > 0)
})

await test('触发源2：dispose 补发边界（已决不补发 / timeoutMs=0 不补发）', () => {
  const ctx = fakeCtx({ webServer: {} })
  const got = []
  const notify = (kind, detail, options) => got.push({ kind, detail, options })
  const cfg = {
    confirmation: { approval: true, askUserQuestion: 'auto', timeoutMs: 600_000, notifyDecided: false, questionMaxChars: 120 },
    rootOnly: true,
  }
  const dispose = installConfirmationTrigger(ctx, cfg, {
    notify,
    isRootSession: () => true,
    hasWebLayer: () => true,
  })
  const session = mkSession('s1')
  // 已决：decided 到达后挂起表已清，dispose 不应再补发
  ctx.emit('session/event', session, ev('approval/asked', { id: 'a1', toolName: 'bash' }))
  ctx.emit('session/event', session, ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }))
  assert.equal(got.length, 1)
  dispose()
  assert.equal(got.length, 1, '已决后 dispose 不应补发 escalation')
  // timeoutMs=0（升级关闭）：挂起未决也不补发
  const ctx2 = fakeCtx({ webServer: {} })
  const got2 = []
  const dispose2 = installConfirmationTrigger(ctx2, {
    confirmation: { ...cfg.confirmation, timeoutMs: 0 },
    rootOnly: true,
  }, {
    notify: (kind, detail, options) => got2.push({ kind, detail, options }),
    isRootSession: () => true,
    hasWebLayer: () => true,
  })
  ctx2.emit('session/event', mkSession('s2'), ev('approval/asked', { id: 'b1', toolName: 'bash' }))
  dispose2()
  assert.equal(got2.length, 1, 'timeoutMs=0（升级关闭）时 dispose 只留首报，不补发 escalation')
})

await test('rpc：JSON 直解 / SSE 第一帧解析 / 无 data 帧报错', () => {
  assert.deepEqual(parseResponseBody('{"jsonrpc":"2.0","result":{"x":1}}'), { jsonrpc: '2.0', result: { x: 1 } })
  const sse = 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\r\n\r\n'
  assert.deepEqual(parseResponseBody(sse, 'text/event-stream'), { jsonrpc: '2.0', id: 1, result: { a: 1 } })
  assert.throws(() => parseResponseBody('event: message\n\n', 'text/event-stream'), /没有 data 帧/)
  assert.throws(() => parseResponseBody('not json'), SyntaxError)
})

await test('rpc：assertRpcResult JSON-RPC error 不重试 / result 原样返回', () => {
  assert.deepEqual(assertRpcResult({ result: { ok: 1 } }, 'T'), { ok: 1 })
  assert.equal(assertRpcResult({ jsonrpc: '2.0', result: 42 }, 'T'), 42)
  assert.throws(
    () => assertRpcResult({ error: { code: -32601, message: 'method not found' } }, 'T'),
    error => error.retryable === false && /JSON-RPC 错误 -32601/.test(error.message),
  )
})

/** 构造一个 mock fetch 响应对象。 */
function mockResponse(payload, { status = 200, headers = {}, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Err',
    headers: new Headers({ 'Content-Type': contentType, ...headers }),
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  }
}

await test('a2a：message/send 请求结构与模板渲染、uuid 防重放', async () => {
  const captured = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init })
    const body = JSON.parse(init.body)
    return mockResponse({ jsonrpc: '2.0', id: body.id, result: { id: 'task-1', contextId: 'ctx-1' } })
  }
  try {
    const channel = createA2aChannel(
      { id: 'a2a1', agentUrl: 'https://agent.example/message?topic={{title}}', template: '【{{reason}}】{{title}}' },
      { logger: { debug: () => {} } },
    )
    await channel.send({ title: '任务A', reason: '任务完成', duration: '1m' })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, 'https://agent.example/message?topic=任务A')
  assert.equal(captured[0].init.method, 'POST')
  assert.equal(captured[0].init.headers['Content-Type'], 'application/json')
  assert.ok(captured[0].init.headers.Accept.includes('text/event-stream'))
  const body = JSON.parse(captured[0].init.body)
  assert.equal(body.jsonrpc, '2.0')
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(body.method, 'message/send')
  assert.equal(body.params.message.role, 'agent')
  assert.match(body.params.message.messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.deepEqual(body.params.message.parts, [{ kind: 'text', text: '【任务完成】任务A' }])
})

await test('a2a：JSON-RPC error 不重试、5xx 可重试（经队列）', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    return mockResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } })
  }
  const channel = createA2aChannel({ id: 'a2a2', agentUrl: 'https://agent.example/', retries: 1, retryBaseMs: 1 })
  try {
    await assert.rejects(() => channel.send({ title: 't' }), error => error.retryable === false)
  } finally {
    globalThis.fetch = originalFetch
  }
  globalThis.fetch = async () => mockResponse('{}', { status: 503 })
  try {
    await assert.rejects(() => channel.send({ title: 't' }), error => error.retryable === true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('mcp：initialize 握手 + 会话头缓存 + tools/call（只握手一次）', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    calls.push(init)
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') {
      return mockResponse(
        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } },
        { headers: { 'mcp-session-id': 'sess-1' } },
      )
    }
    if (body.method === 'notifications/initialized') {
      return mockResponse({ jsonrpc: '2.0' })
    }
    if (body.method === 'tools/call') {
      return mockResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  try {
    const channel = createMcpChannel(
      { id: 'mcp1', url: 'https://mcp.example/rpc', tool: 'send', arguments: { text: '【{{reason}}】{{title}}' } },
      { logger: { warn: () => {}, debug: () => {} } },
    )
    await channel.send({ title: 'T', reason: '任务完成' })
    assert.equal(calls.length, 3, '第一次 send = initialize + initialized + tools/call')
    const init = JSON.parse(calls[0].body)
    assert.equal(init.method, 'initialize')
    assert.equal(init.params.protocolVersion, '2025-03-26')
    assert.equal(JSON.parse(calls[1].body).method, 'notifications/initialized')
    const call = JSON.parse(calls[2].body)
    assert.equal(call.method, 'tools/call')
    assert.deepEqual(call.params, { name: 'send', arguments: { text: '【任务完成】T' } })
    assert.equal(calls[2].headers['mcp-session-id'], 'sess-1')
    // 第二次 send：握手缓存，不再 initialize
    await channel.send({ title: 'T2', reason: '任务出错' })
    assert.equal(calls.length, 4)
    assert.equal(JSON.parse(calls[3].body).method, 'tools/call')
  } finally {
    globalThis.fetch = originalFetch
  }
})

await test('mcp：版本探测降级（2025-03-26 被拒 → 2024-11-05）+ SSE 响应解析', async () => {
  const versions = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') {
      versions.push(body.params.protocolVersion)
      if (body.params.protocolVersion === '2025-03-26') {
        return mockResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unsupported protocol version' } })
      }
      return mockResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } })
    }
    if (body.method === 'notifications/initialized') return mockResponse({ jsonrpc: '2.0' })
    if (body.method === 'tools/call') {
      // SSE 形态响应：streamable-http 服务器可能以 text/event-stream 返回
      const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'delivered' }] } })}\n\n`
      return mockResponse(payload, { contentType: 'text/event-stream' })
    }
    throw new Error(`unexpected method ${body.method}`)
  }
  try {
    const channel = createMcpChannel(
      { id: 'mcp2', url: 'https://mcp.example/rpc', tool: 'send' },
      { logger: { warn: () => {}, debug: () => {} } },
    )
    await channel.send({ title: 'T' })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(versions, ['2025-03-26', '2024-11-05'], '先试新版本，被拒后降级旧版本')
})

await test('mcp：工具 isError 视为失败不重试', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'initialize') return mockResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } })
    if (body.method === 'notifications/initialized') return mockResponse({ jsonrpc: '2.0' })
    if (body.method === 'tools/call') return mockResponse({ jsonrpc: '2.0', id: body.id, result: { content: [], isError: true } })
    throw new Error(`unexpected method ${body.method}`)
  }
  try {
    const channel = createMcpChannel({ id: 'mcp3', url: 'https://mcp.example/rpc', tool: 'send' })
    await assert.rejects(() => channel.send({ title: 'T' }), error => error.retryable === false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** 构造一个「z 对象」形状的参数 schema（type/dict/meta 与 schemastery 运行时结构一致，供零依赖测试）。 */
function fakeParams() {
  const schema = args => {
    const { message, channel, priority } = args ?? {}
    if (typeof message !== 'string' || message === '') throw new Error('message 必填')
    if (channel !== undefined && typeof channel !== 'string') throw new Error('channel 应为字符串')
    if (priority !== undefined && typeof priority !== 'boolean') throw new Error('priority 应为布尔')
    return { message, channel, priority }
  }
  Object.assign(schema, {
    type: 'object',
    meta: { description: 'notify 工具参数' },
    dict: {
      message: { type: 'string', meta: { required: true, description: '通知正文' } },
      channel: { type: 'string', meta: { description: '定向通道 id' } },
      priority: { type: 'boolean', meta: {} },
    },
  })
  return schema
}

await test('notify-tool：z 对象 → JSON Schema 子集投影（required/description）', () => {
  assert.deepEqual(zToJsonSchema(fakeParams()), {
    type: 'object',
    description: 'notify 工具参数',
    properties: {
      message: { type: 'string', description: '通知正文' },
      channel: { type: 'string', description: '定向通道 id' },
      priority: { type: 'boolean' },
    },
    required: ['message'],
  })
  assert.throws(() => zToJsonSchema({ type: 'number' }), /不受支持/)
})

await test('notify-tool：execute 校验参数并入队，子会话静默，缺 message 报错', async () => {
  const got = []
  const tool = createNotifyTool({
    params: fakeParams(),
    notify: (message, channel, priority, session) => {
      got.push({ message, channel, priority, session })
      return true
    },
    sessionOf: exec => exec?.agent?.session,
    isRootSession: session => session.header?.origin !== 'subagent',
  })
  assert.equal(tool.name, 'notify')
  assert.equal(tool.parameters.required[0], 'message')
  assert.deepEqual(tool.output.render({}, { sent: true }), [{ type: 'text', text: '通知已发送' }])

  const root = { id: 's1', header: {} }
  const out = await tool.execute({ message: '主人，任务完成了', channel: 'ntfy', priority: true }, { agent: { session: root } })
  assert.deepEqual(out, { sent: true })
  assert.deepEqual(got, [{ message: '主人，任务完成了', channel: 'ntfy', priority: true, session: root }])

  const sub = { id: 's2', header: { origin: 'subagent' } }
  assert.deepEqual(await tool.execute({ message: 'x' }, { agent: { session: sub } }), { sent: false })
  assert.equal(got.length, 1, '子会话不发送')

  await assert.rejects(() => tool.execute({}, { agent: { session: root } }), /message 必填/)
})

console.log('')
if (failed.length > 0) {
  console.error(`FAILED ${failed.length} 项: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`PASS: ${passed} 项冒烟全部通过`)
