import { addListMusics, removeListMusics } from '@/core/list'
import { getLyricInfo, getMusicUrl, getPicPath } from '@/core/music'
import { LIST_IDS } from '@/config/constant'
import settingState from '@/store/setting/state'
import { filterFileName } from '@/utils'
import { buildLyrics } from '@/utils/lrcTools'
import {
  getDownloadActiveTasks,
  getDownloadPath,
  getDownloadTasks,
  getDownloadTasksMigrated,
  getDownloadCleanupRecords,
  getDownloadCleanupKey,
  saveDownloadCleanupRecord,
  removeDownloadCleanupRecord,
  type DownloadCleanupRecord,
  removeDownloadTasks,
  saveDownloadActiveTasks,
  saveDownloadHistory,
  saveDownloadPath,
  saveDownloadTasksMigrated,
} from '@/utils/data'
import { downloadFile, existsFile, extname, privateStorageDirectoryPath, stopDownload, temporaryDirectoryPath, unlink } from '@/utils/fs'
import { waitForPromise } from '@/utils/abortable'
import { retainTemporaryPath } from '@/utils/temporaryPaths'
import { writeDownloadMetadata } from '@/utils/localMediaMetadata'
import {
  addDownloadHistory,
  getDownloadHistoryCount,
  getDownloadHistoryByIds,
  getDownloadHistoryEntries,
  getDownloadHistoryIds,
  hasDownloadHistory,
  initDownloadHistory,
  releaseDownloadHistoryCache,
  removeDownloadHistory,
} from './downloadHistory'
import {
  enqueueDownload,
  getDownloadState,
  acknowledgeDownloadCompletion,
  getDownloadCompletionIds,
  onDownloadUpdate,
  pauseDownload as pauseNativeDownload,
  removeDownload as removeNativeDownload,
  type NativeDownloadState,
} from '@/utils/nativeModules/download'
import { toMD5 } from '@/utils/tools'
import { sizeFormate } from '@/utils/common'
import { inspectDownloadMedia, DOWNLOAD_AUDIO_HEADERS } from './downloadAudio'
import { getDownloadQuality } from './downloadQuality'
import { prepareDownloadMusicInfos } from './downloadCatalog'
import { isRequestCancelled } from '@/utils/message'
import { playbackLog } from '@/utils/playbackLog'

