import { getMusicUrl } from '@/core/music'
import { markMusicUrlFailed, isMusicUrlFailed } from '@/core/music/sourcePriority'
import settingState from '@/store/setting/state'
import { canPreloadAudio, preloadAudio } from '@/plugins/player/preload'
import { isRequestCancelled, requestMsg } from '@/utils/message'
import { parseApiSourceOrder } from '@/utils/apiSourceOrder'
import { newPlaybackLogId, playbackLog, playbackLogId, registerPlaybackLogSnapshot } from '@/utils/playbackLog'

type Music = LX.Player.PlayMusic
interface PreloadTask {
  ownerPlayId?: string
  phase: string
  startedAt: number
  cacheAvailable?: boolean
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
const trace = (task: PreloadTask) => ({ playId: task.ownerPlayId, preloadId: playbackLogId(task, 'preload') })
registerPlaybackLogSnapshot('preloadTask', () => active ? {
  ...trace(active),
  musicId: active.musicInfo.id,
  phase: active.phase,
  elapsedMs: Date.now() - active.startedAt,
  claimed: active.claimed,
  paused: active.paused,
  workFinished: active.finished,
  filling: active.filling,
  cacheAvailable: active.cacheAvailable,
  recoveries: active.recoveries,
  url: active.url,
} : { phase: 'idle' })

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
const cancelTask = (task: PreloadTask, reason = 'cancelled') => {
  playbackLog('preload.cancel', () => ({ ...trace(task), musicId: task.musicInfo.id, reason, phase: task.phase }))
  task.phase = 'cancelled'
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
  playbackLog('preload.task_failed', () => ({ ...trace(task), phase: task.phase, error, elapsedMs: Date.now() - task.startedAt }))
  cancelTask(task, 'failure')
  onError?.(error)
}

export const cancelPreload = (reason = 'invalidated') => {
  if (active) cancelTask(active, reason)
  active = null
}

/** 切到已预取的歌曲时保留取链任务，交给前台接管；切到其他歌曲立即取消。 */
export const keepPreloadFor = (music: Music | null) => {
  if (!active) return
  if (!music || active.key != keyOf(music)) { cancelPreload('next_track_changed'); return }
  active.claimed = true
  active.onError = undefined
  playbackLog('preload.handoff_pending', () => ({ ...trace(active!), musicId: music.id, phase: active!.phase }))
  if (active.url) stopCache(active)
}

export const pausePreload = () => {
  if (!active || active.claimed) return
  if (!active.url) { cancelPreload('paused_while_resolving'); return }
  active.paused = true
  active.phase = 'paused'
  playbackLog('preload.cache_paused', () => ({ ...trace(active!), musicId: active!.musicInfo.id }))
  stopCache(active)
}

export const hasPreloadMusic = (music: Music) => active?.key == keyOf(music) && !active.cancelled
export const isPreloadPaused = () => active?.paused ?? false

/** 前台获得同一个 Promise 或已缓存的 URL；不再为同一首歌重新请求所有音源。 */
export const takePreloadedMusicUrl = (music: Music, onCancel: (cancel: () => void) => void, playId?: string): Promise<string> | null => {
  const task = active
  if (!task || task.key != keyOf(music) || task.cancelled || (task.url && isMusicUrlFailed(task.url))) {
    playbackLog('preload.handoff_miss', { playId, musicId: music.id, reason: !task ? 'no_task' : task.cancelled ? 'cancelled' : task.key != keyOf(music) ? 'key_changed' : 'failed_url' })
    cancelPreload('handoff_miss')
    return null
  }
  active = null
  task.claimed = true
  task.onError = undefined
  playbackLog('preload.handoff_hit', () => ({ ...trace(task), targetPlayId: playId, musicId: music.id, phase: task.phase, pending: !task.url }))
  task.phase = 'claimed'
  if (task.url) stopCache(task)
  onCancel(() => { cancelTask(task) })
  return task.promise.then(url => { assertActive(task); return url })
}

const cacheHead = async(task: PreloadTask, url: string) => {
  assertActive(task)
  if (task.rejectedUrls.has(url)) throw new Error('Audio resource already failed')
  task.phase = 'head'
  playbackLog('preload.head_start', () => ({ ...trace(task), url, bytes: 256 * 1024 }))
  try {
    const result = await preloadAudio(url, 256 * 1024, cancel => {
      task.cancelCache = cancel
      if (task.cancelled) cancel()
    }, trace(task))
    assertActive(task)
    task.cancelCache = undefined
    task.finished = result == null || result.complete
    task.cacheAvailable = result != null
    playbackLog('preload.head_result', () => ({ ...trace(task), result, cacheAvailable: task.cacheAvailable }))
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
  task.phase = 'filling'
  const generation = ++task.cacheGeneration
  const url = task.url
  try {
    playbackLog('preload.fill_start', () => ({ ...trace(task), url }))
    const result = await preloadAudio(url, 0, cancel => {
      task.cancelCache = cancel
      if (task.cancelled || generation != task.cacheGeneration) cancel()
    }, trace(task))
    if (task.cancelled || generation != task.cacheGeneration) return
    // 已达到整首长度或当前缓存预算，不再反复请求同一段资源。
    task.finished = true
    task.phase = result == null ? 'cache_unavailable' : 'ready'
    task.cacheAvailable = result != null
    playbackLog('preload.fill_result', () => ({ ...trace(task), result, cacheAvailable: task.cacheAvailable }))
  } catch (error) {
    if (task.cancelled || task.claimed || generation != task.cacheGeneration || isRequestCancelled(error)) return
    task.rejectedUrls.add(url)
    markMusicUrlFailed(url)
    task.url = ''
    playbackLog('preload.fill_failed', () => ({ ...trace(task), error, recoveries: task.recoveries }))
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
  task.phase = 'resolving'
  playbackLog('preload.resolve_start', () => ({ ...trace(task), musicId: task.musicInfo.id, isRefresh }))
  const validated = new Set<string>()
  const resolve = async(musicInfo: Music) => getMusicUrl({
    musicInfo,
    isRefresh,
    rejectedUrls: task.rejectedUrls,
    trace: { ...trace(task), urlId: newPlaybackLogId('url') },
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
  task.phase = task.cacheAvailable === false ? 'cache_unavailable' : 'ready'
  playbackLog('preload.prepared', () => ({ ...trace(task), url, local: !/^https?:\/\//i.test(url), elapsedMs: Date.now() - task.startedAt }))
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

export const preloadMusic = (musicInfo: Music, onError?: (error: unknown) => void, ownerPlayId?: string): Promise<string> | null => {
  if (!settingState.setting['player.preloadNext'] || !canPreloadAudio() || !(Number(settingState.setting['player.cacheSize']) > 0)) {
    playbackLog('preload.unavailable', { musicId: musicInfo.id, enabled: settingState.setting['player.preloadNext'], native: canPreloadAudio(), cacheMiB: settingState.setting['player.cacheSize'] })
    return null
  }
  if (active?.key == keyOf(musicInfo) && !active.cancelled) {
    if (onError) active.onError = onError
    active.paused = false
    playbackLog('preload.reused', () => ({ ...trace(active!), musicId: musicInfo.id, phase: active!.phase }))
    void fillCache(active)
    return active.promise
  }
  cancelPreload()
  const task: PreloadTask = {
    ownerPlayId,
    phase: 'created',
    startedAt: Date.now(),
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
  playbackLog('preload.created', () => ({ ...trace(task), musicId: musicInfo.id }))
  startPrepare(task)
  return task.promise
}
