// dsh-notify 设置页的 HTTP 接口（/api/dsh-notify/*）
// ---------------------------------------------------------------------------
// 浏览器半端（lib/client.js）只做表单，真正的读写都在这里。
//   GET  /config  → 当前生效的可编辑配置 + 是否被覆盖
//   POST /config  → 写覆盖层（$DSH_HOME/dsh-notify/ui-config.json），即时生效
//   POST /reset   → 清掉覆盖层，回到 cordis.patch.yml 里写的配置
//   POST /test    → 按当前配置真发一条测试通知（弹窗 + 语音）
//   GET  /status  → 通道清单、语音可用性、文件路径

import { EDITABLE, configPath, readOverlayFile, writeOverlayFile, clearOverlayFile } from './runtime-config.js'

/** 回一个 JSON。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 读请求体（上限 256KB，够用且防呆）。 */
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 262_144) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 从活配置里摘出可编辑的那几个字段（给表单回填）。 */
function pickEditable(cfg) {
  const out = {}
  for (const path of Object.keys(EDITABLE)) {
    if (path.includes('.')) {
      const [group, key] = path.split('.')
      out[group] ??= {}
      out[group][key] = cfg[group]?.[key]
    } else {
      out[path] = cfg[path]
    }
  }
  return out
}

/**
 * 探一下本机 HTTP 通道还活着没（toast 网关这类常驻进程最容易「悄悄没了」）。
 * 只探 loopback 地址，外网/远端通道一律 skip —— 不能为了让设置页好看去打扰别人。
 */
async function probeGateways(channels) {
  const results = []
  for (const channel of Array.isArray(channels) ? channels : []) {
    const url = typeof channel?.url === 'string' ? channel.url : ''
    const id = typeof channel?.id === 'string' ? channel.id : ''
    if (url === '') continue
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      results.push({ id, url, probe: 'bad-url' })
      continue
    }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'
    if (!loopback) {
      results.push({ id, url, probe: 'remote' })
      continue
    }
    try {
      const response = await fetch(`${parsed.origin}/health`, { signal: AbortSignal.timeout(1500) })
      results.push({ id, url, probe: response.ok ? 'online' : `http-${response.status}` })
    } catch (error) {
      results.push({ id, url, probe: 'offline', hint: String(error?.message ?? error) })
    }
  }
  return results
}

/**
 * 挂上设置页接口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 * @param {{
 *   cfg: Record<string, any>,
 *   sendTest: (text: string) => number,
 *   getSapi: () => { send: (fields: Record<string, unknown>) => Promise<void> },
 *   allChannels: Map<string, { id: string }>,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 * }} deps
 */
export function installSettingsRoutes(ctx, { cfg, sendTest, getSapi, allChannels, logger }) {
  const info = message => {
    if (typeof logger?.info === 'function') logger.info(message)
  }
  const warn = message => {
    if (typeof logger?.warn === 'function') logger.warn(message)
  }

  // webServer 是可选服务：headless 部署没有它，插件不能因此加载失败。
  // ctx.inject 会在服务就绪时回调，服务消失时自动清理（同 dsh-client-modules 的用法）。
  if (typeof ctx.inject !== 'function') {
    info('notify: 上下文不支持 ctx.inject，设置页接口未挂载')
    return
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/api\/dsh-notify/, '') || '/'

    if (req.method === 'GET' && path === '/config') {
      return sendJson(res, 200, {
        ok: true,
        config: pickEditable(cfg),
        overlay: readOverlayFile(),
        file: configPath(),
      })
    }

    if (req.method === 'POST' && path === '/config') {
      const body = await readBody(req)
      const overlay = writeOverlayFile(body)
      return sendJson(res, 200, { ok: true, config: pickEditable(cfg), overlay, file: configPath() })
    }

    if (req.method === 'POST' && path === '/reset') {
      clearOverlayFile()
      return sendJson(res, 200, { ok: true, config: pickEditable(cfg), overlay: {}, file: configPath() })
    }

    if (req.method === 'POST' && path === '/test') {
      const body = await readBody(req)
      const text = typeof body.text === 'string' && body.text.trim() !== ''
        ? body.text.trim().slice(0, 200)
        : '测试通知：看到这条就说明通知链路是通的'
      const gateways = await probeGateways(cfg.http?.channels)
      const lanes = sendTest(text)
      if (lanes === 0) {
        return sendJson(res, 200, { ok: false, error: '当前没有可用通道：通道列表为空且语音关着', gateways })
      }
      const dead = gateways.filter(item => item.probe === 'offline')
      return sendJson(res, 200, {
        ok: true,
        lanes,
        text,
        gateways,
        warning: dead.length > 0
          ? `本机网关 ${dead.map(item => item.id).join('、')} 没在监听，这条发出去会失败`
          : undefined,
      })
    }

    if (req.method === 'GET' && path === '/status') {
      return sendJson(res, 200, {
        ok: true,
        channels: [...allChannels.keys()],
        sapi: { enabled: cfg.sapi.enabled === true, template: cfg.sapi.template },
        gateways: await probeGateways(cfg.http?.channels),
        overlayFile: configPath(),
        overlay: readOverlayFile(),
        hasWebLayer: true,
      })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return
      webCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/api/dsh-notify',
        handler: async (req, res) => {
          try {
            await handle(req, res)
          } catch (error) {
            warn(`notify: 设置接口出错 ${error?.message ?? error}`)
            try {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            } catch {}
          }
        },
      }), 'notify: /api/dsh-notify 路由')
      info('notify: 设置页接口已挂载 /api/dsh-notify')
    })
  } catch (error) {
    warn(`notify: 设置页接口没挂上：${error?.message ?? error}`)
  }
}
