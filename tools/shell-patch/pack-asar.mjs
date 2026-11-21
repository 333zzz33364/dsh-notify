// 重打 asar：保持所有文件与顺序，只替换 lib/main.js。用法：node pack-asar.mjs <原 asar> <新 main.js> <输出 asar>
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [srcAsar, newMain, outAsar] = process.argv.slice(2)
const buf = readFileSync(srcAsar)

const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonLen))
const dataStart = 8 + headerSize

// 1) 收集非 unpacked 文件，按原 offset 排序（保持数据区顺序）
const entries = []
const walk = (node, p = '') => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const full = p === '' ? name : `${p}/${name}`
    if (child.files !== undefined) walk(child, full)
    else if (!child.unpacked) entries.push({ path: full, node: child })
  }
}
walk(header)
entries.sort((a, b) => Number(a.node.offset) - Number(b.node.offset))

const patched = readFileSync(newMain)
const BLOCK = 4194304
const sha = data => createHash('sha256').update(data).digest('hex')

// 2) 重排 offset/size，main.js 换成补丁版并重算 integrity
let cursor = 0
const chunks = []
for (const entry of entries) {
  let data
  if (entry.path === 'lib/main.js') {
    data = patched
    const blocks = []
    for (let at = 0; at < data.length; at += BLOCK) blocks.push(sha(data.subarray(at, at + BLOCK)))
    entry.node.integrity = {
      algorithm: 'SHA256',
      hash: sha(data),
      blockSize: BLOCK,
      blocks,
    }
  } else {
    const start = dataStart + Number(entry.node.offset)
    data = buf.subarray(start, start + entry.node.size)
  }
  entry.node.offset = String(cursor)
  entry.node.size = data.length
  cursor += data.length
  chunks.push(data)
}

// 3) 写新 asar：4 字节 + headerSize + (jsonLen+pad+4) + jsonLen + json + pad + data
const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8')
const padding = (4 - (jsonBuf.length % 4)) % 4
const head = Buffer.alloc(16)
head.writeUInt32LE(4, 0)
head.writeUInt32LE(8 + jsonBuf.length + padding, 4)
head.writeUInt32LE(jsonBuf.length + padding + 4, 8)
head.writeUInt32LE(jsonBuf.length, 12)

const fd = openSync(outAsar, 'w')
try {
  writeSync(fd, head)
  writeSync(fd, jsonBuf)
  if (padding > 0) writeSync(fd, Buffer.alloc(padding))
  for (const chunk of chunks) writeSync(fd, chunk)
} finally {
  closeSync(fd)
}

console.log(`ok: files=${entries.length} dataBytes=${cursor} headerBytes=${8 + jsonBuf.length + padding}`)
console.log(`out=${outAsar} size=${8 + jsonBuf.length + padding + cursor}`)
