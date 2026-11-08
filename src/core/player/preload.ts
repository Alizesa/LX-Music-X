import { getMusicUrl } from '@/core/music'
import { markMusicUrlFailed, isMusicUrlFailed } from '@/core/music/sourcePriority'
import settingState from '@/store/setting/state'
import { canPreloadAudio, preloadAudio } from '@/plugins/player/preload'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { parseApiSourceOrder } from '@/utils/apiSourceOrder'

type Music = LX.Player.PlayMusic
interface PreloadTask {
  key: string
  musicInfo: Music
  promise: Promise<string>
  url: string
  cancelled: boolean
  claimed: boolean
  paused: boolean
  finished: boolean
  filling: boolean
  cacheGeneration: number
  recoveries: number
  rejectedUrls: Set<string>
  cancelResolve?: () => void
  cancelCache?: () => void
  onError?: (error: unknown) => void
}
let active: PreloadTask | null = null

const keyOf = (music: Music) => {
  const setting = settingState.setting
  const alternate = ('progress' in music ? music.metadata.musicInfo : music).meta.toggleMusicInfo?.id
  return JSON.stringify([music.id, alternate, setting['player.playQuality'], setting['player.urlSource'], setting['player.noVipStandardQuality'],
    setting['common.apiSourceOrder'], setting['common.apiSource']])
}
const assertActive = (task: PreloadTask) => { if (task.cancelled) throw new Error(requestMsg.cancelRequest) }
const stopCache = (task: PreloadTask) => {
  task.cacheGeneration++
  const cancel = task.cancelCache
  task.cancelCache = undefined
  task.filling = false
  try { cancel?.() } catch {}
}
const cancelTask = (task: PreloadTask) => {
  task.cancelled = true
  const cancel = task.cancelResolve
  task.cancelResolve = undefined
  task.onError = undefined
  try { cancel?.() } catch {}
  stopCache(task)
}

const failTask = (task: PreloadTask, error: unknown) => {
  // 交给前台或已作废的任务，由它自己的调用方处理，不能再唤醒旧的后台选曲。
  if (active !== task || task.cancelled || task.claimed) return
  active = null
  const onError = task.onError
  cancelTask(task)
  onError?.(error)
}

export const cancelPreload = () => {
  if (active) cancelTask(active)
  active = null
}

/** 切到已预取的歌曲时保留取链任务，交给前台接管；切到其他歌曲立即取消。 */
export const keepPreloadFor = (music: Music | null) => {
  if (!active) return
  if (!music || active.key != keyOf(music)) { cancelPreload(); return }
  active.claimed = true
  active.onError = undefined
  if (active.url) stopCache(active)
}

export const pausePreload = () => {
  if (!active || active.claimed) return
  if (!active.url) { cancelPreload(); return }
  active.paused = true
  stopCache(active)
}

export const hasPreloadMusic = (music: Music) => active?.key == keyOf(music) && !active.cancelled
export const isPreloadPaused = () => active?.paused ?? false

/** 前台获得同一个 Promise 或已缓存的 URL；不再为同一首歌重新请求所有音源。 */
export const takePreloadedMusicUrl = (music: Music, onCancel: (cancel: () => void) => void): Promise<string> | null => {
  const task = active
  if (!task || task.key != keyOf(music) || task.cancelled || (task.url && isMusicUrlFailed(task.url))) {
    cancelPreload()
    return null
  }
  active = null
  task.claimed = true
  task.onError = undefined
  if (task.url) stopCache(task)
  onCancel(() => { cancelTask(task) })
  return task.promise.then(url => { assertActive(task); return url })
}

const cacheHead = async(task: PreloadTask, url: string) => {
  assertActive(task)
  if (task.rejectedUrls.has(url)) throw new Error('Audio resource already failed')
  try {
    const result = await preloadAudio(url, 256 * 1024, cancel => {
      task.cancelCache = cancel
      if (task.cancelled) cancel()
    })
    assertActive(task)
    task.cancelCache = undefined
    task.finished = result == null || result.complete
  } catch (error) {
    if (!isRequestCancelled(error)) {
      task.rejectedUrls.add(url)
      markMusicUrlFailed(url)
    }
    throw error
  }
}

