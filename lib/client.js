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
[data-dn-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dn-sech]{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:6px 2px;
  border:0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));
  background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;}
[data-dn-sech]:hover [data-dn-sectl]{color:#3b82f6;}
[data-dn-caret]{font-size:10px;width:10px;line-height:1;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dn-sectl]{font-size:12px;font-weight:600;letter-spacing:.02em;}
[data-dn-secbody]{display:flex;flex-direction:column;gap:10px;padding:2px 0;}
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

    /**
     * 一个可折叠分类。展开状态记在 localStorage 里（key 用标题），下次进来还是上次的样子。
     * 默认只有「通知开关」展开，别的先折起来，页面不至于一屏列到底。
     */
    function 段({ title, children, defaultOpen }) {
      const key = 'dsh-notify-open:' + title
      const [open, setOpen] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem(key)
          return saved === null ? defaultOpen === true : saved === '1'
        } catch {
          return defaultOpen === true
        }
      })
      const 折 = () => {
        const next = !open
        setOpen(next)
        try { window.localStorage.setItem(key, next ? '1' : '0') } catch {}
      }
      return h('div', { 'data-dn-sec': '' },
        h('button', {
          'data-dn-sech': '', type: 'button', onClick: 折, title: open ? '收起来' : '展开',
        },
          h('span', { 'data-dn-caret': '' }, open ? '▼' : '▶'),
          h('span', { 'data-dn-sectl': '' }, title)),
        open ? h('div', { 'data-dn-secbody': '' }, children) : null)
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [gateways, setGateways] = React.useState([])
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [file, setFile] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [sesMsg, setSesMsg] = React.useState('')
      // 通知样式：应用名和图标不在插件里生效，要转给本机 toast 网关改开始菜单快捷方式
      const [styleName, setStyleName] = React.useState('')
      const [styleIcon, setStyleIcon] = React.useState('')
      const [styleMsg, setStyleMsg] = React.useState('')
      const 选图 = React.useRef(null)
      const 定时 = React.useRef(null)
      // 当前配置的最新副本：改() 基于它算下一个值，不依赖闭包里那份可能过期的 cfg
      const 现值 = React.useRef(null)
      // 还没落盘的那一份（切走页面时补发，见下面的卸载清理）
      const 待存 = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        jget('/config').then((r) => {
          if (!alive) return
          现值.current = r.config
          setCfg(r.config)
          setFile(r.file || '')
          // 样式以网关实际生效的为准；网关问不到才退回覆盖层里记的那份
          if (r.gatewayStyle && typeof r.gatewayStyle === 'object') {
            setStyleName(String(r.gatewayStyle.appName || ''))
            setStyleIcon(String(r.gatewayStyle.icon || ''))
          } else if (r.config && r.config.style) {
            setStyleName(String(r.config.style.appName || ''))
            setStyleIcon(String(r.config.style.icon || ''))
          }
        }).catch((e) => { if (alive) setErr(String(e.message || e)) })
        // 网关是不是还活着，单独问一次（它是个本机常驻进程，最容易悄悄没了）
        jget('/status').then((r) => {
          if (alive && Array.isArray(r.gateways)) setGateways(r.gateways)
        }).catch(() => {})
        // 会话列表（按对话管理通知）
        jget('/sessions').then((r) => {
          if (alive && Array.isArray(r.sessions)) setSessions(r.sessions)
        }).catch(() => {})
        return () => {
          alive = false
          // 切走页面时，还没发出去的那次修改要补发——不然点了开关就走等于没点
          const pending = 待存.current
          if (定时.current) clearTimeout(定时.current)
          定时.current = null
          待存.current = null
          if (pending) jpost('/config', pending).catch(() => {})
        }
      }, [])

      /** 记下改后的值并落盘；immediate=true 时立刻发（开关用），否则 debounce（输入框用）。 */
      function 改(patch, immediate) {
        const base = 现值.current || cfg
        if (!base) return
        const next = JSON.parse(JSON.stringify(base))
        for (const [key, value] of Object.entries(patch)) {
          if (key.includes('.')) {
            const [group, sub] = key.split('.')
            next[group] ??= {}
            next[group][sub] = value
          } else {
            next[key] = value
          }
        }
        现值.current = next
        setCfg(next)
        待存.current = next
        if (定时.current) clearTimeout(定时.current)
        const send = () => {
          定时.current = null
          jpost('/config', next)
            .then((r) => {
              待存.current = null
              setMsg('已保存')
              setErr('')
              if (r && r.config) {
                现值.current = r.config
                setCfg(r.config)
              }
            })
            .catch((e) => setErr('保存失败：' + String(e.message || e)))
        }
        if (immediate) {
          send()
          return
        }
        定时.current = setTimeout(send, 400)
      }

      async function 立即存(next) {
        setBusy(true)
        try {
          const r = await jpost('/config', next)
          现值.current = r.config
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

      /** 把样式交给网关：改名 / 换图标都会重建通知头部那个开始菜单快捷方式。 */
      async function 存样式(payload, 成功文案) {
        setBusy(true)
        setStyleMsg('')
        try {
          const r = await jpost('/style', payload)
          const gw = r.gateway && typeof r.gateway === 'object' ? r.gateway : null
          if (gw) {
            if (typeof gw.appName === 'string') setStyleName(gw.appName)
            if (typeof gw.icon === 'string') setStyleIcon(gw.icon)
          }
          if (!r.ok) setStyleMsg(r.error || '没改成')
          else setStyleMsg(成功文案 || '样式已更新')
        } catch (e) {
          setStyleMsg('失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      /** 选一张本地图片当图标：浏览器读成 base64 交给网关落盘（网页拿不到真实路径）。 */
      function 选图标文件(e) {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        if (!file) return
        if (file.size > 8 * 1024 * 1024) {
          setStyleMsg('图太大了，选 8 MB 以内的')
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          const comma = dataUrl.indexOf(',')
          if (comma < 0) {
            setStyleMsg('这张图读不出来')
            return
          }
          存样式({ iconBase64: dataUrl.slice(comma + 1), iconName: file.name }, '图标换好了：' + file.name)
        }
        reader.onerror = () => setStyleMsg('读文件失败')
        reader.readAsDataURL(file)
      }

      async function 恢复默认() {        setBusy(true)
        try {
          const r = await jpost('/reset', {})
          现值.current = r.config
          待存.current = null
          setCfg(r.config)
          setMsg('已回到插件默认配置')
          setErr('')
        } catch (e) {
          setErr('恢复失败：' + String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      async function 刷新会话() {
        try {
          const r = await jget('/sessions')
          if (Array.isArray(r.sessions)) setSessions(r.sessions)
          setSesMsg('列表已刷新')
        } catch (e) {
          setSesMsg('读不到列表：' + String(e.message || e))
        }
      }

      async function 切会话(id, on) {
        try {
          const r = await jpost('/sessions', { id, enabled: on })
          if (Array.isArray(r.sessions)) setSessions(r.sessions)
          setSesMsg('已保存')
        } catch (e) {
          setSesMsg('保存失败：' + String(e.message || e))
        }
      }

      /** 时间戳 → 「10-29 03:04」。 */
      function 时间(at) {
        if (!at) return ''
        const d = new Date(at)
        const p = (n) => String(n).padStart(2, '0')
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
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

        h(段, {
          title: '通知开关',
          defaultOpen: true,
          children: [
            行({
              label: '总开关',
              note: '关掉以后一条通知都不发（「试一试」还能用来测链路）',
              children: 开关({ on: cfg.enabled !== false, onChange: (v) => 改({ enabled: v }, true) }),
            }),
            行({
              label: '新对话默认通知',
              note: '每个对话可以单独关；这里管的是没单独设过的那些',
              children: 开关({ on: cfg.sessionDefault !== false, onChange: (v) => 改({ sessionDefault: v }, true) }),
            }),
            h('div', { 'data-dn-sub': '' },
              行({
                label: '按对话管理',
                note: '最近 30 个对话。标「单独改过」的不再跟默认走',
                children: h('button', {
                  'data-dn-btn': '', type: 'button', onClick: 刷新会话,
                }, '刷新列表'),
              }),
              sessions.length === 0
                ? h('div', { 'data-dn-note': '' }, '还没有列表；点一下「刷新列表」。')
                : sessions.map((s) => 行({
                  key: s.id,
                  label: s.title + (s.busy ? ' · 正在跑' : ''),
                  note: 时间(s.at) + '　' + s.id.slice(0, 22) + '…' + (s.overridden ? '　· 单独改过' : ''),
                  children: 开关({
                    on: s.enabled !== false,
                    onChange: (v) => 切会话(s.id, v),
                  }),
                })),
              sesMsg ? h('div', { 'data-dn-note': '' }, sesMsg) : null),
          ],
        }),

        h(段, {
          title: '通知样式',
          defaultOpen: false,
          children: [
            h('div', { 'data-dn-label': '' }, '通知头部显示的名字'),
            h('div', { 'data-dn-row': '' },
              h('input', {
                'data-dn-input': '',
                value: styleName,
                maxLength: 40,
                placeholder: 'DeepSeek Harness 通知',
                onChange: (e) => setStyleName(e.target.value),
              }),
              h('button', {
                'data-dn-btn': '', type: 'button', disabled: busy,
                onClick: () => 存样式({ appName: styleName }, '名字改好了'),
              }, '存名字')),
            h('div', { 'data-dn-note': '' },
              '就是通知左上角那一行。改完立刻生效；要是通知里还显示旧名字，重启一次资源管理器。'),
            h('div', { 'data-dn-label': '' }, '图标'),
            h('div', { 'data-dn-row': '' },
              h('button', {
                'data-dn-btn': '', type: 'button', disabled: busy,
                onClick: () => { if (选图.current) 选图.current.click() },
              }, '选一张图'),
              h('button', {
                'data-dn-btn': '', type: 'button', disabled: busy,
                onClick: () => 存样式({ resetIcon: true }, '图标换回默认的了'),
              }, '恢复默认'),
              h('button', {
                'data-dn-btn': '', type: 'button', disabled: busy,
                onClick: 试一下,
              }, '试一条')),
            h('input', {
              type: 'file',
              accept: 'image/png,image/jpeg,image/bmp,image/x-icon',
              ref: 选图,
              style: { display: 'none' },
              onChange: 选图标文件,
            }),
            h('div', { 'data-dn-note': '' }, styleIcon ? '当前图标：' + styleIcon : '当前图标：网关默认'),
            styleMsg
              ? h('div', {
                'data-dn-msg': '',
                'data-kind': styleMsg.startsWith('失败') || styleMsg === '没改成' ? 'err' : 'ok',
              }, styleMsg)
              : null,
            h('div', { 'data-dn-note': '' },
              '选的图会存一份到 工具\\通知\\custom-icon.*，通知头部的图标自动转成 .ico；'
              + '「试一条」按当前配置真发一条，看得见效果。'),
          ],
        }),

        h(段, {
          title: '语音',
          defaultOpen: false,
          children: [
            行({
              label: '念一遍',
              note: '用 Windows 自带语音把通知念出来，不用看屏幕',
              children: 开关({ on: sapi.enabled === true, onChange: (v) => 改({ 'sapi.enabled': v }, true) }),
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

        h(段, {
          title: '什么时候提醒',
          defaultOpen: false,
          children: [
            ...REASONS.map(([code, label]) => 行({
              label,
              children: 开关({
                on: reasons.includes(code),
                onChange: (v) => 改({
                  'turnEnd.reasons': v
                    ? [...new Set([...reasons, code])]
                    : reasons.filter((item) => item !== code),
                }, true),
              }),
            })),
            h('div', { 'data-dn-sub': '' },
              行({
                label: '等几秒再提醒',
                note: '填 0 就是任务一结束立刻响。这期间又开了一轮，就等最后那次结束再响。',
                children: h('input', {
                  'data-dn-input': '',
                  'data-dn-num': '',
                  type: 'number',
                  min: 0,
                  max: 3600,
                  value: Math.round((turnEnd.cooldownMs ?? 15000) / 1000),
                  onChange: (e) => 改({ 'turnEnd.cooldownMs': Math.max(0, Number(e.target.value) || 0) * 1000 }),
                }),
              }),
              行({
                label: '同一对话最少隔几秒',
                note: '防止一个对话连着弹。填 0 就是不限',
                children: h('input', {
                  'data-dn-input': '',
                  'data-dn-num': '',
                  type: 'number',
                  min: 0,
                  max: 86400,
                  value: Math.round((turnEnd.minIntervalMs ?? 90000) / 1000),
                  onChange: (e) => 改({ 'turnEnd.minIntervalMs': Math.max(0, Number(e.target.value) || 0) * 1000 }),
                }),
              }),
              行({
                label: '这轮没干活就不提醒',
                note: '纯聊天（一个工具都没调）不弹，只有真跑过活的轮次才提醒',
                children: 开关({ on: turnEnd.requireTools !== false, onChange: (v) => 改({ 'turnEnd.requireTools': v }, true) }),
              }),
              行({
                label: '只提醒你发起的',
                note: '定时任务、QQ 桥、B站插件这些自动跑起来的轮次不弹',
                children: 开关({
                  on: Array.isArray(turnEnd.sources) && turnEnd.sources.length > 0,
                  onChange: (v) => 改({ 'turnEnd.sources': v ? ['user', 'qq'] : [] }, true),
                }),
              }),
              行({
                label: '带上最近一句回复',
                note: '默认不带：通知里只会有标题和状态，不会有正文',
                children: 开关({ on: turnEnd.includeText === true, onChange: (v) => 改({ 'turnEnd.includeText': v }, true) }),
              })),
          ],
        }),

        h(段, {
          title: '要你动手的时候',
          defaultOpen: false,
          children: [
            行({
              label: '审批弹窗',
              note: '要用工具、要放开沙箱这类等你点头的时刻',
              children: 开关({ on: conf.approval === true, onChange: (v) => 改({ 'confirmation.approval': v }, true) }),
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
              children: 开关({ on: esc.sapi === true, onChange: (v) => 改({ 'escalation.sapi': v }, true) }),
            }),
            行({
              label: '提问里带上问题摘要',
              note: '截到 120 字以内，不含选项细节',
              children: 开关({ on: conf.includeQuestion === true, onChange: (v) => 改({ 'confirmation.includeQuestion': v }, true) }),
            }),
          ],
        }),

        h(段, {
          title: '范围',
          defaultOpen: false,
          children: [
            行({
              label: '只提醒主会话',
              note: '关掉的话，子代理跑完也会提醒（一般不用开）',
              children: 开关({ on: cfg.rootOnly === true, onChange: (v) => 改({ rootOnly: v }, true) }),
            }),
          ],
        }),

        h(段, {
          title: '试一试',
          defaultOpen: false,
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

        h(段, {
          title: '存在哪',
          defaultOpen: false,
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
