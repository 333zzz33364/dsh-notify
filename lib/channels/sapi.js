// dsh-notify SAPI 语音通道 —— 零依赖（node 内置 child_process）。
// 契约：
// - 必须用 powershell.exe（Windows PowerShell 5.1，自带 System.Speech），不是 pwsh；
// - 脚本经 -EncodedCommand（UTF-16LE Base64）传输，杜绝中文 GBK 乱码；
// - windowsHide + stdio:'ignore'，spawn 后不 await、unref，子进程独立播放；
// - fail-soft：任何失败（powershell 缺失、无语音引擎、脚本错误）静默跳过，绝不阻塞主流程；
// - 语音排队：同一时刻最多 1 个 Speak 进程，新通知按配置 merge（排队合并成最新一条）或 drop（丢弃）；
//   由于不 await 子进程，用文本长度估算播报时长来释放名额（保守估计）。

import { spawn } from 'node:child_process'
import { render, truncate } from '../templates.js'

/** 语音文本上限：既是听感约束，也保证 -EncodedCommand 命令行不超长。 */
const MAX_SPEAK_CHARS = 200

/**
 * 生成 PowerShell 5.1 合成语音脚本：System.Speech + zh-CN 语音优先。
 * 文本单引号转义为 ''，换行/制表符压成空格；voice 为 'auto' 时自动挑 zh-* 语音，否则按名称 LIKE 匹配。
 * @param {string} text - 播报文本。
 * @param {string} voice - 语音选择：'auto' 或语音名匹配模式（如 'Huihui'）。
 * @returns {string} 可直接 -EncodedCommand 的脚本。
 */
export function buildSpeechScript(text, voice = 'auto') {
  const cleaned = truncate(String(text ?? '').replace(/[\r\n\t]+/g, ' '), MAX_SPEAK_CHARS).replace(/'/g, "''")
  const voiceSelect = voice && voice !== 'auto'
    ? [
        `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like '${String(voice).replace(/'/g, "''")}' } | Select-Object -First 1`,
        'if ($v) { $s.SelectVoice($v.VoiceInfo) }',
      ].join('\n')
    : [
        "$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
        'if ($zh) { $s.SelectVoice($zh.VoiceInfo) }',
      ].join('\n')
  return [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voiceSelect,
    `$s.Speak('${cleaned}')`,
  ].join('\n')
}

/**
 * -EncodedCommand 编码：UTF-16LE → Base64（PowerShell 约定编码，中文安全）。
 * @param {string} script - PowerShell 脚本。
 * @returns {string} Base64 字符串。
 */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 估算播报时长（毫秒）：1.5s 起步 + 每字符 180ms，上限 30s。
 * 用于释放语音名额；不精确但不影响正确性（宁可多等）。
 * @param {string} text - 播报文本。
 * @returns {number} 估算毫秒数。
 */
export function estimateSpeakMs(text) {
  return Math.min(30_000, Math.max(2_000, 1500 + String(text ?? '').length * 180))
}

/**
 * 创建 SAPI 语音通道（供队列使用）。send 立即返回（fire-and-forget），因此对队列而言恒成功。
 * @param {{
 *   template: string, voice?: string, queueMode?: 'merge' | 'drop',
 *   logger?: { warn?: (message: string) => void },
 *   setTimer?: (fn: () => void, ms: number) => () => void,
 * }} options
 *   template 播报模板（同一套 {{}} 变量）；queueMode 'merge' 排队合并 / 'drop' 丢弃（默认 merge）；
 *   setTimer 定时器注入（默认 unref 的 setTimeout，不阻止进程退出）。
 * @returns {{ id: string, send: (fields: Record<string, unknown>) => Promise<void> }}
 */
export function createSapiChannel({
  template,
  voice = 'auto',
  queueMode = 'merge',
  logger,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}) {
  let pending = null
  let speaking = false
  const warn = message => {
    if (typeof logger?.warn === 'function') logger.warn(message)
    else console.warn(message)
  }

  /** 真正 spawn 一个独立 Speak 进程；任何失败静默（fail-soft）。 */
  function speakNow(text) {
    const script = buildSpeechScript(text, voice)
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (error) {
      warn(`notify: SAPI 语音启动失败: ${error?.message ?? error}`)
      return
    }
    // 必须有 error 监听，否则 spawn 失败（如找不到 powershell.exe）会抛未捕获异常
    child.on('error', () => {})
    if (typeof child.unref === 'function') child.unref()
    const estimate = estimateSpeakMs(text)
    setTimer(() => {
      speaking = false
      if (pending !== null) {
        const next = pending
        pending = null
        speaking = true
        speakNow(next)
      }
    }, estimate)
  }

  return {
    id: 'sapi',
    /** 渲染模板 → 入语音队；空文本静默跳过。 */
    async send(fields) {
      const text = render(template, fields)
      if (text.trim() === '') return
      if (speaking) {
        if (queueMode === 'merge') pending = text // 合并：只保留最新一条
        return
      }
      speaking = true
      speakNow(text)
    },
  }
}
