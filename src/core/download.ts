import { addListMusics, removeListMusics } from '@/core/list'
import { getLyricInfo, getMusicUrl, getPicPath } from '@/core/music'
import { getPlayQuality } from '@/core/music/utils'
import { LIST_IDS } from '@/config/constant'
import settingState from '@/store/setting/state'
import { filterFileName } from '@/utils'
import { buildLyrics } from '@/utils/lrcTools'
import {
  getDownloadActiveTasks,
  getDownloadHistory as getDownloadHistoryFromStore,
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
import { writeLyric, writeMetadata, writePic } from '@/utils/localMediaMetadata'
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
// 已完成任务只保留展示/删除/查重需要的轻量字段；完整 musicInfo 已在 LOCAL 的 toggleMusicInfo 里
const history: LX.Download.DownloadHistoryItem[] = []
let historyIds = new Set<string>()
const speedSamples = new Map<string, { bytes: number, time: number }>()
let initPromise: Promise<void> | null = null
let processing = false
// 处理过程中又来了新的 waiting 任务，需要在本轮结束后再扫一遍
let reprocess = false
let persistTimer: ReturnType<typeof setTimeout> | null = null
let activePersistQueue: Promise<void> = Promise.resolve()
let historyPersistQueue: Promise<void> = Promise.resolve()

const notify = () => { global.app_event.downloadListUpdate() }

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

const persistHistoryNow = async() => {
  historyPersistQueue = historyPersistQueue.catch(() => {}).then(async() => {
    await saveDownloadHistory(history)
  })
  await historyPersistQueue
}

const schedulePersist = () => {
  if (persistTimer) return
  // 下载中进度每秒变一次，没必要每秒把整份任务数组序列化一遍；
  // 合并到 3 秒，进程被杀最多丢几秒进度
  persistTimer = setTimeout(() => { void persistNow() }, 3000)
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
  notify()
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
  try {
    await writeMetadata(task.filePath, {
      name: info.name,
      singer: info.singer,
      albumName: info.meta.albumName,
    }, true)
  } catch {}

  try {
    const pic = await getPicPath({ musicInfo: info, isRefresh: false })
    if (pic) {
      const picExt = extname(pic.split('?')[0]) || 'jpg'
      const picPath = `${temporaryDirectoryPath}/lx-download-${task.id}.${picExt}`
      const result = downloadFile(pic, picPath)
      await result.promise
      await writePic(task.filePath, picPath)
      await unlink(picPath).catch(() => {})
    }
  } catch {}

  try {
    const lyric = await getLyricInfo({ musicInfo: info, isRefresh: false })
    if (lyric?.lyric) {
      // 翻译与罗马音只要取到就一并写入。文件只写这一次，若去跟随
      // 「显示翻译/罗马音」开关，日后打开开关也不会补进已下载的文件，只能重下。
      // buildLyrics 生成 [awlrc:lrc:..,tlrc:..,rlrc:..] 这种内嵌格式，
      // 本地播放时由 core/music/local.ts 的 parseLyric 解回各个语言版本。
      await writeLyric(task.filePath, buildLyrics(lyric, true, true, true))
    }
  } catch {}
}

const finalizeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState) => {
  if (!state.filePath || task.status == 'completed' || task.status == 'finalizing') return
  // 入本地列表之前先核对大小，坏的直接判失败，不留一条播不了的记录。
  // state.downloaded 正常就是落盘字节数（原生完成事件与 WorkManager 的 output data
  // 带的都是真实长度），没带上时退回下载过程中记录的字节数
  const expectedSize = parseQualitySize(task.musicInfo.meta._qualitys?.[task.quality]?.size)
  const actualSize = state.downloaded > 0 ? state.downloaded : task.progress.downloaded
  if (isSizeAbnormal(actualSize, expectedSize)) {
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
  if (!tasks.some(item => item.id === task.id)) return
  await addListMusics(LIST_IDS.LOCAL, [localInfo], 'bottom')
  // 完成即归档：活跃数组只留未完成任务，历史只留轻量记录
  const index = tasks.findIndex(item => item.id === task.id)
  if (index < 0) return
  const completed = tasks[index]
  completed.status = 'completed'
  completed.progress = {
    progress: 1,
    downloaded: state.downloaded || completed.progress.downloaded,
    total: state.total || completed.progress.total,
    speed: '',
  }
  tasks.splice(index, 1)
  history.unshift(toHistoryItem(completed))
  historyIds.add(completed.id)
  try {
    await Promise.all([persistNow(), persistHistoryNow()])
  } catch (error) {
    console.warn('[Download] 保存完成历史失败:', error instanceof Error ? error.message : error)
  }
  notify()
}

const handleNativeUpdate = (state: NativeDownloadState) => {
  if (!state.taskId) return
  const task = tasks.find(item => item.id == state.taskId)
  if (!task) return
  // 不在下载中就丢掉速度采样：暂停/出错后恢复时不该拿上一次的旧采样算速度，
  // 任务结束后也没必要一直留着这个 Map 条目
  if (state.status != 'run') speedSamples.delete(task.id)
  if (state.status == 'completed') {
    void finalizeTask(task, state)
    return
  }
  const progress = state.total > 0 ? state.downloaded / state.total : 0
  void updateTask(task.id, {
    nativeId: state.nativeId,
    status: state.status,
    error: state.error,
    progress: {
      progress,
      downloaded: state.downloaded,
      total: state.total,
      speed: state.status == 'run' ? calculateSpeed(task.id, state.downloaded) : '',
    },
  }, state.status == 'error')
}

const reconcileTask = async(task: LX.Download.DownloadTask) => {
  if (task.status == 'completed' || task.status == 'pause' || !task.nativeId) return
  try {
    const state = await getDownloadState(task.nativeId)
    if (!state) {
      task.status = 'waiting'
      task.nativeId = undefined
      return
    }
    if (state.status == 'completed') await finalizeTask(task, state)
    else if (state.status == 'pause') {
      task.status = 'waiting'
      task.nativeId = undefined
    } else handleNativeUpdate({ ...state, taskId: task.id })
  } catch {
    task.status = 'waiting'
    task.nativeId = undefined
  }
}

const processQueue = async() => {
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
      for (const task of tasks) {
        if (task.status != 'waiting') continue
        try {
          await updateTask(task.id, { status: 'resolving', error: undefined }, true)
          const url = await getMusicUrl({
            musicInfo: task.musicInfo,
            quality: task.quality,
            isRefresh: true,
            // 下载按自己的设置选链路：'account' 账号优先（拿不到再音源），
            // 'source'（默认）只走音源。播放不传这个，走它自己的 player.urlSource
            urlSourceOrder: settingState.setting['download.urlSource'] === 'account' ? 'accountFirst' : 'sourceOnly',
          })
          const currentTask = tasks.find(item => item.id == task.id)
          if (currentTask?.status != 'resolving') continue
          const nativeId = await enqueueDownload({
            taskId: task.id,
            url,
            treeUri: task.directoryUri,
            fileName: task.fileName,
            mimeType: mimeForExtension(extensionForQuality(task.quality)),
          })
          await updateTask(task.id, { nativeId, status: 'waiting' }, true)
        } catch (error: unknown) {
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

const setHistory = (list: LX.Download.DownloadHistoryItem[]) => {
  history.splice(0, history.length, ...list)
  historyIds = new Set(list.map(item => item.id))
}

/** 启动加载：优先把旧单 key 拆成活跃/历史；失败保留旧 key，下次重试 */
const loadDownloadStorage = async() => {
  const migrated = await getDownloadTasksMigrated().catch(() => false)
  if (!migrated) {
    const legacy = await getDownloadTasks().catch(() => [])
    if (Array.isArray(legacy) && legacy.length) {
      const active = legacy.filter(task => task?.status !== 'completed')
      const hist = legacy.filter(task => task?.status === 'completed').map(toHistoryItem)
      tasks.splice(0, tasks.length, ...active)
      setHistory(hist)
      try {
        await saveDownloadActiveTasks(active)
        await saveDownloadHistory(hist)
        // 标记写在新 key 之后：即使旧 key 没删掉，下次也以新 key 为准
        await saveDownloadTasksMigrated()
        await removeDownloadTasks()
      } catch (error) {
        // 旧 key 是完整数据，留着下次重试；本次继续用内存里的拆分
        console.warn('[Download] 下载任务迁移失败，保留旧数据:', error instanceof Error ? error.message : error)
      }
      return
    }
  } else {
    // 迁移标记在：以新 key 为准；旧 key 可能是上次删除失败留下的，清掉
    await removeDownloadTasks().catch(() => {})
  }
  try {
    tasks.splice(0, tasks.length, ...(await getDownloadActiveTasks()))
  } catch (error) {
    console.warn('[Download] 读取活跃任务失败:', error instanceof Error ? error.message : error)
    tasks.splice(0, tasks.length)
  }
  try {
    setHistory(await getDownloadHistoryFromStore())
  } catch (error) {
    console.warn('[Download] 读取下载历史失败:', error instanceof Error ? error.message : error)
    setHistory([])
  }
}

const init = async() => {
  if (initPromise) return initPromise
  initPromise = (async() => {
    try {
      await loadDownloadStorage()
    } catch (error) {
      // 存储损坏时不能让初始化一直失败/白屏，按空列表继续
      console.warn('[Download] 加载下载任务失败:', error instanceof Error ? error.message : error)
    }
    const directory = await getDownloadPath()
    for (const task of tasks) {
      if (!task.directoryUri && directory) task.directoryUri = directory.uri
    }
    onDownloadUpdate(handleNativeUpdate)
    for (const task of tasks) await reconcileTask(task)
    // 初始落盘不阻塞启动：存储卡住时也只是任务状态晚一点写回，不能把初始化拖死
    void persistNow().catch(error => {
      console.warn('[Download] 初始落盘失败:', error instanceof Error ? error.message : error)
    })
    void processQueue()
  })()
  return initPromise
}

export const getTasks = async() => {
  await init()
  return tasks
}

export const getDownloadHistory = async() => {
  await init()
  return history
}

/** 下载页展示用：活跃 + 已完成历史，按创建时间倒序（新任务在前） */
export const getDownloadList = async(): Promise<LX.Download.DownloadListItem[]> => {
  await init()
  const activeItems: LX.Download.DownloadListItem[] = tasks.map(task => ({
    id: task.id,
    status: task.status,
    quality: task.quality,
    name: task.musicInfo?.name ?? '',
    singer: task.musicInfo?.singer ?? '',
    filePath: task.filePath,
    createdAt: task.createdAt,
    error: task.error,
    progress: task.progress,
  }))
  const historyItems: LX.Download.DownloadListItem[] = history.map(item => ({
    id: item.id,
    status: 'completed',
    quality: item.quality,
    name: item.name,
    singer: item.singer,
    filePath: item.filePath,
    createdAt: item.createdAt,
  }))
  return [...activeItems, ...historyItems].sort((a, b) => b.createdAt - a.createdAt)
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
  const existing = new Set<string>(historyIds)
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
  for (const musicInfo of musicInfos) {
    const targetQuality = accountOnlyStandard ? '128k' : getPlayQuality(quality, musicInfo)
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
  void processQueue()
  return added.map(task => task.id)
}

export const addTask = async(musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality = settingState.setting['download.quality']) => {
  await init()
  const directory = await getDownloadPath()
  if (!directory) throw new Error(global.i18n.t('download_path_required'))
  // 过去这里直接用传入的音质，绕过了播放侧的降级逻辑：请求歌曲没有的音质会失败，
  // 接着去别的平台找同样音质的版本（core/music/utils.ts 会跳过音质不符的候选），
  // 都没有就把任务标记为出错 —— 而不是退而求其次。这里按歌曲实际拥有的音质降级，
  // 与播放行为一致。
  // 降级必须发生在这一步：文件名后缀与 MIME 都由 quality 推导，
  // 只在取址时降级会得到「.flac 后缀、内容是 mp3」的文件。
  const targetQuality = getPlayQuality(quality, musicInfo)
  const fileName = buildFileName(musicInfo, targetQuality)
  const id = toMD5(`${musicInfo.source}_${musicInfo.id}_${targetQuality}_${directory.uri}`)
  if (historyIds.has(id) || tasks.some(task => task.id == id && task.status != 'error')) return id
  // 走到这里说明是老任务失败了在重下（或第一次下），清掉残留的中转文件，
  // 免得接着上次的旧数据续传出一个大小不对的文件
  await clearPartialFile(id)
  const task: LX.Download.DownloadTask = {
    id,
    musicInfo,
    quality: targetQuality,
    status: 'waiting',
    progress: { progress: 0, downloaded: 0, total: 0, speed: '' },
    fileName,
    directoryUri: directory.uri,
    createdAt: Date.now(),
  }
  const oldIndex = tasks.findIndex(item => item.id == id)
  if (oldIndex >= 0) tasks.splice(oldIndex, 1, task)
  else tasks.unshift(task)
  await persistNow()
  notify()
  void processQueue()
  return id
}

const pauseTaskInternal = async(id: string, persist: boolean) => {
  await init()
  const task = tasks.find(item => item.id == id)
  if (!task || task.status == 'completed' || task.status == 'pause') return
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
  if (!task || task.status == 'completed') return
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
  if (process) void processQueue()
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
    void processQueue()
  }
}

export const removeTask = async(id: string, deleteFile = false) => {
  await removeTasks([id], deleteFile)
}

/**
 * 批量移除任务。与循环调用 removeTask 的区别是只落盘一次、只通知一次，
 * 批量删除时不会产生 N 次写存储与重渲染。活跃和历史同时查。
 */
export const removeTasks = async(ids: string[], deleteFile = false) => {
  await init()
  const idSet = new Set(ids)
  const activeTargets = tasks.filter(task => idSet.has(task.id))
  const historyTargets = history.filter(item => idSet.has(item.id))
  if (!activeTargets.length && !historyTargets.length) return
  tasks.splice(0, tasks.length, ...tasks.filter(task => !idSet.has(task.id)))
  history.splice(0, history.length, ...history.filter(item => !idSet.has(item.id)))
  for (const item of historyTargets) historyIds.delete(item.id)
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
    await Promise.all([persistNow(), persistHistoryNow()])
  } catch (error) {
    console.warn('[Download] 保存删除结果失败:', error instanceof Error ? error.message : error)
  }
  notify()
}

export const removeTasksByFilePaths = async(paths: string[]) => {
  await init()
  const pathSet = new Set(paths)
  const ids = [
    ...tasks.filter(task => task.filePath && pathSet.has(task.filePath)).map(task => task.id),
    ...history.filter(item => item.filePath && pathSet.has(item.filePath)).map(item => item.id),
  ]
  if (ids.length) await removeTasks(ids)
}

export const setDownloadDirectory = async(directory: LX.Download.DownloadDirectory) => {
  await saveDownloadPath(directory)
}
