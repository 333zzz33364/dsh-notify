// 校验新 asar：文件树完整、每份数据与 header 的 integrity 对得上。用法：node verify-asar.mjs <asar>
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const file = process.argv[2]
const buf = readFileSync(file)
const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

const sha = data => createHash('sha256').update(data).digest('hex')
let files = 0
let unpacked = 0
let checked = 0
const problems = []

const walk = (node, p = '') => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = p === '' ? name : `${p}/${name}`
    if (child.files !== undefined) { walk(child, full); continue }
    files += 1
    if (child.unpacked) { unpacked += 1; continue }
    const start = dataStart + Number(child.offset)
    const end = start + child.size
    if (end > buf.length) { problems.push(`out of range: ${full}`); return }
    const data = buf.subarray(start, end)
    if (child.integrity?.hash !== undefined) {
      checked += 1
      if (sha(data) !== child.integrity.hash) problems.push(`hash mismatch: ${full}`)
    }
  }
}
walk(header)

console.log(`bytes=${buf.length} dataStart=${dataStart} files=${files} unpacked=${unpacked} checked=${checked}`)
if (problems.length === 0) {
  console.log('VERIFY OK: 每个文件的数据都与 header 里的 integrity 一致')
} else {
  console.log(`PROBLEMS ${problems.length}`)
  console.log(problems.slice(0, 10).join('\n'))
  process.exit(1)
}
