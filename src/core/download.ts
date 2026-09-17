import { addListMusics, removeListMusics } from '@/core/list'
import { getLyricInfo, getMusicUrl, getPicPath } from '@/core/music'
import { getPlayQuality } from '@/core/music/utils'
import { LIST_IDS } from '@/config/constant'
import settingState from '@/store/setting/state'
import { filterFileName } from '@/utils'
import { getDownloadPath, getDownloadTasks, saveDownloadPath, saveDownloadTasks } from '@/utils/data'
import { downloadFile, extname, temporaryDirectoryPath, unlink } from '@/utils/fs'
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

const tasks: LX.Download.DownloadTask[] = []
const speedSamples = new Map<string, { bytes: number, time: number }>()
let initPromise: Promise<void> | null = null
let processing = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

const notify = () => { global.app_event.downloadListUpdate() }

const persistNow = async() => {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  await saveDownloadTasks(tasks)
}

const schedulePersist = () => {
  if (persistTimer) return
  persistTimer = setTimeout(() => { void persistNow() }, 1000)
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
    if (lyric?.lyric) await writeLyric(task.filePath, lyric.lyric)
  } catch {}
}

const finalizeTask = async(task: LX.Download.DownloadTask, state: NativeDownloadState) => {
  if (!state.filePath || task.status == 'completed' || task.status == 'finalizing') return
  await updateTask(task.id, {
    status: 'finalizing',
    filePath: state.filePath,
    fileName: state.fileName ?? task.fileName,
    error: undefined,
  }, true)
  await writeEmbeddedMetadata(task)
  const localInfo: LX.Music.MusicInfoLocal = {
    id: state.filePath,
    name: task.musicInfo.name,
    singer: task.musicInfo.singer,
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
  await addListMusics(LIST_IDS.LOCAL, [localInfo], 'bottom')
  await updateTask(task.id, {
    status: 'completed',
    progress: {
      progress: 1,
      downloaded: state.downloaded || task.progress.downloaded,
      total: state.total || task.progress.total,
      speed: '',
    },
  }, true)
}

const handleNativeUpdate = (state: NativeDownloadState) => {
  if (!state.taskId) return
  const task = tasks.find(item => item.id == state.taskId)
  if (!task) return
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
  if (processing) return
  processing = true
  try {
    for (const task of tasks) {
      if (task.status != 'waiting') continue
      try {
        await updateTask(task.id, { status: 'resolving', error: undefined }, true)
        const url = await getMusicUrl({ musicInfo: task.musicInfo, quality: task.quality, isRefresh: true })
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
  } finally {
    processing = false
  }
}

const init = async() => {
  if (initPromise) return initPromise
  initPromise = (async() => {
    tasks.splice(0, tasks.length, ...(await getDownloadTasks()))
    const directory = await getDownloadPath()
    for (const task of tasks) {
      if (!task.directoryUri && directory) task.directoryUri = directory.uri
    }
    onDownloadUpdate(handleNativeUpdate)
    for (const task of tasks) await reconcileTask(task)
    await persistNow()
    void processQueue()
  })()
  return initPromise
}

export const getTasks = async() => {
  await init()
  return tasks
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
  if (tasks.some(task => task.id == id && task.status != 'error')) return id
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

export const pauseTask = async(id: string) => {
  await init()
  const task = tasks.find(item => item.id == id)
  if (!task || task.status == 'completed' || task.status == 'pause') return
  const nativeId = task.nativeId
  task.status = 'pause'
  task.progress.speed = ''
  await persistNow()
  notify()
  if (nativeId) await pauseNativeDownload(nativeId)
}

export const retryTask = async(id: string) => {
  await init()
  const task = tasks.find(item => item.id == id)
  if (!task || task.status == 'completed') return
  const directory = await getDownloadPath()
  if (!directory) throw new Error(global.i18n.t('download_path_required'))
  task.directoryUri = directory.uri
  task.nativeId = undefined
  task.status = 'waiting'
  task.error = undefined
  task.progress.speed = ''
  await persistNow()
  notify()
  void processQueue()
}

export const pauseAllTasks = async() => {
  await init()
  await Promise.all(tasks.filter(task => task.status != 'completed').map(async task => pauseTask(task.id)))
}

export const resumeAllTasks = async() => {
  await init()
  await Promise.all(tasks.filter(task => task.status == 'pause' || task.status == 'error').map(async task => retryTask(task.id)))
}

export const removeTask = async(id: string, deleteFile = false) => {
  await init()
  const index = tasks.findIndex(item => item.id == id)
  if (index < 0) return
  const task = tasks[index]
  tasks.splice(index, 1)
  await removeNativeDownload(task.nativeId, task.id, task.status != 'completed').catch(() => {})
  if (deleteFile && task.filePath) {
    await unlink(task.filePath).catch(() => {})
    await removeListMusics(LIST_IDS.LOCAL, [task.filePath])
  }
  await persistNow()
  notify()
}

export const removeTasksByFilePaths = async(paths: string[]) => {
  await init()
  const pathSet = new Set(paths)
  const ids = tasks.filter(task => task.filePath && pathSet.has(task.filePath)).map(task => task.id)
  for (const id of ids) await removeTask(id)
}

export const setDownloadDirectory = async(directory: LX.Download.DownloadDirectory) => {
  await saveDownloadPath(directory)
}