const fillCache = async(task: PreloadTask): Promise<void> => {
  if (task.cancelled || task.claimed || task.paused || task.finished || task.filling || !/^https?:\/\//i.test(task.url)) return
  task.filling = true
  const generation = ++task.cacheGeneration
  const url = task.url
  try {
    await preloadAudio(url, 0, cancel => {
      task.cancelCache = cancel
      if (task.cancelled || generation != task.cacheGeneration) cancel()
    })
    if (task.cancelled || generation != task.cacheGeneration) return
    // 已达到整首长度或当前缓存预算，不再反复请求同一段资源。
    task.finished = true
  } catch (error) {
    if (task.cancelled || task.claimed || generation != task.cacheGeneration || isRequestCancelled(error)) return
    task.rejectedUrls.add(url)
    markMusicUrlFailed(url)
    task.url = ''
    const setting = settingState.setting
    const count = parseApiSourceOrder(setting['common.apiSourceOrder'], setting['common.apiSource']).length + 1
    if (++task.recoveries <= count) {
      startPrepare(task, true)
    } else {
      failTask(task, new Error('Next track preload failed'))
    }
  } finally {
    if (generation == task.cacheGeneration) {
      task.filling = false
      task.cancelCache = undefined
    }
  }
}

const prepare = async(task: PreloadTask, isRefresh = false): Promise<string> => {
  const validated = new Set<string>()
  const resolve = async(musicInfo: Music) => getMusicUrl({
    musicInfo,
    isRefresh,
    rejectedUrls: task.rejectedUrls,
    // 预取只走当前歌曲及勾选的脚本；跨平台搜索留给前台确实需要播放时处理。
    allowToggleSource: false,
    onCancel: cancel => {
      task.cancelResolve = cancel
      if (task.cancelled) cancel()
    },
    validateUrl: async url => { await cacheHead(task, url); validated.add(url) },
  })
  const music = task.musicInfo
  const isLocal = !('progress' in music) && music.source == 'local'
  const alternate = isLocal ? undefined : ('progress' in music ? music.metadata.musicInfo : music).meta.toggleMusicInfo
  let url: string
  if (alternate) {
    try {
      url = await resolve(alternate)
    } catch (error) {
      assertActive(task)
      if (isRequestCancelled(error)) throw error
      url = await resolve(music)
    }
  } else url = await resolve(music)
  assertActive(task)
  // 本地歌曲完全跳过 HTTP。下载条目失效后回落在线时，也要实际预读音频。
  if (/^https?:\/\//i.test(url) && !validated.has(url)) await cacheHead(task, url)
  assertActive(task)
  task.url = url
  task.cancelResolve = undefined
  void fillCache(task)
  return url
}

const startPrepare = (task: PreloadTask, isRefresh = false) => {
  task.promise = prepare(task, isRefresh).catch(error => {
    failTask(task, error)
    throw error
  })
  void task.promise.catch(() => {})
}

export const preloadMusic = (musicInfo: Music, onError?: (error: unknown) => void): Promise<string> | null => {
  if (!settingState.setting['player.preloadNext'] || !canPreloadAudio() || !(Number(settingState.setting['player.cacheSize']) > 0)) return null
  if (active?.key == keyOf(musicInfo) && !active.cancelled) {
    if (onError) active.onError = onError
    active.paused = false
    void fillCache(active)
    return active.promise
  }
  cancelPreload()
  const task: PreloadTask = {
    key: keyOf(musicInfo),
    musicInfo,
    promise: Promise.resolve(''),
    url: '',
    cancelled: false,
    claimed: false,
    paused: false,
    finished: false,
    filling: false,
    cacheGeneration: 0,
    recoveries: 0,
    rejectedUrls: new Set(),
    onError,
  }
  active = task
  startPrepare(task)
  return task.promise
}
