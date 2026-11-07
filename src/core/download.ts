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
  removeDownloadTasks,
  saveDownloadActiveTasks,
  saveDownloadHistory,
  saveDownloadPath,
  saveDownloadTasksMigrated,
} from '@/utils/data'
import { downloadFile, extname, privateStorageDirectoryPath, temporaryDirectoryPath, unlink } from '@/utils/fs'
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
  onDownloadUpdate,
  pauseDownload as pauseNativeDownload,
  removeDownload as removeNativeDownload,
  type NativeDownloadState,
} from '@/utils/nativeModules/download'
import { toMD5 } from '@/utils/tools'
import { sizeFormate } from '@/utils/common'

const tasks: LX.Download.DownloadTask[] = []
const speedSamples = new Map<string, { bytes: number, time: number }>()
let initPromise: Promise<void> | null = null
let reconciling = false
let processing = false
// 处理过程中又来了新的 waiting 任务，需要在本轮结束后再扫一遍
let reprocess = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
let activePersistQueue: Promise<void> = Promise.resolve()
let catalogWrites: Promise<void> = Promise.resolve()
let listRevision = 0
let lastCount = -1
let listUsers = 0
let listOrder: Array<{ id: string, createdAt: number }> | null = null
const listCache = new Map<string, Promise<LX.Download.DownloadListItem[]>>()
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
  const task = tasks.find(item => item.id === id)
  return task ? toListItem(task) : null
}

