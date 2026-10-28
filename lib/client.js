/**
 * dsh-notify —— 浏览器半端：设置里的「任务通知」一页
 * ============================================================================
 * 约定（抄 dsh-bili-subagent / dsh-meme 的做法）：
 *   · client bundle 不是 ESM，是自注册脚本：
 *       window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *     id 必须等于 package.json 的 name，否则加载器报 "loaded without registering"。
 *   · 进「设置」靠 settings.section 插槽：
 *       slots.inject('settings.section', () => slots.register({ name: 'settings.section', id, order, label }, () => h(Panel)))
 *   · 真正的读写走宿主 /api/dsh-notify/*（lib/settings-api.js）：
 *     改的是 $DSH_HOME/dsh-notify/ui-config.json 这层覆盖，不用重启就能生效。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-notify'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dn-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-dn-sec]{display:flex;flex-direction:column;gap:10px;}
[data-dn-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dn-row]{display:flex;align-items:center;gap:10px;}
[data-dn-grow]{flex:1;min-width:0;}
[data-dn-label]{font-size:13px;}
[data-dn-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dn-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-dn-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dn-input]:focus{outline:none;border-color:#3b82f6;}
[data-dn-num]{width:88px;text-align:center;}
select[data-dn-input]{width:auto;min-width:150px;max-width:230px;flex:0 0 auto;}
[data-dn-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dn-sw][data-on]{background:#3b82f6;}
[data-dn-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dn-sw][data-on] i{left:19px;}
[data-dn-sw][disabled]{opacity:.45;cursor:default;}
[data-dn-btn]{padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-dn-btn]:hover{border-color:#3b82f6;}
[data-dn-btn][disabled]{opacity:.5;cursor:default;}
[data-dn-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dn-msg]{font-size:12px;line-height:18px;padding:7px 10px;border-radius:8px;}
[data-dn-msg][data-kind="ok"]{background:rgba(34,197,94,.14);color:#16a34a;}
[data-dn-msg][data-kind="err"]{background:rgba(239,68,68,.14);color:#dc2626;}
[data-dn-code]{font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;
  white-space:pre-wrap;word-break:break-all;padding:7px 9px;border-radius:7px;background:rgba(127,127,127,.10);}
`

    /** 事件原因 → 中文（顺序即界面顺序）。 */
    const REASONS = [
      ['completed', '任务完成'],
      ['error', '任务出错'],
      ['blocked', '任务被阻塞'],
      ['max-tokens', '超出 token 上限'],
      ['aborted', '任务被中止'],
    ]

    /** 网关探测结果 → 人话。 */
    function 网关文案(probe) {
      if (probe === 'online') return '在线'
      if (probe === 'offline') return '没在跑'
      if (probe === 'remote') return '远端（不探）'
      if (probe === 'bad-url') return '地址不对'
      if (typeof probe === 'string' && probe.startsWith('http-')) return '返回 ' + probe.slice(5)
      return String(probe)
    }

    function 开关({ on, onChange, disabled }) {
      return h('button', {
        'data-dn-sw': '',
        'data-on': on ? '' : undefined,
        disabled: disabled ? true : undefined,
        onClick: () => { if (!disabled) onChange(!on) },
        type: 'button',
      }, h('i'))
    }

    function 行({ label, note, children }) {
      return h('div', { 'data-dn-row': '' },
        h('div', { 'data-dn-grow': '' },
          h('div', { 'data-dn-label': '' }, label),
          note ? h('div', { 'data-dn-note': '' }, note) : null),
        children)
    }

    function 段({ title, children }) {
      return h('div', { 'data-dn-sec': '' },
        title ? h('div', { 'data-dn-h': '' }, title) : null,
        children)
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [gateways, setGateways] = React.useState([])
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [file, setFile] = React.useState('')
      const 定时 = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        jget('/config').then((r) => {
          if (!alive) return
          setCfg(r.config)
          setFile(r.file || '')
        }).catch((e) => { if (alive) setErr(String(e.message || e)) })
        // 网关是不是还活着，单独问一次（它是个本机常驻进程，最容易悄悄没了）
        jget('/status').then((r) => {
          if (alive && Array.isArray(r.gateways)) setGateways(r.gateways)
        }).catch(() => {})
        return () => { alive = false; if (定时.current) clearTimeout(定时.current) }
      }, [])

      /** 改一个字段：先本地渲染，再 debounce 落盘（多打几个字不会连发请求）。 */
      function 改(patch) {
        setCfg((prev) => {
          const next = JSON.parse(JSON.stringify(prev))
          for (const [key, value] of Object.entries(patch)) {
            if (key.includes('.')) {
              const [group, sub] = key.split('.')
              next[group] ??= {}
              next[group][sub] = value
            } else {
              next[key] = value
            }
          }
          if (定时.current) clearTimeout(定时.current)
          定时.current = setTimeout(() => {
            jpost('/config', next)
              .then((r) => { setMsg('已保存'); setErr('') ; if (r && r.config) setCfg(r.config) })
              .catch((e) => setErr('保存失败：' + String(e.message || e)))
          }, 400)
          return next
        })
      }

      async function 立即存(next) {
        setBusy(true)
        try {
          const r = await jpost('/config', next)
          setCfg(r.config)
          setMsg('已保存')
          setErr('')
        } catch (e) {
          setErr('保存失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function 试一下() {
        setBusy(true)
        setErr('')
        setMsg('')
        try {
          const r = await jpost('/test', {})
          if (Array.isArray(r.gateways)) setGateways(r.gateways)
          if (!r.ok) setErr(r.error || '没发出去')
          else if (r.warning) setErr(r.warning)
          else setMsg('发出去了（' + r.lanes + ' 条通道）')
        } catch (e) {
          setErr('发送失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function 查网关() {
        setBusy(true)
        try {
          const r = await jget('/status')
          if (Array.isArray(r.gateways)) setGateways(r.gateways)
          setMsg('网关状态已刷新')
          setErr('')
        } catch (e) {
          setErr('查不了：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function 恢复默认() {
        setBusy(true)
        try {
          const r = await jpost('/reset', {})
          setCfg(r.config)
          setMsg('已回到插件默认配置')
          setErr('')
        } catch (e) {
          setErr('恢复失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (err && !cfg) {
        return h('div', { 'data-dn-page': '' },
          h('div', { 'data-dn-msg': '', 'data-kind': 'err' }, err),
          h('div', { 'data-dn-note': '' }, '宿主那半边可能没起来：确认 DSH 重启过，且这个插件加载成功。'))
      }
      if (!cfg) return h('div', { 'data-dn-page': '' }, h('div', { 'data-dn-note': '' }, '读配置中…'))

      const turnEnd = cfg.turnEnd || {}
      const conf = cfg.confirmation || {}
      const sapi = cfg.sapi || {}
      const esc = cfg.escalation || {}
      const reasons = Array.isArray(turnEnd.reasons) ? turnEnd.reasons : []

      return h('div', { 'data-dn-page': '' },

        msg ? h('div', { 'data-dn-msg': '', 'data-kind': 'ok' }, msg) : null,
        err ? h('div', { 'data-dn-msg': '', 'data-kind': 'err' }, err) : null,

        段({
          title: '语音',
          children: [
            行({
              label: '念一遍',
              note: '用 Windows 自带语音把通知念出来，不用看屏幕',
              children: 开关({ on: sapi.enabled === true, onChange: (v) => 改({ 'sapi.enabled': v }) }),
            }),
            h('div', { 'data-dn-sub': '' },
              行({
                label: '念的内容',
                note: '可用变量：{title} 会话标题、{reason} 状态、{duration} 用时',
                children: null,
              }),
              h('input', {
                'data-dn-input': '',
                value: sapi.template || '',
                onChange: (e) => 改({ 'sapi.template': e.target.value }),
                disabled: sapi.enabled !== true,
              }),
              行({
                label: '音色',
                note: 'auto = 自动挑中文语音',
                children: h('input', {
                  'data-dn-input': '',
                  style: { width: '150px' },
                  value: sapi.voice || 'auto',
                  onChange: (e) => 改({ 'sapi.voice': e.target.value }),
                  disabled: sapi.enabled !== true,
                }),
              }),
              行({
                label: '同时来两条时',
                children: h('select', {
                  'data-dn-input': '',
                  value: sapi.queue || 'merge',
                  onChange: (e) => 改({ 'sapi.queue': e.target.value }),
                  disabled: sapi.enabled !== true,
                },
                  h('option', { value: 'merge' }, '只念最新那条'),
                  h('option', { value: 'drop' }, '剩下的丢掉')),
              })),
          ],
        }),

        段({
          title: '什么时候提醒',
          children: [
            ...REASONS.map(([code, label]) => 行({
              label,
              children: 开关({
                on: reasons.includes(code),
                onChange: (v) => 改({
                  'turnEnd.reasons': v
                    ? [...new Set([...reasons, code])]
                    : reasons.filter((item) => item !== code),
                }),
              }),
            })),
            h('div', { 'data-dn-sub': '' },
              行({
                label: '冷却（秒）',
                note: '一轮结束后这段时间内又开新的一轮，就不提醒（多轮任务只在真正结束时响）',
                children: h('input', {
                  'data-dn-input': '',
                  'data-dn-num': '',
                  type: 'number',
                  min: 0,
                  max: 3600,
                  value: Math.round((turnEnd.cooldownMs ?? 10000) / 1000),
                  onChange: (e) => 改({ 'turnEnd.cooldownMs': Math.max(0, Number(e.target.value) || 0) * 1000 }),
                }),
              }),
              行({
                label: '带上最近一句回复',
                note: '默认不带：通知里只会有标题和状态，不会有正文',
                children: 开关({ on: turnEnd.includeText === true, onChange: (v) => 改({ 'turnEnd.includeText': v }) }),
              })),
          ],
        }),

        段({
          title: '要你动手的时候',
          children: [
            行({
              label: '审批弹窗',
              note: '要用工具、要放开沙箱这类等你点头的时刻',
              children: 开关({ on: conf.approval === true, onChange: (v) => 改({ 'confirmation.approval': v }) }),
            }),
            行({
              label: '我提问时',
              children: h('select', {
                'data-dn-input': '',
                value: conf.askUserQuestion || 'auto',
                onChange: (e) => 改({ 'confirmation.askUserQuestion': e.target.value }),
              },
                h('option', { value: 'auto' }, '自动（有网页界面才提醒）'),
                h('option', { value: 'on' }, '总是提醒'),
                h('option', { value: 'off' }, '不提醒')),
            }),
            行({
              label: '等多久没回应再吼一次（分钟）',
              note: '填 0 就关掉这个升级提醒',
              children: h('input', {
                'data-dn-input': '',
                'data-dn-num': '',
                type: 'number',
                min: 0,
                max: 1440,
                value: Math.round((conf.timeoutMs ?? 600000) / 60000),
                onChange: (e) => 改({ 'confirmation.timeoutMs': Math.max(0, Number(e.target.value) || 0) * 60000 }),
              }),
            }),
            行({
              label: '升级时也念一遍',
              children: 开关({ on: esc.sapi === true, onChange: (v) => 改({ 'escalation.sapi': v }) }),
            }),
            行({
              label: '提问里带上问题摘要',
              note: '截到 120 字以内，不含选项细节',
              children: 开关({ on: conf.includeQuestion === true, onChange: (v) => 改({ 'confirmation.includeQuestion': v }) }),
            }),
          ],
        }),

        段({
          title: '范围',
          children: [
            行({
              label: '只提醒主会话',
              note: '关掉的话，子代理跑完也会提醒（一般不用开）',
              children: 开关({ on: cfg.rootOnly === true, onChange: (v) => 改({ rootOnly: v }) }),
            }),
          ],
        }),

        段({
          title: '试一试',
          children: [
            h('div', { 'data-dn-row': '' },
              h('button', { 'data-dn-btn': '', 'data-primary': '', disabled: busy, onClick: 试一下, type: 'button' }, '发一条测试通知'),
              h('button', { 'data-dn-btn': '', disabled: busy, onClick: 查网关, type: 'button' }, '查网关'),
              h('button', { 'data-dn-btn': '', disabled: busy, onClick: 恢复默认, type: 'button' }, '恢复默认')),
            h('div', {
              'data-dn-msg': '',
              'data-kind': gateways.some((g) => g.probe === 'offline') ? 'err' : 'ok',
            }, gateways.length === 0
              ? '没配本机网关通道（只走语音）'
              : gateways.map((g) => g.id + '：' + 网关文案(g.probe)).join('　')),
            h('div', { 'data-dn-note': '' },
              '测试会按当前配置真的走一遍：弹窗 + 语音（语音关着就不念）。'
              + '弹窗要靠本机那个常驻网关，它要是「没在跑」，通知会发失败——点「查网关」看一眼，重启一次电脑它也会自己起来。'),
          ],
        }),

        段({
          title: '存在哪',
          children: [
            h('div', { 'data-dn-code': '' }, file || '(未知)'),
            h('div', { 'data-dn-note': '' },
              '这一页写的是覆盖层，改完立刻生效；想改通道（推到手机 / 换 webhook 地址）还得去 profile 的 cordis.patch.yml，那要重启。'),
          ],
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-notify')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-notify: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.inject !== 'function') return
        slots.inject('settings.section', () => slots.register(
          // 编号按 工具\工具说明.txt 的清单走：7 号空着不回收，新工具往后排，所以是 14。
          // order 也往后排（39 是 10 号，36 留给空着的 7 号），不去顶空号。
          { name: 'settings.section', id: 'dsh-notify', order: 40, label: '14. 任务通知' },
          () => h(Panel),
        ))
      },
    }
  },
})