const tasks: LX.Download.DownloadTask[] = []
const tasksById = new Map<string, LX.Download.DownloadTask>()
const taskIdentities = new WeakMap<LX.Download.DownloadTask, symbol>()
const isCurrentTask = (task: LX.Download.DownloadTask) => tasksById.get(task.id) === task
const replaceTasks = (next: LX.Download.DownloadTask[]) => {
  tasks.splice(0, tasks.length, ...next)
  tasksById.clear()
  for (const task of next) tasksById.set(task.id, task)
}
const speedSamples = new Map<string, { bytes: number, time: number }>()
let initPromise: Promise<void> | null = null
let reconciling = false
let processing = false
// 处理过程中又来了新的 waiting 任务，需要在本轮结束后再扫一遍
let reprocess = false
let dispatchSuspended = false
let preparationGeneration = 0
const preparationWaiters = new Set<() => void>()
const notifyPreparationIdle = () => {
  if (reconciling || processing) return
  // 已有原生工作会在终态再次唤醒；不为健康的长队列一直占住一个 HeadlessTask。
  const nativeActive = tasks.some(task => task.status === 'run' || (task.status === 'waiting' && !!task.nativeId))
  if (!nativeActive && (finalizations.size || completions.length)) return
  for (const resolve of preparationWaiters) resolve()
}
// 两个原生下载槽位和少量预备任务；后处理也占名额，慢标签写入不会无限积压。
const MAX_SCHEDULED_DOWNLOADS = 4
const scheduledDownloadCount = () => tasks.reduce((count, task) => count + (
  task.status === 'resolving' || task.status === 'run' || task.status === 'finalizing' || finalizations.has(task) ||
  (task.status === 'waiting' && !!task.nativeId) ? 1 : 0
), 0)
let persistTimer: ReturnType<typeof setTimeout> | null = null
let activePersistQueue: Promise<void> = Promise.resolve()
const dirtyTasks = new Set<string>()
let catalogWrites: Promise<void> = Promise.resolve()
let listRevision = 0
let lastCount = -1
let listUsers = 0
let listOrder: Array<{ id: string, createdAt: number }> | null = null
const listCache = new Map<string, Promise<LX.Download.DownloadListItem[]>>()
interface UrlWaiter {
  resolve?: (url: string | null) => void
  reject?: (error: unknown) => void
  abort?: () => void
  cancelled: boolean
  media?: LX.Download.MediaInfo
}
const finishUrl = (waiter: UrlWaiter, url: string | null, error?: unknown, failed = false) => {
  const resolve = waiter.resolve
  const reject = waiter.reject
  waiter.resolve = waiter.reject = waiter.abort = undefined
  if (failed) reject?.(error)
  else resolve?.(url)
}
// 观察者单独建作用域：迟到的传输 Promise 只持有已清空的等待者，
// 不能在取消后继续引用 processQueue 的任务和整批上下文。
const observeUrl = (promise: Promise<string>, waiter: UrlWaiter) => {
  void promise.then(url => { finishUrl(waiter, url) }, (error: unknown) => { finishUrl(waiter, null, error, true) })
}
const createUrlRequest = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality) => {
  const controller = new AbortController()
  const waiter: UrlWaiter = { cancelled: false }
  const promise = new Promise<string | null>((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
  try {
    observeUrl(getMusicUrl({
      musicInfo,
      quality,
      isRefresh: true,
      urlSourceOrder: settingState.setting['download.urlSource'] === 'account' ? 'accountFirst' : 'sourceOnly',
      validateUrl: async(url, media, candidate) => {
        const info = await inspectDownloadMedia(musicInfo, quality, url, media, controller.signal, candidate)
        if (!waiter.cancelled && waiter.resolve) waiter.media = info
      },
      onCancel: abort => {
        if (waiter.cancelled) { try { abort() } catch {} } else if (waiter.resolve) waiter.abort = abort
      },
    }), waiter)
  } catch (error) { finishUrl(waiter, null, error, true) }
  return {
    promise,
    get media() { return waiter.media },
    cancel() {
      controller.abort()
      waiter.cancelled = true
      const abort = waiter.abort
      // 取消先结束业务等待，底层 abort 抛错或迟迟不结束也不能挡住后续下载。
      finishUrl(waiter, null)
      try { abort?.() } catch {}
    },
  }
}
const resolvingUrls = new Map<LX.Download.DownloadTask, ReturnType<typeof createUrlRequest>>()
const resolvingCatalogs = new WeakMap<LX.Download.DownloadTask, AbortController>()
const observeEnqueue = (promise: Promise<string>, waiter: UrlWaiter, taskId: string) => {
  void promise.then(nativeId => {
    if (waiter.cancelled) void removeNativeDownload(nativeId, taskId, false).catch(logDownloadError)
    else finishUrl(waiter, nativeId)
  }, (error: unknown) => { finishUrl(waiter, null, error, true) })
}
const createEnqueueRequest = (options: Parameters<typeof enqueueDownload>[0]) => {
  const waiter: UrlWaiter = { cancelled: false }
  const promise = new Promise<string | null>((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
  try { observeEnqueue(enqueueDownload(options), waiter, options.taskId) } catch (error) { finishUrl(waiter, null, error, true) }
  return { promise, cancel() { waiter.cancelled = true; finishUrl(waiter, null) } }
}
const enqueuingTasks = new Map<LX.Download.DownloadTask, ReturnType<typeof createEnqueueRequest>>()
const resumeRequests = new WeakMap<LX.Download.DownloadTask, symbol>()
const cancelTaskUrl = (task: LX.Download.DownloadTask) => {
  resolvingCatalogs.get(task)?.abort()
  resolvingCatalogs.delete(task)
  const request = resolvingUrls.get(task)
  resolvingUrls.delete(task)
  request?.cancel()
  const enqueue = enqueuingTasks.get(task)
  enqueuingTasks.delete(task)
  earlyNativeUpdates.delete(task)
  enqueue?.cancel()
}
const resolveTaskUrl = async(task: LX.Download.DownloadTask) => {
  // 恢复旧任务也要补齐公开音质信息；新任务复用缓存，不重复请求详情。
  const controller = new AbortController()
  resolvingCatalogs.set(task, controller)
  try {
    const [musicInfo] = await prepareDownloadMusicInfos([task.musicInfo], controller.signal)
    if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') return null
    if (musicInfo !== task.musicInfo && !await updateTask(task, { musicInfo }, true)) return null
  } catch (error) {
    if (isRequestCancelled(error)) return null
    throw error
  } finally {
    if (resolvingCatalogs.get(task) === controller) resolvingCatalogs.delete(task)
  }
  if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') return null
  const quality = getDownloadQuality(task.musicInfo, task.requestedQuality ?? task.quality)
  // 各音源都必须提供这一档，取链失败直接报错，不再请求更低音质。
  const request = createUrlRequest(task.musicInfo, quality)
  resolvingUrls.set(task, request)
  try {
    const url = await request.promise
    if (url !== null) playbackLog('download.quality_resolved', () => ({ taskId: task.id, musicId: task.musicInfo.id, requestedQuality: task.requestedQuality ?? task.quality, quality }))
    return url === null ? null : { url, media: request.media, quality }
  } catch (error) {
    if (!isRequestCancelled(error)) playbackLog('download.quality_failed', () => ({ taskId: task.id, musicId: task.musicInfo.id, quality, error }))
    throw error
  } finally {
    if (resolvingUrls.get(task) === request) resolvingUrls.delete(task)
  }
}
const getTotalCount = () => getDownloadHistoryCount() + tasks.reduce((count, task) => count + (hasDownloadHistory(task.id) ? 0 : 1), 0)

const notify = () => {
  listRevision++
  listCache.clear()
  listOrder = null
  const count = getTotalCount()
  if (lastCount !== count) {
    lastCount = count
    global.app_event.downloadCountUpdate(count)
  }
  global.app_event.downloadListUpdate()
}

const withCatalogWrite = async<T>(work: () => Promise<T>): Promise<T> => {
  const result = catalogWrites.then(work)
  catalogWrites = result.then(() => {}, () => {})
  return result
}

const toListItem = (task: LX.Download.DownloadTask): LX.Download.DownloadListItem => ({
  id: task.id,
  status: task.status,
  quality: task.quality,
  name: task.musicInfo?.name ?? '',
  singer: task.musicInfo?.singer ?? '',
  filePath: task.filePath,
  createdAt: task.createdAt,
  error: task.error,
  progress: { ...task.progress },
})

export const getDownloadTaskItem = (id: string) => {
  if (hasDownloadHistory(id)) return null
  const task = tasksById.get(id)
  return task ? toListItem(task) : null
}

const persistNow = async() => {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  activePersistQueue = activePersistQueue.catch(() => {}).then(async() => {
    const changed = new Set(dirtyTasks)
    dirtyTasks.clear()
    try { await saveDownloadActiveTasks(tasks, changed) } catch (error) {
      // 慢写期间的新修改留在 dirtyTasks；失败的那批也要在下一次保存重试。
      for (const id of changed) dirtyTasks.add(id)
      throw error
    }
  })
  await activePersistQueue
}

const schedulePersist = () => {
  if (persistTimer) return
  // 下载中进度每秒变一次，没必要每秒把整份任务数组序列化一遍；
  // 合并到 3 秒，进程被杀最多丢几秒进度
  persistTimer = setTimeout(() => { void persistNow().catch(logDownloadError) }, 3000)
}

const logDownloadError = (error: unknown) => {
  console.warn('[Download]', error instanceof Error ? error.message : error)
}

const extensionForQuality = (quality: LX.Quality): LX.Download.FileExt => {
  switch (quality) {
    case 'flac':
    case 'flac24bit': return 'flac'
    case 'wav': return 'wav'
    case 'ape': return 'ape'
    default: return 'mp3'
  }
}

const mimeForExtension = (extension: LX.Download.FileExt) => {
  switch (extension) {
    case 'flac': return 'audio/flac'
    case 'wav': return 'audio/wav'
    case 'ape': return 'audio/ape'
    default: return 'audio/mpeg'
  }
}

const buildFileName = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality, extension = extensionForQuality(quality)) => {
  const name = settingState.setting['download.fileName']
    .replace('歌名', musicInfo.name)
    .replace('歌手', musicInfo.singer || '未知歌手')
  return `${filterFileName(name).trim() || musicInfo.id}.${extension}`
}

/**
 * 接口对每档音质都给了一个带单位的大小字符串（sizeFormate 出来的是 "10.33 MiB"，
 * 酷我那边直接是 "10.33M"），换算成字节，用来核对下载结果。
 */
const parseQualitySize = (size?: string | null): number => {
  if (!size) return 0
  const matched = /^([\d.]+)\s*([KMGT]?)/i.exec(size.trim())
  if (!matched) return 0
  const value = Number(matched[1])
  if (!Number.isFinite(value) || value <= 0) return 0
  const unit = matched[2].toUpperCase()
  const power = unit == 'K' ? 1 : unit == 'M' ? 2 : unit == 'G' ? 3 : unit == 'T' ? 4 : 0
  return Math.round(value * 1024 ** power)
}

/**
 * 落盘大小和接口给的对不上，说明拿到的不是这首歌 / 这个音质。
 * 实际踩过：上次没下完的中转文件被接着续传，最后复制出去一个 30M 的文件
 * （正常的 320k 只有 10M 左右），而原来整条链路没有任何校验，坏文件照样进本地列表。
 */
const isSizeAbnormal = (actual: number, expected: number) => {
  if (actual <= 0) return true
  // 接口没给大小时没法判断，放过去
  if (expected <= 0) return false
  return actual > expected * 1.5 || actual < expected * 0.5
}

/** 清掉下载中转文件：重下时不会接着上次的错误数据续传 */
const clearPartialFile = async(taskId: string) => {
  try {
    await unlink(`${privateStorageDirectoryPath}/downloads/${taskId}.part`)
  } catch {}
}

// 文件依赖每次操作会创建原生线程；只让少量操作进入原生层，
// 不为整批歌曲预先创建一份在途 Promise/回调。
let runningFileOperations = 0
const fileOperationWaiters: Array<() => void> = []
const withFileOperation = async(action: () => Promise<void>) => {
  if (runningFileOperations >= 4) await new Promise<void>(resolve => { fileOperationWaiters.push(resolve) })
  else runningFileOperations++
  try { await action() } finally {
    const next = fileOperationWaiters.shift()
    if (next) next()
    else runningFileOperations--
  }
}
const forEachFileOperation = async<T>(items: readonly T[], action: (item: T) => Promise<void>) => {
  let next = 0
  let failure: unknown
  let failed = false
  const worker = async() => {
    while (next < items.length) {
      const item = items[next++]
      try { await withFileOperation(async() => action(item)) } catch (error) {
        if (!failed) { failed = true; failure = error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
  if (failed) throw failure
}

const cleanupRecords = new Map<string, DownloadCleanupRecord>()
const cleanupRuns = new Map<string, Promise<void>>()
const rejectedFileRuns = new Map<string, Promise<void>>()
let cleanupSequence = 0
const saveCleanup = async(record: DownloadCleanupRecord) => {
  const identity = `${Date.now().toString(36)}_${++cleanupSequence}_${Math.random().toString(36).slice(2)}`
  const key = getDownloadCleanupKey?.(identity) ?? '@download_cleanup__' + identity
  await saveDownloadCleanupRecord?.(key, record)
  cleanupRecords.set(key, record)
  return key
}
const isPartialCleanupPath = (target: DownloadCleanupRecord['targets'][number]) =>
  target.filePath === `${privateStorageDirectoryPath}/downloads/${target.id}.part`

const rejectedTargetMatches = (target: DownloadCleanupRecord['targets'][number], identity?: symbol) => {
  const current = tasksById.get(target.id)
  if (!current || (identity && taskIdentities.get(current) !== identity)) return false
  if (target.nativeId && current.nativeId === target.nativeId && (!current.filePath || current.filePath === target.filePath)) return true
  if (current.filePath !== target.filePath) return false
  return current.nativeId === target.nativeId ||
    (current.status === 'error' && !current.nativeId && !current.pendingCompletion)
}
// Synchronous mutations keep the asynchronous cleanup context limited to IDs and paths.
const classifyRejectedTask = (record: DownloadCleanupRecord, error?: string, identity?: symbol) => {
  let changed = false
  for (const target of record.targets) {
    if (!target.filePath || isPartialCleanupPath(target) || !rejectedTargetMatches(target, identity)) continue
    const current = tasksById.get(target.id)!
    current.status = 'error'
    current.nativeId = undefined
    current.filePath = target.filePath
    delete current.pendingCompletion
    current.error = error ?? current.error ?? global.i18n.t('download_status_failed')
    current.progress = { progress: 0, downloaded: 0, total: 0, speed: '' }
    dirtyTasks.add(current.id)
    global.app_event.downloadTaskUpdate(toListItem(current))
    changed = true
  }
  return changed
}
const clearRejectedTaskPaths = (record: DownloadCleanupRecord, identity?: symbol) => {
  let changed = false
  for (const target of record.targets) {
    if (!target.filePath || isPartialCleanupPath(target) || !rejectedTargetMatches(target, identity)) continue
    const current = tasksById.get(target.id)!
    current.filePath = undefined
    dirtyTasks.add(current.id)
    global.app_event.downloadTaskUpdate(toListItem(current))
    changed = true
  }
  return changed
}
const canDeleteRejectedTarget = (target: DownloadCleanupRecord['targets'][number], identity?: symbol) => {
  const current = tasksById.get(target.id)
  return current?.filePath !== target.filePath || rejectedTargetMatches(target, identity)
}
const runCleanup = async(key: string, record: DownloadCleanupRecord, rejectedIdentity?: symbol) => {
  // 墓碑先落盘；任何阶段失败都保留路径，下一次操作或启动可继续。
  const fileTargets = record.kind === 'files' ? record.targets.filter(target => !isPartialCleanupPath(target)) : record.targets
  await forEachFileOperation(fileTargets.filter(target => target.stop === true || record.kind === 'files'), async target => {
    // Specific native IDs enforce the persisted .part owner, including a newer
    // work reusing the same task ID. Never unlink a .part directly here.
    if (record.kind !== 'files' || Boolean(target.nativeId) || !tasksById.has(target.id) || rejectedTargetMatches(target, rejectedIdentity)) {
      await removeNativeDownload(target.nativeId, target.id, true)
    }
    if (!record.deleteFile || !target.nativeId) return
    const completed = await getDownloadState(target.nativeId)
    if (completed?.status === 'completed' && completed.filePath && completed.filePath !== target.filePath) {
      record.targets.push({ id: target.id, filePath: completed.filePath })
      await saveDownloadCleanupRecord?.(key, record)
    }
  })
  const completedIds = record.kind === 'files' ? fileTargets.filter(target => hasDownloadHistory(target.id)).map(target => target.id) : []
  const completedPaths = completedIds.length
    ? new Set((await getDownloadHistoryByIds(completedIds)).flatMap(item => item.filePath ? [item.filePath] : []))
    : new Set<string>()
  const paths = [...new Set(fileTargets.flatMap(target => target.filePath &&
    (record.kind !== 'files' || (canDeleteRejectedTarget(target, rejectedIdentity) && !completedPaths.has(target.filePath))) ? [target.filePath] : []))]
  if (record.deleteFile) {
    await forEachFileOperation(paths, async path => {
      if (!existsFile || await existsFile(path)) await unlink(path)
    })
    if (paths.length) await removeListMusics(LIST_IDS.LOCAL, paths)
  }
  if (record.kind === 'files') {
    // The rejection must survive before acknowledging the native receipt or
    // deleting its journal. A failed save leaves both available for recovery.
    clearRejectedTaskPaths(record, rejectedIdentity)
    await persistNow()
  }
  if (record.kind === 'remove') {
    await removeDownloadHistory(new Set(record.targets.map(target => target.id)), false)
  }
  await forEachFileOperation(record.targets.filter(target => target.nativeId), async target => {
    await acknowledgeDownloadCompletion?.(target.nativeId!)
  })
  await removeDownloadCleanupRecord?.(key)
  cleanupRecords.delete(key)
}
const executeCleanup = async(key: string, record: DownloadCleanupRecord, rejectedIdentity?: symbol) => {
  const pending = cleanupRuns.get(key)
  if (pending) return pending
  const work = runCleanup(key, record, rejectedIdentity).finally(() => {
    if (cleanupRuns.get(key) === work) cleanupRuns.delete(key)
  })
  cleanupRuns.set(key, work)
  return work
}
const retryCleanups = async(ids?: ReadonlySet<string>) => {
  for (const [key, record] of cleanupRecords) {
    if (!ids || record.targets.some(target => ids.has(target.id))) await executeCleanup(key, record)
  }
}

const markRejectedPreparationFailure = (taskId: string, identity: symbol, error: unknown) => {
  const current = tasksById.get(taskId)
  if (!current || taskIdentities.get(current) !== identity) return
  current.status = 'error'
  current.error = error instanceof Error ? error.message : String(error)
  dirtyTasks.add(taskId)
  schedulePersist()
  global.app_event.downloadTaskUpdate(toListItem(current))
}
const clearRejectedFile = async(taskId: string, path: string, nativeId: string | undefined, identity: symbol, error: string) => {
  const runKey = JSON.stringify([taskId, path, nativeId])
  const pending = rejectedFileRuns.get(runKey)
  if (pending) return pending
  const record: DownloadCleanupRecord = {
    kind: 'files',
    deleteFile: true,
    targets: [{ id: taskId, filePath: path, nativeId, stop: true }],
  }
  // Only primitive rejection data is queued; cancellation can release the
  // caller's task while the durable journal and native I/O still finish.
  const work = withCatalogWrite(async() => {
    const key = await saveCleanup(record)
    classifyRejectedTask(record, error, identity)
    await persistNow()
    return key
  }).then(async key => executeCleanup(key, record, identity)).catch((failure: unknown) => {
    markRejectedPreparationFailure(taskId, identity, failure)
    throw failure
  }).finally(() => {
    if (rejectedFileRuns.get(runKey) === work) rejectedFileRuns.delete(runKey)
  })
  rejectedFileRuns.set(runKey, work)
  return work
}

const updateTask = async(task: LX.Download.DownloadTask, update: Partial<LX.Download.DownloadTask>, immediate = false) => {
  // 同一歌曲重建会复用 ID；旧任务的异步结果只能修改原来的对象。
  if (!isCurrentTask(task)) return false
  Object.assign(task, update)
  dirtyTasks.add(task.id)
  if (immediate) await persistNow()
  else schedulePersist()
  if (!isCurrentTask(task)) return false
  global.app_event.downloadTaskUpdate(toListItem(task))
  return true
}

const calculateSpeed = (taskId: string, downloaded: number) => {
  const now = Date.now()
  const previous = speedSamples.get(taskId)
  speedSamples.set(taskId, { bytes: downloaded, time: now })
  if (!previous || now == previous.time) return ''
  const bytesPerSecond = Math.max(0, (downloaded - previous.bytes) * 1000 / (now - previous.time))
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

// 在途原生读写仍可使用封面；终态观察者只持有路径，不持有下载业务对象。
const cleanupCoverAfter = (promise: Promise<unknown>, path: string, release: () => void) => {
  const cleanup = () => { void unlink(path).catch(() => {}).finally(release) }
  void promise.then(cleanup, cleanup)
}

// Native tag writes outlive cancelled JS waiters; keep file ownership and reuse the task's result.
const taskMetadataWrites = new WeakMap<LX.Download.DownloadTask, { path: string, promise: Promise<void> }>()
const activeMetadataWrites = new Map<string, Promise<void>>()
let coverSequence = 0
const retainMetadataWrite = (path: string, promise: Promise<void>) => {
  const settled = promise.then(() => {}, () => {})
  activeMetadataWrites.set(path, settled)
  void settled.then(() => { if (activeMetadataWrites.get(path) === settled) activeMetadataWrites.delete(path) })
}
const writeEmbeddedMetadata = async(task: LX.Download.DownloadTask, signal: AbortSignal) => {
  if (!task.filePath) return
  const previous = taskMetadataWrites.get(task)
  if (previous?.path === task.filePath) {
    try { await waitForPromise(previous.promise, signal) } catch (error) { logDownloadError(error) }
    return
  }
  const info = task.musicInfo
  let picPath: string | null = null
  let releaseCover: (() => void) | null = null
  let coverIO: Promise<unknown> | null = null
  let lyricText: string | null = null
  try {
    const pic = await waitForPromise(getPicPath({ musicInfo: info, isRefresh: false, signal }), signal)
    if (pic) {
      const picExt = extname(pic.split('?')[0]) || 'jpg'
      picPath = `${temporaryDirectoryPath}/lx-download-${task.id}-${++coverSequence}-${Math.random().toString(36).slice(2)}.${picExt}`
      releaseCover = retainTemporaryPath(picPath)
      const result = downloadFile(pic, picPath)
      coverIO = result.promise
      const cancel = () => { try { stopDownload(result.jobId) } catch {} }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) cancel()
        await waitForPromise(result.promise, signal)
      } finally { signal.removeEventListener('abort', cancel) }
    }
  } catch {}

  try {
    const lyric = signal.aborted ? null : await waitForPromise(getLyricInfo({ musicInfo: info, isRefresh: false, signal }), signal)
    if (lyric?.lyric) {
      // 翻译与罗马音只要取到就一并写入。文件只写这一次，若去跟随
      // 「显示翻译/罗马音」开关，日后打开开关也不会补进已下载的文件，只能重下。
      // buildLyrics 生成 [awlrc:lrc:..,tlrc:..,rlrc:..] 这种内嵌格式，
      // 本地播放时由 core/music/local.ts 的 parseLyric 解回各个语言版本。
      lyricText = buildLyrics(lyric, true, true, true)
    }
  } catch {}
  try {
    const path = task.filePath
    for (let pending = activeMetadataWrites.get(path); pending; pending = activeMetadataWrites.get(path)) {
      await waitForPromise(pending, signal)
    }
    if (signal.aborted || !isCurrentTask(task)) return
    const writing = writeDownloadMetadata(path, {
      name: info.name,
      singer: info.singer,
      albumName: info.meta.albumName,
    }, picPath, lyricText)
    taskMetadataWrites.set(task, { path, promise: writing })
    retainMetadataWrite(path, writing)
    coverIO = writing
    await waitForPromise(writing, signal)
  } catch (error) {
    logDownloadError(error)
  } finally {
    if (picPath && releaseCover) cleanupCoverAfter(coverIO ?? Promise.resolve(), picPath, releaseCover)
  }
}

interface Completion {
  task?: LX.Download.DownloadTask
  localInfo?: LX.Music.MusicInfoLocal
  resolve?: () => void
  reject?: (error: unknown) => void
}
const completions: Completion[] = []
const pendingCompletions = new Set<Completion>()
let completionTimer: ReturnType<typeof setTimeout> | null = null

const finishCompletion = (item: Completion, error?: unknown, failed = false) => {
  const resolve = item.resolve
  const reject = item.reject
  item.task = item.localInfo = item.resolve = item.reject = undefined
  pendingCompletions.delete(item)
  if (failed) reject?.(error)
  else resolve?.()
}

const flushCompletions = () => {
  completionTimer = null
  const batch = completions.splice(0)
  void withCatalogWrite(async() => {
    const current = batch.filter((item): item is Completion & { task: LX.Download.DownloadTask, localInfo: LX.Music.MusicInfoLocal } =>
      !!item.task && !!item.localInfo && isCurrentTask(item.task))
    if (!current.length) return
    // 取消会清空 Completion 的业务引用；已经开始的存盘只保留轻量归档字段。
    const archive = current.map(({ task }) => {
      let identity = taskIdentities.get(task)
      if (!identity) { identity = Symbol('download-archive'); taskIdentities.set(task, identity) }
      return { history: toHistoryItem(task), nativeId: task.nativeId, identity }
    })
    // 连续完成的下载只写一次 LOCAL、重建一次匹配索引。
    await addListMusics(LIST_IDS.LOCAL, current.map(item => item.localInfo), 'bottom')
    await addDownloadHistory(archive.map(item => item.history))
    // 档案持久化后才确认原生凭据；确认失败保留凭据供下次启动重试。
    for (const item of archive) {
      if (item.nativeId) await (acknowledgeDownloadCompletion?.(item.nativeId) ?? Promise.resolve()).catch(logDownloadError)
    }
    for (const item of archive) {
      const task = tasksById.get(item.history.id)
      if (!task || taskIdentities.get(task) !== item.identity) continue
      const index = tasks.indexOf(task)
      if (index >= 0) tasks.splice(index, 1)
      if (isCurrentTask(task)) tasksById.delete(task.id)
      speedSamples.delete(task.id)
    }
    try { await persistNow() } finally { notify() }
  }).then(() => { batch.forEach(item => { finishCompletion(item) }) }, (error: unknown) => {
    batch.forEach(item => { finishCompletion(item, error, true) })
  })
}

const completeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState, signal: AbortSignal) => {
  if (!state.filePath || !isCurrentTask(task)) return
  // 入本地列表之前先核对大小，坏的直接判失败，不留一条播不了的记录。
  // state.downloaded 正常就是落盘字节数（原生完成事件与 WorkManager 的 output data
  // 带的都是真实长度），没带上时退回下载过程中记录的字节数
  const catalogSize = task.media && task.media.extension !== extensionForQuality(task.quality)
    ? 0 : parseQualitySize(task.musicInfo.meta._qualitys?.[task.quality]?.size)
  const actualSize = state.downloaded > 0 ? state.downloaded : task.progress.downloaded
  // Legacy raw FLAC probes trusted STREAMINFO alone. A short transfer may agree with its own Content-Length.
  const shortFlac = task.media?.extension === 'flac' && (actualSize <= 42 || (!task.media.flacFramesVerified && catalogSize > 0 && actualSize < catalogSize / 2))
  const expectedSize = shortFlac ? catalogSize : task.media?.contentLength ?? catalogSize
  if (shortFlac || (task.media?.contentLength ? actualSize !== expectedSize : isSizeAbnormal(actualSize, expectedSize))) {
    let identity = taskIdentities.get(task)
    if (!identity) { identity = Symbol('rejected-download'); taskIdentities.set(task, identity) }
    // 中转文件已经不可信，清掉，用户点重试时是干干净净重下一次
    await waitForPromise(clearRejectedFile(task.id, state.filePath, task.nativeId, identity,
      global.i18n.t('download_bad_size', {
        size: sizeFormate(actualSize),
        expect: expectedSize > 0 ? sizeFormate(expectedSize) : '-',
      })), signal)
    return
  }
  if (!await updateTask(task, {
    status: 'finalizing',
    filePath: state.filePath,
    fileName: state.fileName ?? task.fileName,
    error: undefined,
  }, true)) return
  await writeEmbeddedMetadata(task, signal)
  if (signal.aborted || !isCurrentTask(task)) return
  const localInfo: LX.Music.MusicInfoLocal = {
    id: state.filePath,
    name: task.musicInfo?.name ?? '',
    singer: task.musicInfo?.singer ?? '',
    source: 'local',
    interval: task.musicInfo.interval ?? null,
    meta: {
      albumName: task.musicInfo.meta.albumName,
      filePath: state.filePath,
      songId: state.filePath,
      picUrl: task.musicInfo.meta.picUrl,
      ext: task.media?.extension ?? extensionForQuality(task.quality),
      toggleMusicInfo: task.musicInfo,
    },
  }
  // 写元数据要花几秒（下载封面 + 取歌词），这期间任务可能已被删除
  // （批量删除尤其容易发生：它会把仍在 finalizing 的任务一并删掉并解除文件）。
  // 不检查的话会给一个刚被删掉的文件补一条本地记录，留下播不了的条目。
  if (signal.aborted || !isCurrentTask(task)) return
  await new Promise<void>((resolve, reject) => {
    const item = { task, localInfo, resolve, reject }
    completions.push(item)
    pendingCompletions.add(item)
    completionTimer ??= setTimeout(flushCompletions, 250)
  })
}

// 标签/封面/歌词后处理只运行两项，排队任务可在删除时直接移除。
interface FinalizeJob {
  task: LX.Download.DownloadTask
  state: NativeDownloadState
  controller: AbortController
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}
const finalizations = new Map<LX.Download.DownloadTask, FinalizeJob>()
const finalizeJobs: FinalizeJob[] = []
let runningFinalizations = 0
const executeFinalization = async(job: FinalizeJob) => {
  const { task, state, controller } = job
  try {
    if (!controller.signal.aborted) await completeTask(task, state, controller.signal)
    job.resolve()
  } catch (error) {
    if (!controller.signal.aborted && isCurrentTask(task)) {
      task.status = 'error'
      task.error = error instanceof Error ? error.message : String(error)
      dirtyTasks.add(task.id)
      schedulePersist()
      global.app_event.downloadTaskUpdate(toListItem(task))
    }
    if (controller.signal.aborted) job.resolve()
    else job.reject(error)
  } finally {
    if (finalizations.get(task) === job) finalizations.delete(task)
    void processQueue().catch(logDownloadError)
    notifyPreparationIdle()
  }
}
const runFinalizations = () => {
  if (dispatchSuspended) return
  while (runningFinalizations < 2 && finalizeJobs.length) {
    const job = finalizeJobs.shift()!
    runningFinalizations++
    void executeFinalization(job).finally(() => {
      runningFinalizations--
      runFinalizations()
    })
  }
}
const cancelFinalization = (task: LX.Download.DownloadTask) => {
  const job = finalizations.get(task)
  if (job) {
    finalizations.delete(task)
    const index = finalizeJobs.indexOf(job)
    if (index >= 0) finalizeJobs.splice(index, 1)
    job.controller.abort()
    job.resolve()
  }
  for (const item of pendingCompletions) {
    if (item.task !== task) continue
    const index = completions.indexOf(item)
    if (index >= 0) completions.splice(index, 1)
    finishCompletion(item)
  }
  if (!completions.length && completionTimer) {
    clearTimeout(completionTimer)
    completionTimer = null
  }
}
const finalizeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState) => {
  if (!state.filePath || task.status === 'completed') return
  const pending = finalizations.get(task)
  if (pending) return pending.promise
  task.status = 'finalizing'
  task.filePath = state.filePath
  task.fileName = state.fileName ?? task.fileName
  task.pendingCompletion = {
    downloaded: state.downloaded > 0 ? state.downloaded : task.progress.downloaded,
    total: state.total || task.progress.total,
  }
  task.error = undefined
  dirtyTasks.add(task.id)
  schedulePersist()
  global.app_event.downloadTaskUpdate(toListItem(task))
  let callbacks!: { resolve: () => void, reject: (error: unknown) => void }
  const result = new Promise<void>((resolve, reject) => { callbacks = { resolve, reject } })
  const job = { task, state, controller: new AbortController(), promise: result, ...callbacks }
  finalizeJobs.push(job)
  finalizations.set(task, job)
  runFinalizations()
  return result
}

const resumeFinalization = (task: LX.Download.DownloadTask) => {
  if (!task.pendingCompletion || !task.filePath) return false
  void finalizeTask(task, {
    ...task.pendingCompletion,
    status: 'completed',
    taskId: task.id,
    nativeId: task.nativeId ?? '',
    filePath: task.filePath,
    fileName: task.fileName,
  }).catch(logDownloadError)
  return true
}

const earlyNativeUpdates = new Map<LX.Download.DownloadTask, Map<string, NativeDownloadState>>()
const handleNativeUpdate = (state: NativeDownloadState) => {
  if (!state.taskId) return
  const task = tasksById.get(state.taskId)
  if (!task || hasDownloadHistory(task.id)) return
  if (state.nativeId && state.nativeId !== task.nativeId) {
    // enqueue 的 Promise 回来之前可能先收到进度；只暂存本次入队期间的事件，
    // 拿到 workId 后再匹配，旧 worker 的迟到事件不能接管重试中的任务。
    const early = !task.nativeId && earlyNativeUpdates.get(task)
    if (early) {
      early.delete(state.nativeId)
      early.set(state.nativeId, state)
      while (early.size > 4) early.delete(early.keys().next().value!)
    }
    return
  }
  if (task.status === 'pause' && state.status !== 'completed') return
  if (task.pendingCompletion && state.status !== 'completed') return
  // 不在下载中就丢掉速度采样：暂停/出错后恢复时不该拿上一次的旧采样算速度，
  // 任务结束后也没必要一直留着这个 Map 条目
  if (state.status != 'run') speedSamples.delete(task.id)
  if (state.status == 'completed') {
    void finalizeTask(task, state).catch(logDownloadError)
    return
  }
  if (task.status === 'finalizing') return
  const progress = state.total > 0 ? state.downloaded / state.total : 0
  void updateTask(task, {
    nativeId: state.nativeId || task.nativeId,
    status: state.status,
    error: state.error,
    progress: {
      progress,
      downloaded: state.downloaded,
      total: state.total,
      speed: state.status == 'run' ? calculateSpeed(task.id, state.downloaded) : '',
    },
  }, state.status == 'error').then(() => {
    if (state.status === 'error' || state.status === 'pause') void processQueue().catch(logDownloadError)
  }).catch(logDownloadError)
}

const reconcileTask = async(task: LX.Download.DownloadTask) => {
  if (task.status == 'completed' || task.status == 'pause') return
  if (resumeFinalization(task)) return
  if (!task.nativeId) {
    // 取链尚未完成时退出，重启后没有原生 work 可恢复，需要重新进入取链队列。
    if (task.status === 'resolving') task.status = 'waiting'
    return
  }
  const nativeId = task.nativeId
  try {
    const state = await getDownloadState(nativeId)
    const currentTask = (isCurrentTask(task) ? task : undefined)
    if (!currentTask || currentTask.nativeId !== nativeId || currentTask.status === 'pause') return
    if (!state) {
      task.status = 'waiting'
      task.nativeId = undefined
      return
    }
    if (state.status == 'completed') void finalizeTask(task, state).catch(logDownloadError)
    else if (state.status == 'pause') {
      task.status = 'waiting'
      task.nativeId = undefined
    } else handleNativeUpdate({ ...state, taskId: task.id })
  } catch (error) {
    const currentTask = (isCurrentTask(task) ? task : undefined)
    if (!currentTask || currentTask.nativeId !== nativeId || currentTask.status === 'pause') return
    // 查询失败不能当作原生 work 不存在，否则会取消仍在运行的下载并重新取链。
    currentTask.status = 'error'
    currentTask.error = error instanceof Error ? error.message : global.i18n.t('download_status_failed')
  }
}

const processQueue = async() => {
  if (reconciling || dispatchSuspended) return
  if (processing) {
    // 本轮还没跑完又有人把任务置为 waiting（逐个恢复、批量添加都会）：
    // 记一笔，让本轮结束后再从头扫一遍。直接 return 的话，被恢复的任务如果
    // 排在游标前面就永远不会被处理——从下往上逐个点「继续」时，上面的任务
    // 会一直停在等待中，就是这个原因。
    reprocess = true
    return
  }
  processing = true
  try {
    do {
      reprocess = false
      // 先快照 id：循环里的 await 期间可能完成/归档别的任务，
      // 直接遍历 tasks 会被 splice 打乱迭代器、跳过下一项
      for (const id of tasks.map(task => task.id)) {
        if (dispatchSuspended) break
        if (scheduledDownloadCount() >= MAX_SCHEDULED_DOWNLOADS) break
        const task = tasksById.get(id)
        if (!task || task.status != 'waiting' || task.nativeId) continue
        try {
          await updateTask(task, { status: 'resolving', error: undefined }, true)
          if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          const resolved = await resolveTaskUrl(task)
          if (resolved === null) continue
          const currentTask = (isCurrentTask(task) ? task : undefined)
          if (currentTask?.status != 'resolving') continue
          const media = resolved.media
          const representationChanged = task.quality !== resolved.quality || task.media?.extension !== media?.extension ||
            task.media?.contentLength !== media?.contentLength
          if (representationChanged || (media && !task.media)) {
            // A new representation cannot resume an old codec's bytes.
            const partial = `${privateStorageDirectoryPath}/downloads/${task.id}.part`
            try { await unlink(partial) } catch (error) { if (await existsFile(partial)) throw error }
          }
          if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          if ((media != null || task.media != null || representationChanged) && !await updateTask(task, {
            media,
            quality: resolved.quality,
            fileName: buildFileName(task.musicInfo, resolved.quality, media?.extension),
          }, true)) continue
          if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          const early = new Map<string, NativeDownloadState>()
          earlyNativeUpdates.set(task, early)
          try {
            const request = createEnqueueRequest({
              taskId: task.id,
              url: resolved.url,
              headers: DOWNLOAD_AUDIO_HEADERS,
              treeUri: task.directoryUri,
              fileName: task.fileName,
              mimeType: task.media?.mimeType ?? mimeForExtension(extensionForQuality(task.quality)),
            })
            enqueuingTasks.set(task, request)
            const nativeId = await request.promise
            if (nativeId === null) continue
            const enqueuedTask = (isCurrentTask(task) ? task : undefined)
            if (!enqueuedTask || enqueuedTask.status === 'pause') {
              await removeNativeDownload(nativeId, task.id, false).catch(() => {})
              continue
            }
            await updateTask(task, { nativeId, status: enqueuedTask.status === 'resolving' ? 'waiting' : enqueuedTask.status }, true)
            const pending = early.get(nativeId)
            if (pending && getDownloadTaskItem(task.id)?.status === 'waiting') handleNativeUpdate(pending)
          } finally {
            enqueuingTasks.delete(task)
            earlyNativeUpdates.delete(task)
          }
        } catch (error: unknown) {
          if (!isCurrentTask(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          await updateTask(task, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }, true)
        }
      }
    } while (reprocess)
  } finally {
    processing = false
    notifyPreparationIdle()
  }
}

const toHistoryItem = (task: LX.Download.DownloadTask): LX.Download.DownloadHistoryItem => ({
  id: task.id,
  // 旧/损坏数据可能缺 musicInfo，不能让一条坏记录阻断启动
  name: task.musicInfo?.name ?? '',
  singer: task.musicInfo?.singer ?? '',
  quality: task.quality,
  filePath: task.filePath,
  createdAt: task.createdAt,
})

/** 启动加载：优先把旧单 key 拆成活跃/历史；失败保留旧 key，下次重试 */
const loadDownloadStorage = async() => {
  const migrated = await getDownloadTasksMigrated()
  if (!migrated) {
    const legacy = await getDownloadTasks()
    if (Array.isArray(legacy) && legacy.length) {
      const active = legacy.filter(task => task?.status !== 'completed')
      const hist = legacy.filter(task => task?.status === 'completed').map(toHistoryItem)
      await saveDownloadActiveTasks(active)
      await saveDownloadHistory(hist)
    }
    await saveDownloadTasksMigrated()
  }
  await removeDownloadTasks().catch(() => {})
  const active = await getDownloadActiveTasks()
  await initDownloadHistory()
  cleanupRecords.clear()
  for (const [key, record] of await getDownloadCleanupRecords?.() ?? []) cleanupRecords.set(key, record)
  const deleting = new Set([...cleanupRecords.values()].filter(record => record.kind === 'remove').flatMap(record => record.targets.map(target => target.id)))
  // 历史已写成功、活跃快照还没写就被杀时，按历史去重，避免再次下载/写标签。
  replaceTasks(active.filter(task => !hasDownloadHistory(task.id) && !deleting.has(task.id)))
  // An accepted files journal is a durable rejection, even if cancellation
  // happened before the previous JS instance saved its error classification.
  for (const record of cleanupRecords.values()) if (record.kind === 'files') classifyRejectedTask(record)
  if (deleting.size) await saveDownloadActiveTasks(tasks, deleting)
}

const initializeDownloads = async() => {
  if (initPromise) return initPromise
  initPromise = (async() => {
    await loadDownloadStorage()
    const directory = await getDownloadPath()
    for (const task of tasks) {
      if (!task.directoryUri && directory) task.directoryUri = directory.uri
    }
    onDownloadUpdate(handleNativeUpdate)
    notify()
    reconciling = true
    // 状态查询和元数据补写不阻塞首页，也不阻塞下载页读取已有快照。
    void (async() => {
      for (const receipt of await getDownloadCompletionIds?.() ?? []) {
        if (hasDownloadHistory(receipt.taskId)) await (acknowledgeDownloadCompletion?.(receipt.nativeId) ?? Promise.resolve()).catch(logDownloadError)
        else {
          const task = tasksById.get(receipt.taskId)
          // enqueue 已完成但保存 workId 前被杀，也能按 taskId 接回完成文件。
          if (task && !task.nativeId && (task.status === 'resolving' || task.status === 'waiting')) task.nativeId = receipt.nativeId
        }
      }
      try { await retryCleanups() } catch (error) { logDownloadError(error) }
      for (const task of [...tasks]) {
        if (isCurrentTask(task)) await reconcileTask(task)
      }
    })().catch(logDownloadError).finally(() => {
      reconciling = false
      for (const task of tasks) dirtyTasks.add(task.id)
      notify()
      void persistNow().catch(logDownloadError)
      void processQueue().catch(logDownloadError)
    })
  })().catch((error: unknown) => {
    initPromise = null
    throw error
  })
  return initPromise
}
const init = initializeDownloads
const resumeDispatch = (invalidatePreparations = true) => {
  if (invalidatePreparations) preparationGeneration++
  dispatchSuspended = false
  for (const task of tasks) {
    if (task.status === 'finalizing' && task.pendingCompletion && !finalizations.has(task)) resumeFinalization(task)
  }
  runFinalizations()
  void processQueue().catch(logDownloadError)
}
const reconcileCompletedDownloads = async() => {
  for (const receipt of await getDownloadCompletionIds?.() ?? []) {
    if (hasDownloadHistory(receipt.taskId)) {
      await (acknowledgeDownloadCompletion?.(receipt.nativeId) ?? Promise.resolve()).catch(logDownloadError)
      continue
    }
    const task = tasksById.get(receipt.taskId)
    if (!task || (task.nativeId && task.nativeId !== receipt.nativeId)) continue
    if (!task.nativeId && task.status !== 'resolving' && task.status !== 'waiting') continue
    task.nativeId = receipt.nativeId
    const state = await getDownloadState(receipt.nativeId)
    if (!isCurrentTask(task) || task.nativeId !== receipt.nativeId || state?.status !== 'completed') continue
    handleNativeUpdate({ ...state, taskId: task.id })
  }
}
export const initDownloads = async() => {
  await initializeDownloads()
  resumeDispatch()
}

// HeadlessTask 保持运行到取链、标签与归档结束，原生排队下载不需要占住 JS 等待。
export const preparePendingDownloads = async(signal: AbortSignal, shouldSuspend: () => boolean = () => false) => {
  await waitForPromise(Promise.resolve(), signal)
  const generation = ++preparationGeneration
  const cancel = () => {
    if (generation !== preparationGeneration || !shouldSuspend()) return
    dispatchSuspended = true
    for (const task of tasks) {
      if (task.status !== 'resolving') continue
      task.status = 'waiting'
      dirtyTasks.add(task.id)
      cancelTaskUrl(task)
    }
    for (const task of finalizations.keys()) cancelFinalization(task)
    schedulePersist()
    notify()
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let ready: (() => void) | undefined
  try {
    dispatchSuspended = false
    await waitForPromise(initializeDownloads(), signal)
    // JS 实例仍在但旧广播没有送达时，也直接消费原生持久完成凭据。
    await waitForPromise(reconcileCompletedDownloads(), signal)
    resumeDispatch(false)
    const idle = new Promise<void>(resolve => {
      ready = resolve
      preparationWaiters.add(resolve)
      notifyPreparationIdle()
    })
    await waitForPromise(idle, signal)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (ready) preparationWaiters.delete(ready)
  }
}

export const getDownloadCount = async() => {
  await init()
  return getTotalCount()
}
export const getDownloadIds = async() => {
  await init()
  return [...new Set([...tasks.map(task => task.id), ...getDownloadHistoryIds()])]
}
export const isDownloadCompleted = hasDownloadHistory
export const hasDownloadTask = (id: string) => hasDownloadHistory(id) || tasks.some(task => task.id === id)

export const retainDownloadList = () => { listUsers++ }
export const releaseIdleDownloadCaches = () => {
  if (listUsers) return
  listCache.clear()
  listOrder = null
  releaseDownloadHistoryCache()
}
export const releaseDownloadList = () => {
  listUsers = Math.max(0, listUsers - 1)
  releaseIdleDownloadCaches()
}

/** 只读取下载页已展开的部分；进度事件不使列表失效，多订阅者共用同一个快照。 */
export const getDownloadList = async(limit = 100, offset = 0): Promise<LX.Download.DownloadListItem[]> => {
  await init()
  const key = `${offset}_${limit}`
  const cached = listCache.get(key)
  if (cached) return cached
  const revision = listRevision
  listOrder ??= [...tasks.filter(task => !hasDownloadHistory(task.id)).map(task => ({ id: task.id, createdAt: task.createdAt })), ...getDownloadHistoryEntries()]
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  const page = listOrder.slice(offset, offset + limit)
  const promise = getDownloadHistoryByIds(page.filter(item => hasDownloadHistory(item.id)).map(item => item.id)).then(async history => {
    if (revision !== listRevision) return getDownloadList(limit, offset)
    const completed = new Map(history.map(item => [item.id, item]))
    return page.flatMap(({ id }) => {
      const active = getDownloadTaskItem(id)
      if (active) return [active]
      const item = completed.get(id)
      return item ? [{ ...item, status: 'completed' as const }] : []
    })
  }).catch((error: unknown) => {
    if (listCache.get(key) === promise) listCache.delete(key)
    throw error
  }).finally(() => {
    releaseIdleDownloadCaches()
  })
  listCache.set(key, promise)
  while (listCache.size > 2) listCache.delete(listCache.keys().next().value!)
  return promise
}

/**
 * 批量添加下载任务。逐首调用 addTask 的代价是每首都要读一次下载目录、
 * O(n) 扫两遍查重、把整份任务列表落盘一次、再发一次 downloadListUpdate：
 * 一次全选下载 255 首就是 255 次全量写盘和 255 次列表刷新，界面会卡住一段时间。
 * 这里和 removeTasks 一样，只落盘一次、只通知一次。
 */
const addTasksToCatalog = async(musicInfos: LX.Music.MusicInfoOnline[], quality: LX.Quality) => {
  const directory = await getDownloadPath()
  if (!directory) throw new Error(global.i18n.t('download_path_required'))
  // Bound each song by its QQ catalog, independently of account permissions.
  const planned = musicInfos.map(musicInfo => {
    const targetQuality = getDownloadQuality(musicInfo, quality)
    playbackLog('download.quality_plan', () => ({ musicId: musicInfo.id, requestedQuality: quality, targetQuality }))
    return { musicInfo, targetQuality }
  })
  if (cleanupRecords.size) await retryCleanups(new Set(planned.map(({ musicInfo, targetQuality }) => toMD5(`${musicInfo.source}_${musicInfo.id}_${targetQuality}_${directory.uri}`))))
  // 同 ID 的待清文件先处理完；其他失败清理不阻塞新歌曲。
  const existing = new Set<string>(getDownloadHistoryIds())
  for (const task of tasks) {
    if (task.status == 'error') continue
    existing.add(task.id)
  }
  const added: LX.Download.DownloadTask[] = []
  for (const { musicInfo, targetQuality } of planned) {
    const id = toMD5(`${musicInfo.source}_${musicInfo.id}_${targetQuality}_${directory.uri}`)
    if (existing.has(id)) continue
    existing.add(id)
    added.push({
      id,
      musicInfo,
      quality: targetQuality,
      requestedQuality: targetQuality,
      status: 'waiting',
      progress: { progress: 0, downloaded: 0, total: 0, speed: '' },
      fileName: buildFileName(musicInfo, targetQuality),
      directoryUri: directory.uri,
      createdAt: Date.now(),
    })
  }
  if (!added.length) return []
  // 这批都是新建的任务（同 id 的老任务要么不存在、要么已失败），
  // 先清掉残留的中转文件，免得接着上次的旧数据续传出一个大小不对的文件
  await forEachFileOperation(added, async task => clearPartialFile(task.id))
  const addedIds = new Set(added.map(task => task.id))
  // 同 id 的旧任务(一定是 error，否则上面就跳过了)先移除，再整批放到最前面，顺序与传入一致
  const kept = tasks.filter(task => !addedIds.has(task.id))
  replaceTasks([...added, ...kept])
  for (const task of added) dirtyTasks.add(task.id)
  await persistNow()
  notify()
  void processQueue().catch(logDownloadError)
  return added.map(task => task.id)
}

export const addTasks = async(musicInfos: LX.Music.MusicInfoOnline[], quality: LX.Quality = settingState.setting['download.quality']) => {
  await init()
  resumeDispatch()
  // 先探测公开曲库音质，再按歌曲上限登记/查重；网络等待不占用目录操作队列。
  const prepared = await prepareDownloadMusicInfos(musicInfos)
  // 查重、清理旧文件和登记任务共用目录队列：等待期间另一批不能覆盖
  // 同一任务，删除中的原生 worker 也必须先停下，才可复用其 .part。
  return withCatalogWrite(async() => addTasksToCatalog(prepared, quality))
}

const preparePause = (task: LX.Download.DownloadTask) => {
  if (!isCurrentTask(task) || task.status == 'completed' || task.status == 'finalizing') return
  // 等待目录/原生取消时仍可能显示 pause，重复暂停也必须作废旧恢复。
  resumeRequests.delete(task)
  if (task.status == 'pause') return
  const nativeId = task.nativeId
  task.status = 'pause'
  cancelTaskUrl(task)
  task.progress.speed = ''
  dirtyTasks.add(task.id)
  return nativeId
}

export const pauseTask = async(id: string) => {
  await init()
  const task = tasksById.get(id)
  if (!task) return
  const nativeId = preparePause(task)
  await persistNow()
  notify()
  if (nativeId) await withFileOperation(async() => pauseNativeDownload(nativeId))
  void processQueue().catch(logDownloadError)
}

const prepareResume = (task: LX.Download.DownloadTask) => {
  if (!isCurrentTask(task) || task.status == 'completed' || task.status == 'finalizing') return
  if (resumeFinalization(task)) return
  const request = Symbol('download-resume')
  resumeRequests.set(task, request)
  cancelTaskUrl(task)
  return { task, request }
}
const retryTaskInternal = async({ task, request }: NonNullable<ReturnType<typeof prepareResume>>,
  directoryPromise: Promise<LX.Download.DownloadDirectory | null>, persist: boolean, process: boolean) => {
  const isCurrent = () => resumeRequests.get(task) === request && isCurrentTask(task) &&
    task.status !== 'completed' && task.status !== 'finalizing' && !task.pendingCompletion
  try {
    await retryCleanups(new Set([task.id]))
    const directory = await directoryPromise
    if (!isCurrent()) return
    if (!directory) throw new Error(global.i18n.t('download_path_required'))
    // 等旧 worker 停止后才复用 .part；保留断点续传的进度。
    if (task.nativeId) await removeNativeDownload(task.nativeId, task.id, false).catch(() => {})
    if (!isCurrent()) return
    task.directoryUri = directory.uri
    task.nativeId = undefined
    task.status = 'waiting'
    task.error = undefined
    task.progress.speed = ''
    dirtyTasks.add(task.id)
    if (persist) {
      await persistNow()
      if (!isCurrent()) return
      notify()
    }
    if (process) void processQueue().catch(logDownloadError)
  } catch (error) {
    if (isCurrent()) throw error
  } finally {
    if (resumeRequests.get(task) === request) resumeRequests.delete(task)
  }
}

export const retryTask = async(id: string) => {
  await init()
  resumeDispatch()
  const task = tasksById.get(id)
  const request = task && prepareResume(task)
  if (request) await withFileOperation(async() => retryTaskInternal(request, getDownloadPath(), true, true))
}

export const pauseAllTasks = async() => {
  await init()
  // 先同步暂停所有任务并作废在途恢复，再限制原生操作的并发。
  const nativeIds = tasks.map(preparePause).filter((id): id is string => !!id)
  try {
    await forEachFileOperation(nativeIds, async nativeId => pauseNativeDownload(nativeId))
  } finally {
    // 批量操作只落盘/通知一次，避免 N 个任务各写一遍整份数组
    await persistNow()
    notify()
  }
}

export const resumeAllTasks = async() => {
  await init()
  resumeDispatch()
  const requests = tasks.filter(task => task.status === 'pause' || task.status === 'error')
    .map(prepareResume).filter((request): request is NonNullable<typeof request> => !!request)
  try {
    if (requests.length) {
      const directory = getDownloadPath()
      void directory.catch(() => {})
      await forEachFileOperation(requests, async request => retryTaskInternal(request, directory, false, false))
    }
  } finally {
    await persistNow()
    notify()
    void processQueue().catch(logDownloadError)
  }
}

/**
 * 批量移除任务。只落盘一次、只通知一次，批量删除时不会产生 N 次写存储与重渲染。
 * 活跃和历史同时查。
 */
export const removeTasks = async(ids: string[], deleteFile = false) => {
  await init()
  return withCatalogWrite(async() => {
    const idSet = new Set(ids)
    try {
      await retryCleanups(idSet)
      const selected = [...idSet].filter(id => tasksById.has(id) || hasDownloadHistory(id))
      for (let offset = 0; offset < selected.length; offset += 100) {
        const page = selected.slice(offset, offset + 100)
        const pageIds = new Set(page)
        const history = deleteFile ? new Map((await getDownloadHistoryByIds(page.filter(hasDownloadHistory))).map(item => [item.id, item])) : new Map<string, LX.Download.DownloadHistoryItem>()
        if (deleteFile && page.some(id => hasDownloadHistory(id) && !history.has(id))) throw new Error('Missing download history during file cleanup')
        const record: DownloadCleanupRecord = {
          kind: 'remove',
          deleteFile,
          targets: page.map(id => {
            const task = tasksById.get(id)
            return { id, nativeId: task?.nativeId, filePath: task?.filePath ?? history.get(id)?.filePath, stop: !!task }
          }),
        }
        const key = await saveCleanup(record)
        for (const id of page) {
          const task = tasksById.get(id)
          if (!task) continue
          resumeRequests.delete(task)
          cancelTaskUrl(task)
          cancelFinalization(task)
          speedSamples.delete(id)
        }
        replaceTasks(tasks.filter(task => !pageIds.has(task.id)))
        await persistNow()
        await executeCleanup(key, record)
      }
    } finally { notify(); void processQueue().catch(logDownloadError) }
  })
}

export const setDownloadDirectory = async(directory: LX.Download.DownloadDirectory) => {
  await saveDownloadPath(directory)
}
