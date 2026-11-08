import BackgroundTimer from 'react-native-background-timer'
import * as fs from '@/utils/fs'
import { createDebugLogWriter, utf8Size } from './debugLogWriter'

export type PlaybackLogFields = Record<string, unknown>
export interface PlaybackLogContext { playId?: string, preloadId?: string, urlId?: string }
type Fields = PlaybackLogFields | (() => PlaybackLogFields)

let enabled = false
let nextId = 0
let ids = new WeakMap<object, string>()
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const providers = new Map<string, () => PlaybackLogFields>()
const subscribers = new Set<() => void>()
const lastStates = new Map<string, { state: string, at: number }>()
let writeError = ''

const hashText = (text: string) => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}
const redactText = (text: string) => text
  .replace(/https?:\/\/[^\s<>"'\\]+/gi, url => `${/^https?:\/\/(?:[^@/?#\s]+@)?([^/?#\s]+)/i.exec(url)?.[1] ?? 'url'}/[${hashText(url)}]`)
  .replace(/(?:content|file):\/\/[^\s<>"']+/gi, '[local-resource]')
  .replace(/\b(cookie|set-cookie|authorization)\b["']?\s*[:=][^\r\n]*/gi, '$1=[redacted]')
  .replace(/\b([\w-]*token[\w-]*|vkey|ticket|signature|sign|sig|password|[\w-]*secret[\w-]*|api[_-]?key|p_skey|skey)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}"']+)/gi, '$1=[redacted]')
  .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.:-]+/gi, '$1 [redacted]')

/** 日志只接受有限的字段，异常字符串也做脱敏；不保留原始对象或整个响应。 */
export const sanitizePlaybackLog = (value: unknown): unknown => {
  let budget = 6000
  const seen = new WeakSet<object>()
  const clean = (item: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 4) return '[truncated]'
    if (typeof item === 'string') {
      const text = redactText(item).slice(0, Math.min(budget, 500))
      budget -= text.length
      return text
    }
    if (item == null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item !== 'object') return String(item).slice(0, 80)
    if (seen.has(item)) return '[circular]'
    seen.add(item)
    if (item instanceof Error || Object.prototype.toString.call(item) === '[object Error]') {
      const error = item as Error & { code?: string }
      return clean({ name: error.name, message: error.message, code: error.code }, depth + 1)
    }
    if (Array.isArray(item)) return item.slice(0, 16).map(value => clean(value, depth + 1))
    const result: PlaybackLogFields = {}
    for (const key of Object.keys(item).slice(0, 24)) {
      if (budget <= 0) break
      budget -= key.length
      result[key] = /cookie|authorization|token|vkey|ticket|signature|password|secret|api[_-]?key|headers|script|^(?:p_)?skey$|^(?:sign|sig|uin)$|^user_?id$/i.test(key)
        ? '[redacted]' : clean((item as PlaybackLogFields)[key], depth + 1)
    }
    return result
  }
  return clean(value, 0)
}

const writer = createDebugLogWriter(fs, BackgroundTimer, `${fs.privateStorageDirectoryPath}/playback-debug.log`, {
  onError(error) { writeError = String((sanitizePlaybackLog(error) as { message?: string })?.message ?? 'Log write failed') },
})
const notify = () => { for (const handler of subscribers) { try { handler() } catch {} } }

export const isPlaybackLogEnabled = () => enabled
export const playbackLogId = (owner: object, kind: string) => {
  if (!enabled) return undefined
  let id = ids.get(owner)
  if (!id) { id = `${kind}-${++nextId}`; ids.set(owner, id) }
  return id
}
export const newPlaybackLogId = (kind: string) => enabled ? `${kind}-${++nextId}` : undefined
export const playbackLog = (event: string, fields?: Fields) => {
  if (!enabled) return
  try {
    writer.append(JSON.stringify({ at: new Date().toISOString(), session, event, data: sanitizePlaybackLog(typeof fields === 'function' ? fields() : fields ?? {}) }))
    notify()
  } catch {} // 诊断失败不能中断播放或产生递归日志。
}
export const playbackLogState = (event: string, state: string, fields?: Fields) => {
  if (!enabled) return
  const now = Date.now()
  const previous = lastStates.get(event)
  if (previous?.state === state && now - previous.at < 10000) return
  lastStates.set(event, { state, at: now })
  if (lastStates.size > 64) lastStates.delete(lastStates.keys().next().value!)
  playbackLog(event, fields)
}
export const getPlaybackLogSnapshot = () => {
  const result: Record<string, PlaybackLogFields> = { log: { enabled, session, writeError } }
  for (const [name, provider] of providers) {
    try { result[name] = sanitizePlaybackLog(provider()) as PlaybackLogFields } catch { result[name] = { error: 'Snapshot unavailable' } }
  }
  return result
}
export const registerPlaybackLogSnapshot = (name: string, provider: () => PlaybackLogFields) => {
  providers.set(name, provider)
  playbackLog('snapshot.registered', () => ({ name, ...provider() }))
  return () => { if (providers.get(name) === provider) providers.delete(name) }
}
export const setPlaybackLogEnabled = (value: boolean) => {
  if (value === enabled) return
  if (!value) playbackLog('log.disabled')
  enabled = value
  lastStates.clear()
  ids = new WeakMap()
  if (value) playbackLog('log.enabled', getPlaybackLogSnapshot)
  else void writer.flush().catch(() => {})
  notify()
}
export const flushPlaybackLogs = async() => { await writer.flush() }
export const clearPlaybackLogs = async() => {
  await writer.clear()
  writeError = ''
  lastStates.clear()
  playbackLog('log.cleared', getPlaybackLogSnapshot)
  notify()
}
export const readPlaybackLogs = async(preview = false) => {
  const text = await writer.read()
  if (!preview) return text
  let size = 0
  const lines: string[] = []
  for (const line of text.trimEnd().split('\n').reverse()) {
    size += utf8Size(line)
    if (size > 64 * 1024 || lines.length >= 200) break
    lines.push(line)
  }
  return lines.reverse().join('\n')
}
export const exportPlaybackLogs = async() => {
  playbackLog('snapshot.export', getPlaybackLogSnapshot)
  return `LX Music playback diagnostic\n${JSON.stringify(getPlaybackLogSnapshot(), null, 2)}\n\n${await readPlaybackLogs()}`
}
export const onPlaybackLogUpdate = (handler: () => void) => {
  subscribers.add(handler)
  return () => { subscribers.delete(handler) }
}