const persistNow = async() => {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  activePersistQueue = activePersistQueue.catch(() => {}).then(async() => {
    await saveDownloadActiveTasks(tasks)
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

const buildFileName = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality) => {
  const name = settingState.setting['download.fileName']
    .replace('歌名', musicInfo.name)
    .replace('歌手', musicInfo.singer || '未知歌手')
  return `${filterFileName(name).trim() || musicInfo.id}.${extensionForQuality(quality)}`
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

const updateTask = async(id: string, update: Partial<LX.Download.DownloadTask>, immediate = false) => {
  const task = tasks.find(item => item.id == id)
  if (!task) return
  Object.assign(task, update)
  if (immediate) await persistNow()
  else schedulePersist()
  global.app_event.downloadTaskUpdate(toListItem(task))
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

const writeEmbeddedMetadata = async(task: LX.Download.DownloadTask) => {
  if (!task.filePath) return
  const info = task.musicInfo
  let picPath: string | null = null
  let lyricText: string | null = null
  try {
    const pic = await getPicPath({ musicInfo: info, isRefresh: false })
    if (pic) {
      const picExt = extname(pic.split('?')[0]) || 'jpg'
      picPath = `${temporaryDirectoryPath}/lx-download-${task.id}.${picExt}`
      const result = downloadFile(pic, picPath)
      await result.promise
    }
  } catch {}

  try {
    const lyric = await getLyricInfo({ musicInfo: info, isRefresh: false })
    if (lyric?.lyric) {
      // 翻译与罗马音只要取到就一并写入。文件只写这一次，若去跟随
      // 「显示翻译/罗马音」开关，日后打开开关也不会补进已下载的文件，只能重下。
      // buildLyrics 生成 [awlrc:lrc:..,tlrc:..,rlrc:..] 这种内嵌格式，
      // 本地播放时由 core/music/local.ts 的 parseLyric 解回各个语言版本。
      lyricText = buildLyrics(lyric, true, true, true)
    }
  } catch {}
  try {
    if (!tasks.includes(task)) return
    await writeDownloadMetadata(task.filePath, {
      name: info.name,
      singer: info.singer,
      albumName: info.meta.albumName,
    }, picPath, lyricText)
  } catch (error) {
    logDownloadError(error)
  } finally {
    if (picPath) await unlink(picPath).catch(() => {})
  }
}

interface Completion {
  task: LX.Download.DownloadTask
  localInfo: LX.Music.MusicInfoLocal
  resolve: () => void
  reject: (error: unknown) => void
}
const completions: Completion[] = []
let completionTimer: ReturnType<typeof setTimeout> | null = null

const flushCompletions = () => {
  completionTimer = null
  const batch = completions.splice(0)
  void withCatalogWrite(async() => {
    const current = batch.filter(item => tasks.includes(item.task))
    if (!current.length) return
    // 连续完成的下载只写一次 LOCAL、重建一次匹配索引。
    await addListMusics(LIST_IDS.LOCAL, current.map(item => item.localInfo), 'bottom')
    await addDownloadHistory(current.map(item => toHistoryItem(item.task)))
    for (const { task } of current) {
      const index = tasks.indexOf(task)
      if (index >= 0) tasks.splice(index, 1)
      speedSamples.delete(task.id)
    }
    try { await persistNow() } finally { notify() }
  }).then(() => { batch.forEach(item => { item.resolve() }) }, (error: unknown) => {
    batch.forEach(item => { item.reject(error) })
  })
}

const completeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState) => {
  if (!state.filePath || !tasks.includes(task)) return
  // 入本地列表之前先核对大小，坏的直接判失败，不留一条播不了的记录。
  // state.downloaded 正常就是落盘字节数（原生完成事件与 WorkManager 的 output data
  // 带的都是真实长度），没带上时退回下载过程中记录的字节数
  const expectedSize = parseQualitySize(task.musicInfo.meta._qualitys?.[task.quality]?.size)
  const actualSize = state.downloaded > 0 ? state.downloaded : task.progress.downloaded
  if (isSizeAbnormal(actualSize, expectedSize)) {
    delete task.pendingCompletion
    // 中转文件已经不可信，清掉，用户点重试时是干干净净重下一次
    await clearPartialFile(task.id)
    await updateTask(task.id, {
      status: 'error',
      error: global.i18n.t('download_bad_size', {
        size: sizeFormate(actualSize),
        expect: expectedSize > 0 ? sizeFormate(expectedSize) : '-',
      }),
      progress: { progress: 0, downloaded: 0, total: 0, speed: '' },
    }, true)
    return
  }
  await updateTask(task.id, {
    status: 'finalizing',
    filePath: state.filePath,
    fileName: state.fileName ?? task.fileName,
    error: undefined,
  }, true)
  await writeEmbeddedMetadata(task)
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
      ext: extensionForQuality(task.quality),
      toggleMusicInfo: task.musicInfo,
    },
  }
  // 写元数据要花几秒（下载封面 + 取歌词），这期间任务可能已被删除
  // （批量删除尤其容易发生：它会把仍在 finalizing 的任务一并删掉并解除文件）。
  // 不检查的话会给一个刚被删掉的文件补一条本地记录，留下播不了的条目。
  if (!tasks.includes(task)) return
  await new Promise<void>((resolve, reject) => {
    completions.push({ task, localInfo, resolve, reject })
    completionTimer ??= setTimeout(flushCompletions, 250)
  })
}

// 原生下载完成后即可继续下一首；限制标签/封面/歌词后处理的并发，避免积压成无限请求。
const finalizations = new Map<LX.Download.DownloadTask, Promise<void>>()
const finalizeJobs: Array<() => Promise<void>> = []
let runningFinalizations = 0
const runFinalizations = () => {
  while (runningFinalizations < 2 && finalizeJobs.length) {
    const job = finalizeJobs.shift()!
    runningFinalizations++
    void job().finally(() => {
      runningFinalizations--
      runFinalizations()
    })
  }
}
const finalizeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState) => {
  if (!state.filePath || task.status === 'completed') return
  const pending = finalizations.get(task)
  if (pending) return pending
  task.status = 'finalizing'
  task.filePath = state.filePath
  task.fileName = state.fileName ?? task.fileName
  task.pendingCompletion = {
    downloaded: state.downloaded > 0 ? state.downloaded : task.progress.downloaded,
    total: state.total || task.progress.total,
  }
  task.error = undefined
  schedulePersist()
  global.app_event.downloadTaskUpdate(toListItem(task))
  const result = new Promise<void>((resolve, reject) => {
    finalizeJobs.push(async() => {
      try {
        await completeTask(task, state)
        resolve()
      } catch (error) {
        if (tasks.includes(task)) {
          task.status = 'error'
          task.error = error instanceof Error ? error.message : String(error)
          schedulePersist()
          global.app_event.downloadTaskUpdate(toListItem(task))
        }
        reject(error)
      } finally { finalizations.delete(task) }
    })
  })
  finalizations.set(task, result)
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
  const task = tasks.find(item => item.id == state.taskId)
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
  void updateTask(task.id, {
    nativeId: state.nativeId || task.nativeId,
    status: state.status,
    error: state.error,
    progress: {
      progress,
      downloaded: state.downloaded,
      total: state.total,
      speed: state.status == 'run' ? calculateSpeed(task.id, state.downloaded) : '',
    },
  }, state.status == 'error').catch(logDownloadError)
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
    const currentTask = tasks.find(item => item === task)
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
    const currentTask = tasks.find(item => item === task)
    if (!currentTask || currentTask.nativeId !== nativeId || currentTask.status === 'pause') return
    // 查询失败不能当作原生 work 不存在，否则会取消仍在运行的下载并重新取链。
    currentTask.status = 'error'
    currentTask.error = error instanceof Error ? error.message : global.i18n.t('download_status_failed')
  }
}

