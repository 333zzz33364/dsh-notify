// dsh-notify 浏览器半端的无头自测：不开浏览器，用最小 stub 跑一遍 lib/client.js。
// 覆盖：模块自注册 → factory 返回 { inject, apply } → apply 注册两个插槽
//       → 未读徽章首帧渲染（0 不画 / 有数画 / 超上限画 99+ / digits=false 不画 / 标题前缀）。
// 跑法：node scripts/smoke-client.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

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

// ---- React 最小实现：够跑函数组件 + hooks，不跑真实调度 ----
function createReactRuntime() {
  const rt = { hooks: [], index: 0, effects: [], stores: [] }
  rt.reset = () => { rt.index = 0; rt.effects = [] }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(2).filter(c => c !== null && c !== undefined && c !== false) }
    },
    useState(init) {
      const i = rt.index++
      if (!(i in rt.hooks)) {
        const store = { value: typeof init === 'function' ? init() : init }
        store.set = next => { store.value = typeof next === 'function' ? next(store.value) : next }
        rt.hooks[i] = store
        rt.stores.push(store)
      }
      return [rt.hooks[i].value, rt.hooks[i].set]
    },
    useRef(init) {
      const i = rt.index++
      if (!(i in rt.hooks)) rt.hooks[i] = { current: init }
      return rt.hooks[i]
    },
    useCallback(fn) { rt.index += 1; return fn },
    useMemo(fn) { rt.index += 1; return fn() },
    useEffect(fn) { rt.index += 1; rt.effects.push(fn) },
    Fragment: 'fragment',
  }
  return { React, rt }
}

/** 造一个够 client.js 用的浏览器沙箱，返回捕获到的模块条目与运行时。 */
function loadClient({ badge = { count: 0, max: 99, digits: true, enabled: true } } = {}) {
  const { React, rt } = createReactRuntime()
  const calls = { badge: 0, clear: 0 }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: undefined,
    fetch: async url => {
      if (String(url).endsWith('/badge/clear')) {
        calls.clear += 1
        return { ok: true, json: async () => ({ ok: true, count: 0, epoch: 0 }) }
      }
      calls.badge += 1
      return { ok: true, json: async () => ({ ok: true, ...badge }) }
    },
  }
  sandbox.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: { load: entry => { sandbox.__entry = entry } },
  }
  sandbox.document = {
    title: 'DeepSeek Harness',
    visibilityState: 'visible',
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
    querySelector: () => null,
    hasFocus: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  const entry = sandbox.__entry
  const plugin = entry.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { plugin, entry, sandbox, rt, calls }
}

/** 在这个沙箱里注册一遍插槽，取回未读徽章组件（闭包绑的是这个沙箱的 fetch）。 */
const componentCache = new WeakMap()
function badgeComponentOf(loaded) {
  if (componentCache.has(loaded.plugin)) return componentCache.get(loaded.plugin)
  const list = []
  const slots = {
    inject: (name, factory) => factory(),
    register: (meta, component) => { list.push({ meta, component }); return { meta } },
  }
  loaded.plugin.apply({ slots, get: name => (name === 'slots' ? slots : undefined), effect: fn => fn() })
  // 注册的是「组件工厂」（() => h(未读徽章)），真组件是它返回的 vnode.type。
  const factory = list.find(item => item.meta.id === 'dsh-notify-badge').component
  const component = factory().type
  componentCache.set(loaded.plugin, component)
  return component
}

/** 跑一帧：渲染 → 执行 effects（让轮询的 setState 落地）→ 冲掉微任务。 */
async function frame(loaded, Component) {
  const { rt } = loaded
  rt.reset()
  const vnode = Component()
  for (const fn of rt.effects) fn()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
  return vnode
}

// ── 测试 ────────────────────────────────────────────────────────────────────
const base = loadClient()

await test('client：自注册 id 与包名一致，factory 返回 { inject, apply }', async () => {
  assert.equal(base.entry.id, 'dsh-notify')
  assert.equal(base.plugin.inject.join(','), 'slots')
  assert.equal(typeof base.plugin.apply, 'function')
})

await test('client：apply 注册设置页与未读徽章两个插槽', async () => {
  const registered = []
  const slots = {
    injected: [],
    inject(name, factory) { this.injected.push(name); factory() },
    register(meta, component) { registered.push({ meta, component }); return { meta } },
  }
  base.plugin.apply({ slots, get: name => (name === 'slots' ? slots : undefined), effect: fn => fn() })
  assert.deepEqual(slots.injected, ['settings.section', 'sidebar.toggle.badge'])
  assert.equal(registered[0].meta.id, 'dsh-notify')
  assert.equal(registered[0].meta.label, '14. 任务通知')
  assert.equal(registered[1].meta.id, 'dsh-notify-badge')
})

await test('client：未读数 0 不画，有数画「5」并给标题加前缀', async () => {
  const zero = loadClient({ badge: { count: 0, max: 99, digits: true, enabled: true } })
  const zeroComp = badgeComponentOf(zero)
  await frame(zero, zeroComp)
  const empty = await frame(zero, zeroComp)
  assert.equal(empty, null, '0 不占位置')

  const five = loadClient({ badge: { count: 5, max: 99, digits: true, enabled: true } })
  const fiveComp = badgeComponentOf(five)
  await frame(five, fiveComp)
  const drawn = await frame(five, fiveComp)
  assert.equal(drawn.type, 'button')
  assert.equal(drawn.props['data-dn-chip'], '')
  assert.equal(drawn.children.join(''), '5')
  assert.equal(five.sandbox.document.title, '(5) DeepSeek Harness')
})

await test('client：超过上限画 99+，digits=false 只记账不画', async () => {
  const over = loadClient({ badge: { count: 120, max: 99, digits: true, enabled: true } })
  const overComp = badgeComponentOf(over)
  await frame(over, overComp)
  const many = await frame(over, overComp)
  assert.equal(many.children.join(''), '99+')
  assert.equal(over.sandbox.document.title, '(99+) DeepSeek Harness')

  const off = loadClient({ badge: { count: 5, max: 99, digits: false, enabled: true } })
  const offComp = badgeComponentOf(off)
  await frame(off, offComp)
  const quiet = await frame(off, offComp)
  assert.equal(quiet, null, 'digits=false 不画')
  assert.equal(off.sandbox.document.title, 'DeepSeek Harness', '标题也不加前缀')
})

console.log('')
if (failed.length > 0) {
  console.error(`FAILED ${failed.length} 项: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`PASS: ${passed} 项浏览器半端自测通过`)
