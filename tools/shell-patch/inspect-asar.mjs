// 读 asar：只看结构（不写任何文件）。用法：node inspect-asar.mjs <asar 路径> [路径前缀]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const prefix = process.argv[3] ?? ''
const buf = readFileSync(file)

const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

console.log(`asar=${file}`)
console.log(`bytes=${buf.length} headerSize=${headerSize} jsonLen=${jsonLen} dataStart=${dataStart}`)
console.log(`top-level=${Object.keys(header.files).join(', ')}`)

function walk(node, path = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = path === '' ? name : `${path}/${name}`
    if (child.files) {
      if (prefix === '' || full.startsWith(prefix)) console.log(`DIR  ${full}/`)
      walk(child, full)
    } else if (prefix === '' ? full.split('/').length <= 2 : full.startsWith(prefix)) {
      console.log(`FILE ${full}  ${child.size} bytes  offset=${child.offset}${child.unpacked ? '  (unpacked)' : ''}`)
    }
  }
}
walk(header)