const processQueue = async() => {
  if (reconciling) return
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
        const task = tasks.find(item => item.id == id)
        if (!task || task.status != 'waiting' || task.nativeId) continue
        try {
          await updateTask(task.id, { status: 'resolving', error: undefined }, true)
          if (!tasks.includes(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          const url = await getMusicUrl({
            musicInfo: task.musicInfo,
            quality: task.quality,
            isRefresh: true,
            // 下载按自己的设置选链路：'account' 账号优先（拿不到再音源），
            // 'source'（默认）只走音源。播放不传这个，走它自己的 player.urlSource
            urlSourceOrder: settingState.setting['download.urlSource'] === 'account' ? 'accountFirst' : 'sourceOnly',
          })
          const currentTask = tasks.find(item => item === task)
          if (currentTask?.status != 'resolving') continue
          const early = new Map<string, NativeDownloadState>()
          earlyNativeUpdates.set(task, early)
          try {
            const nativeId = await enqueueDownload({
              taskId: task.id,
              url,
              treeUri: task.directoryUri,
              fileName: task.fileName,
              mimeType: mimeForExtension(extensionForQuality(task.quality)),
            })
            const enqueuedTask = tasks.find(item => item === task)
            if (!enqueuedTask || enqueuedTask.status === 'pause') {
              await removeNativeDownload(nativeId, task.id, false).catch(() => {})
              continue
            }
            await updateTask(task.id, { nativeId, status: enqueuedTask.status === 'resolving' ? 'waiting' : enqueuedTask.status }, true)
            const pending = early.get(nativeId)
            if (pending && getDownloadTaskItem(task.id)?.status === 'waiting') handleNativeUpdate(pending)
          } finally {
            earlyNativeUpdates.delete(task)
          }
        } catch (error: unknown) {
          if (!tasks.includes(task) || getDownloadTaskItem(task.id)?.status !== 'resolving') continue
          await updateTask(task.id, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }, true)
        }
      }
    } while (reprocess)
  } finally {
    processing = false
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
  // 历史已写成功、活跃快照还没写就被杀时，按历史去重，避免再次下载/写标签。
  tasks.splice(0, tasks.length, ...active.filter(task => !hasDownloadHistory(task.id)))
}

