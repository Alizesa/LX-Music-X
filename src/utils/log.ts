import { temporaryDirectoryPath, existsFile, appendFile, unlink, writeFile, readFile, stat, moveFile } from '@/utils/fs'
import BackgroundTimer from 'react-native-background-timer'
import { createDebugLogWriter } from './debugLogWriter'

const writer = createDebugLogWriter(
  { existsFile, appendFile, unlink, writeFile, readFile, stat, moveFile },
  BackgroundTimer,
  temporaryDirectoryPath + '/error.log',
  { fileLimit: 512 * 1024, bufferLimit: 64 * 1024 },
)

// 初始化失败后仍遵守缓冲上限；后续 flush 会重新尝试打开文件。
export const init = async() => { await writer.flush().catch(() => {}) }
export const getLogs = async() => writer.read()
export const clearLogs = async() => writer.clear()

const write = (type: 'LOG' | 'WARN' | 'ERROR', msgs: unknown[]) => {
  const msg = msgs.map(value => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.stack ?? value.message
    try { return JSON.stringify(value) } catch { return String(value) }
  }).join(' ')
  if (type === 'LOG' && msg.startsWith('%c')) return
  writer.append('----lx log----\n' + new Date().toLocaleString() + ' ' + type + ' ' + msg)
}

export const log = {
  info(...msgs: unknown[]) { write('LOG', msgs) },
  warn(...msgs: unknown[]) { write('WARN', msgs) },
  error(...msgs: unknown[]) { write('ERROR', msgs) },
}
