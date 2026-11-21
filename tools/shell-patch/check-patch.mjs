// 抽查补丁到底在不在、关键那几行是不是新版。
// 用法：node check-patch.mjs <抽出来的 main.js>
//   先 node read-asar.mjs "<asar>" lib/main.js > main.check.js，再跑这个。
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === void 0) {
  console.error('usage: node check-patch.mjs <main.js>')
  process.exit(2)
}
const source = readFileSync(file, 'utf8')

const marks = [
  ['补丁函数已注入', 'function attachNotifyBadge('],
  ['主窗口里调用了它', 'attachNotifyBadge(window);'],
  ['清零走页面内同源请求', 'executeJavaScript('],
  ['3 秒兜底清零', 'Date.now() - shownAt > 3e3'],
  ['focus 立刻清', 'Date.now() - shownAt > 400'],
  ['清除传 null（不是 undefined）', ': null, count > 0'],
  ['写了诊断日志', 'shell-badge.log'],
]

let missing = 0
for (const [name, needle] of marks) {
  const hit = source.includes(needle)
  if (!hit) missing += 1
  console.log(`${hit ? 'OK  ' : 'MISS'}  ${name}`)
}

const version = source.match(/本机补丁 (\d{4}-\d{2}-\d{2} v\d+)/)
console.log(`\n版本注释：${version === null ? '（没找到）' : version[1]}`)
console.log(`文件大小：${source.length} 字符`)
process.exit(missing === 0 ? 0 : 1)