export const initDownloads = async() => {
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
      for (const task of [...tasks]) {
        if (tasks.includes(task)) await reconcileTask(task)
      }
    })().catch(logDownloadError).finally(() => {
      reconciling = false
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
const init = initDownloads

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
export const addTasks = async(musicInfos: LX.Music.MusicInfoOnline[], quality: LX.Quality = settingState.setting['download.quality']) => {
  await init()
  const directory = await getDownloadPath()
  if (!directory) throw new Error(global.i18n.t('download_path_required'))
  // 查重只在内存里做一次：已完成历史 + 活跃（非 error）都算已存在，
  // error 的先摘掉再按新任务加回去
  const existing = new Set<string>(getDownloadHistoryIds())
  for (const task of tasks) {
    if (task.status == 'error') continue
    existing.add(task.id)
  }
  const added: LX.Download.DownloadTask[] = []
  // 选了「QQ 账号」取链、而账号没会员（设置里那一项）时，账号那边只能给标准音质。
  // 任务音质得跟着降到 128k：不然取回来的是 128k 文件，后面的文件大小校验却拿
  // 320k 的预期大小去比，判成「可能下错了音质」把任务废掉。
  const accountOnlyStandard = settingState.setting['player.noVipStandardQuality'] &&
    settingState.setting['download.urlSource'] === 'account'
  // 文件名、大小校验和各音源请求使用同一音质；不能按主音源能力提前降档。
  const targetQuality = accountOnlyStandard ? '128k' : quality
  for (const musicInfo of musicInfos) {
    const id = toMD5(`${musicInfo.source}_${musicInfo.id}_${targetQuality}_${directory.uri}`)
    if (existing.has(id)) continue
    existing.add(id)
    added.push({
      id,
      musicInfo,
      quality: targetQuality,
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
  await Promise.all(added.map(async task => clearPartialFile(task.id)))
  const addedIds = new Set(added.map(task => task.id))
  // 同 id 的旧任务(一定是 error，否则上面就跳过了)先移除，再整批放到最前面，顺序与传入一致
  const kept = tasks.filter(task => !addedIds.has(task.id))
  tasks.splice(0, tasks.length, ...added, ...kept)
  await persistNow()
  notify()
  void processQueue().catch(logDownloadError)
  return added.map(task => task.id)
}

const pauseTaskInternal = async(id: string, persist: boolean) => {
  await init()
  const task = tasks.find(item => item.id == id)
  if (!task || task.status == 'completed' || task.status == 'pause' || task.status == 'finalizing') return
  const nativeId = task.nativeId
  task.status = 'pause'
  task.progress.speed = ''
  if (persist) {
    await persistNow()
    notify()
  }
  if (nativeId) await pauseNativeDownload(nativeId)
}

export const pauseTask = async(id: string) => pauseTaskInternal(id, true)

const retryTaskInternal = async(id: string, persist: boolean, process: boolean) => {
  await init()
  const task = tasks.find(item => item.id == id)
  if (!task || task.status == 'completed' || task.status == 'finalizing') return
  if (resumeFinalization(task)) return
  const directory = await getDownloadPath()
  if (!directory) throw new Error(global.i18n.t('download_path_required'))
  task.directoryUri = directory.uri
  // 先把旧的原生任务撤掉再重下：入队用的是同名唯一任务（REPLACE 会取消旧的），
  // 但旧 worker 可能正卡在写中转文件 / 复制那一步，等它停了再开始，
  // 免得两个任务同时读写同一个 .part。deletePartial=false，保留断点续传的进度。
  if (task.nativeId) await removeNativeDownload(task.nativeId, task.id, false).catch(() => {})
  task.nativeId = undefined
  task.status = 'waiting'
  task.error = undefined
  task.progress.speed = ''
  if (persist) {
    await persistNow()
    notify()
  }
  if (process) void processQueue().catch(logDownloadError)
}

export const retryTask = async(id: string) => retryTaskInternal(id, true, true)

export const pauseAllTasks = async() => {
  await init()
  try {
    await Promise.all(tasks.filter(task => task.status != 'completed').map(async task => pauseTaskInternal(task.id, false)))
  } finally {
    // 批量操作只落盘/通知一次，避免 N 个任务各写一遍整份数组
    await persistNow()
    notify()
  }
}

export const resumeAllTasks = async() => {
  await init()
  try {
    await Promise.all(tasks.filter(task => task.status == 'pause' || task.status == 'error').map(async task => retryTaskInternal(task.id, false, false)))
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
    const activeTargets = tasks.filter(task => idSet.has(task.id))
    if (!activeTargets.length && !ids.some(hasDownloadHistory)) return
    try {
      const historyTargets = await removeDownloadHistory(idSet, deleteFile)
      tasks.splice(0, tasks.length, ...tasks.filter(task => !idSet.has(task.id)))
      activeTargets.forEach(task => { speedSamples.delete(task.id) })
      await Promise.all(activeTargets.map(async task =>
        removeNativeDownload(task.nativeId, task.id, task.status != 'completed').catch(() => {}),
      ))
      if (deleteFile) {
        const filePaths: string[] = []
        for (const task of activeTargets) if (task.filePath) filePaths.push(task.filePath)
        for (const item of historyTargets) if (item.filePath) filePaths.push(item.filePath)
        await Promise.all(filePaths.map(async path => { await unlink(path).catch(() => {}) }))
        // 合并成一次：逐条删会让 LOCAL 整表保存 + 匹配索引重建 N 次
        if (filePaths.length) await removeListMusics(LIST_IDS.LOCAL, filePaths).catch(() => {})
      }
      try {
        await persistNow()
      } catch (error) {
        console.warn('[Download] 保存删除结果失败:', error instanceof Error ? error.message : error)
      }
    } finally { notify() }
  })
}

export const setDownloadDirectory = async(directory: LX.Download.DownloadDirectory) => {
  await saveDownloadPath(directory)
}
