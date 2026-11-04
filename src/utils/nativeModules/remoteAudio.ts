import { NativeModules } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'
import { throwIfAborted, withAbort } from '@/utils/abort'

export interface RemoteAudioInfo {
  readable: boolean
  durationMs?: number
  mime?: string
}

interface CachedProbe {
  info: RemoteAudioInfo
  expires: number
}

interface ProbeTask {
  users: number
  promise: Promise<RemoteAudioInfo>
  cancel: () => void
}

export interface ProbeOptions {
  isRefresh?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

// 预加载和点播复用同一份媒体检查；不持久保存含签名的地址。
const cache = new Map<string, CachedProbe>()
const pending = new Map<string, ProbeTask>()
const taskPrefix = Date.now().toString(36)
let taskId = 0

const startProbe = (key: string, url: string, inspectDuration: boolean, timeoutMs: number): ProbeTask => {
  const id = `${taskPrefix}-${++taskId}`
  let finished = false
  let resolveResult!: (info: RemoteAudioInfo) => void
  const task: ProbeTask = {
    users: 0,
    promise: new Promise(resolve => { resolveResult = resolve }),
    cancel: () => { finish({ readable: false }, true) },
  }
  const timer = BackgroundTimer.setTimeout(() => { task.cancel() }, timeoutMs)
  const finish = (info: RemoteAudioInfo, cancelNative = false) => {
    if (finished) return
    finished = true
    BackgroundTimer.clearTimeout(timer)
    if (cancelNative) {
      try { NativeModules.UtilsModule.cancelRemoteAudioProbe(id) } catch {}
    }
    // 强制刷新可以替换旧任务；旧任务的迟到结果不能覆盖新缓存或删除新任务。
    if (pending.get(key) === task) {
      pending.delete(key)
      if (info.readable && (!inspectDuration || (info.durationMs ?? 0) > 0)) {
        cache.delete(key)
        cache.set(key, { info, expires: Date.now() + 60_000 })
        if (cache.size > 32) cache.delete(cache.keys().next().value!)
      }
    }
    resolveResult(info)
  }
  pending.set(key, task)
  try {
    const request: Promise<RemoteAudioInfo> = NativeModules.UtilsModule.startRemoteAudioProbe(id, url, inspectDuration, timeoutMs)
    void request.then(info => { finish(info) }, () => { finish({ readable: false }) })
  } catch { finish({ readable: false }) }
  return task
}

export const probeRemoteAudio = async(url: string, inspectDuration: boolean, options: ProbeOptions = {}): Promise<RemoteAudioInfo> => {
  throwIfAborted(options.signal)
  const key = `${inspectDuration ? 'duration' : 'readable'}:${url}`
  if (options.isRefresh) cache.delete(key)
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.info
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000))
  const task = (options.isRefresh ? undefined : pending.get(key)) ?? startProbe(key, url, inspectDuration, timeoutMs)
  task.users++
  try {
    return await withAbort(task.promise, options.signal)
  } finally {
    // 单个等待者取消不影响仍在使用同一个探测的播放/预加载。
    if (--task.users === 0) task.cancel()
  }
}
