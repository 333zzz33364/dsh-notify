// 从 asar 里取单个文件到 stdout 或磁盘。用法：node read-asar.mjs <asar> <内部路径> [输出文件]
import { readFileSync, writeFileSync } from 'node:fs'

const [file, inner, out] = process.argv.slice(2)
const buf = readFileSync(file)
const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

let node = header
for (const part of inner.split('/')) {
  node = node?.files?.[part]
  if (node === undefined) {
    console.error(`not found: ${inner}`)
    process.exit(1)
  }
}
if (node.files !== undefined) {
  console.error('is a directory')
  process.exit(1)
}
const data = buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size)
if (out) {
  writeFileSync(out, data)
  console.error(`wrote ${out} (${node.size} bytes)`)
} else {
  process.stdout.write(data)
}
