import { NativeModules } from 'react-native'
import BackgroundTimer from 'react-native-background-timer'
import { throwIfAborted, withAbort } from '@/utils/abort'

export interface RemoteAudioInfo {
  readable: boolean
  /** Opaque, in-process receipt. Never accepted without a fresh native confirmation. */
  diskProof?: string
  /** HTTP 重定向后的最终地址，供播放器和下载器复用已经核对过的媒体。 */
  resolvedUrl?: string
  durationMs?: number
  mime?: string
  hasVideo?: boolean
  /** 固定原因码；旧 APK 可能不返回这些诊断字段。 */
  reason?: string
  requests?: number
  bytesRead?: number
  httpStatus?: number
  elapsedMs?: number
  contentLength?: number
  audioOffset?: number
  largestRead?: number
  headerKind?: string
  method?: string
  sampleRate?: number
  bitDepth?: number
  bitRate?: number
  /** 文件自带的文本标签，仅辅助诊断，不代替实际时长/音质检查。 */
  title?: string
  artist?: string
  album?: string
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
  preferCompleteCache?: boolean
}

const cacheKey = (url: string, inspectDuration: boolean) => (inspectDuration ? 'duration:' : 'readable:') + url

// 预加载和点播复用同一份媒体检查；不持久保存含签名的地址。
const cache = new Map<string, CachedProbe>()
const diskReceipts = new Map<string, CachedProbe>()
const pending = new Map<string, ProbeTask>()
const remember = (map: Map<string, CachedProbe>, key: string, info: RemoteAudioInfo) => {
  map.delete(key)
  map.set(key, { info, expires: Date.now() + 60_000 })
  if (map.size > 32) map.delete(map.keys().next().value!)
}
const MAX_TIMEOUT_MS = 15_000
const taskPrefix = Date.now().toString(36)
let taskId = 0

export const discardRedirectedAudioProbe = (url: string, info: RemoteAudioInfo) => {
  if (!info.resolvedUrl || info.resolvedUrl === url) return
  const key = cacheKey(url, true)
  if (cache.get(key)?.info === info) cache.delete(key)
  if (diskReceipts.get('disk:' + url)?.info === info) diskReceipts.delete('disk:' + url)
}

const startProbe = (key: string, url: string, inspectDuration: boolean, timeoutMs: number, disk = false): ProbeTask => {
  const id = `${taskPrefix}-${++taskId}`
  const startedAt = Date.now()
  const native = NativeModules.UtilsModule
  const canConfirm = disk && typeof native?.startCachedAudioProbeWithHint === 'function'
  const previous = canConfirm ? diskReceipts.get(key) : undefined
  const hint = previous && previous.expires > startedAt ? previous.info.diskProof ?? '' : ''
  let finished = false
  let resolveResult!: (info: RemoteAudioInfo) => void
  const task: ProbeTask = {
    users: 0,
    promise: new Promise(resolve => { resolveResult = resolve }),
    cancel: () => { finish({ readable: false, reason: 'cancelled' }, true) },
  }
  const timer = BackgroundTimer.setTimeout(() => {
    finish({ readable: false, reason: 'timeout', elapsedMs: Date.now() - startedAt }, true)
  }, timeoutMs)
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
      if (disk) {
        if (canConfirm && info.diskProof && (info.reason === 'cache_miss' || (!info.reason && info.readable && (info.durationMs ?? 0) > 0))) {
          remember(diskReceipts, key, info)
        } else if (previous === diskReceipts.get(key)) diskReceipts.delete(key)
      } else if (!info.reason && info.readable && (!inspectDuration || (info.durationMs ?? 0) > 0)) remember(cache, key, info)
    }
    resolveResult(info)
  }
  pending.set(key, task)
  if (!disk && typeof NativeModules.UtilsModule?.startRemoteAudioProbe !== 'function') {
    finish({ readable: false, reason: 'native_unavailable' })
    return task
  }
  try {
    const request: Promise<RemoteAudioInfo | { unchangedProof: string }> = canConfirm
      ? native.startCachedAudioProbeWithHint(id, url, hint, timeoutMs)
      : disk ? native.startCachedAudioProbe(id, url, timeoutMs) : native.startRemoteAudioProbe(id, url, inspectDuration, timeoutMs)
    void request.then(info => {
      if ('unchangedProof' in info) {
        finish(hint && hint === info.unchangedProof && previous && diskReceipts.get(key) === previous
          ? previous.info : { readable: false, reason: 'cache_miss' })
      } else finish(info)
    }, () => { finish({ readable: false, reason: 'native_error' }) })
  } catch { finish({ readable: false, reason: 'native_error' }) }
  return task
}

const waitForProbe = async(task: ProbeTask, signal?: AbortSignal, budgetMs = MAX_TIMEOUT_MS) => {
  task.users++
  const local = budgetMs < MAX_TIMEOUT_MS ? new AbortController() : null
  const abort = () => { local?.abort() }
  let timer: number | undefined
  let timedOut = false
  const started = Date.now()
  try {
    if (!local) return await withAbort(task.promise, signal)
    signal?.addEventListener('abort', abort)
    throwIfAborted(signal)
    timer = BackgroundTimer.setTimeout(() => { timedOut = true; local.abort() }, budgetMs)
    return await withAbort(task.promise, local.signal)
  } catch (error) {
    throwIfAborted(signal)
    if (timedOut) return { readable: false, reason: 'timeout', elapsedMs: Date.now() - started }
    throw error
  } finally {
    if (timer !== undefined) BackgroundTimer.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    // 单个等待者取消不影响仍在使用同一个探测的播放/预加载。
    if (--task.users === 0) task.cancel()
  }
}

export const probeRemoteAudio = async(url: string, inspectDuration: boolean, options: ProbeOptions = {}): Promise<RemoteAudioInfo> => {
  throwIfAborted(options.signal)
  const diskKey = 'disk:' + url
  if (options.isRefresh) { diskReceipts.delete(diskKey); pending.delete(diskKey) }
  if (inspectDuration && options.preferCompleteCache && !options.isRefresh && typeof NativeModules.UtilsModule?.startCachedAudioProbe === 'function') {
    const disk = await waitForProbe(pending.get(diskKey) ?? startProbe(diskKey, url, true, 5000, true), options.signal)
    throwIfAborted(options.signal)
    if (disk.readable) return disk // Disk receipts and online probe results are never interchangeable.
  }
  const key = cacheKey(url, inspectDuration)
  if (options.isRefresh) cache.delete(key)
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.info
  // 慢速中转和后续 CDN 共用一个时限，无须在超时后重新取链。
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? (inspectDuration ? MAX_TIMEOUT_MS : 5_000), MAX_TIMEOUT_MS))
  const task = (options.isRefresh ? undefined : pending.get(key)) ?? startProbe(key, url, inspectDuration, MAX_TIMEOUT_MS)
  return waitForProbe(task, options.signal, timeoutMs)
}
