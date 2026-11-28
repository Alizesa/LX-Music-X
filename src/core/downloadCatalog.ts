import { throwIfAborted } from '@/utils/abort'
import { waitForPromise } from '@/utils/abortable'
import getQQMusicInfo from '@/utils/musicSdk/tx/musicInfo'
import { playbackLog } from '@/utils/playbackLog'

interface CatalogInfo {
  qualitys: LX.Music.MusicQualityType[]
  mediaMid: string
  interval: string | null
}

const CACHE_LIMIT = 128
const CACHE_TTL = 5 * 60_000
const FAILURE_TTL = 30_000
const CONCURRENCY = 4
const cache = new Map<string, { value: CatalogInfo | null, expires: number }>()
interface CatalogTask {
  mid: string
  controller: AbortController
  users: number
  promise: Promise<CatalogInfo | null>
  resolve: (value: CatalogInfo | null) => void
}
const pending = new Map<string, CatalogTask>()
const queued = new Set<CatalogTask>()
let activeRequests = 0

// A slot owns only the lookup key, never the consumer's song/list. Keep it until the actual IO settles.
const fetchTask = async(task: CatalogTask) => {
  let value: CatalogInfo | null = null
  try {
    const info = await getQQMusicInfo(task.mid, { timeout: 5000, signal: task.controller.signal })
    if (info && info.songmid === task.mid && info.types.length) {
      value = { qualitys: info.types as LX.Music.MusicQualityType[], mediaMid: info.strMediaMid as string, interval: info.interval as string | null }
    }
  } catch {} finally {
    if (pending.get(task.mid) === task) {
      pending.delete(task.mid)
      cache.delete(task.mid)
      cache.set(task.mid, { value, expires: Date.now() + (value ? CACHE_TTL : FAILURE_TTL) })
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    }
    task.resolve(value)
    activeRequests--
    dispatch()
  }
}
const dispatch = () => {
  while (activeRequests < CONCURRENCY && queued.size) {
    const task = queued.values().next().value!
    queued.delete(task)
    activeRequests++
    void fetchTask(task)
  }
}

const readCatalog = async(mid: string, signal?: AbortSignal): Promise<CatalogInfo | null> => {
  throwIfAborted(signal)
  const cached = cache.get(mid)
  if (cached && cached.expires > Date.now()) return cached.value
  let task = pending.get(mid)
  if (!task) {
    let resolveTask!: CatalogTask['resolve']
    const promise = new Promise<CatalogInfo | null>(resolve => { resolveTask = resolve })
    task = { mid, users: 0, controller: new AbortController(), promise, resolve: resolveTask }
    pending.set(mid, task)
    queued.add(task)
  }
  task.users++
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--task.users === 0 && pending.get(mid) === task) {
      pending.delete(mid)
      queued.delete(task)
      task.controller.abort()
      task.resolve(null)
    }
  }
  signal?.addEventListener('abort', release, { once: true })
  try {
    throwIfAborted(signal)
    dispatch()
    return await waitForPromise(task.promise, signal)
  } finally {
    signal?.removeEventListener('abort', release)
    release()
  }
}

const prepareMusicInfo = async(musicInfo: LX.Music.MusicInfoOnline, signal?: AbortSignal): Promise<LX.Music.MusicInfoOnline> => {
  if (musicInfo.source !== 'tx') return musicInfo
  const songMid = [musicInfo.meta.songId, musicInfo.id.replace(/^tx_/, '')]
    .find((value): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{14}$/.test(value))
  if (!songMid) return musicInfo
  const info = await readCatalog(songMid, signal)
  throwIfAborted(signal)
  playbackLog('download.catalog', () => ({ musicId: musicInfo.id, available: !!info, qualities: info?.qualitys.map(item => item.type) }))
  if (!info) return musicInfo
  const interval = info.interval ?? musicInfo.interval
  if (musicInfo.meta.strMediaMid === info.mediaMid && musicInfo.interval === interval &&
    musicInfo.meta.qualitys?.length === info.qualitys.length && Object.keys(musicInfo.meta._qualitys ?? {}).length === info.qualitys.length &&
    info.qualitys.every(({ type, size }, index) => musicInfo.meta.qualitys[index].type === type &&
      musicInfo.meta.qualitys[index].size === size && musicInfo.meta._qualitys?.[type]?.size === size)) return musicInfo
  // 只更新本批下载的快照；不要改写播放器和歌单共用的歌曲对象。
  const qualitys = info.qualitys.map(item => ({ ...item }))
  return {
    ...musicInfo,
    interval,
    meta: {
      ...musicInfo.meta,
      strMediaMid: info.mediaMid,
      qualitys,
      _qualitys: Object.fromEntries(qualitys.map(({ type, size }) => [type, { size }])),
    },
  }
}

export const prepareDownloadMusicInfos = async(musicInfos: LX.Music.MusicInfoOnline[], signal?: AbortSignal): Promise<LX.Music.MusicInfoOnline[]> => {
  throwIfAborted(signal)
  const result = [...musicInfos]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, result.length) }, async() => {
    while (next < musicInfos.length) {
      throwIfAborted(signal)
      const index = next++
      result[index] = await prepareMusicInfo(musicInfos[index], signal)
    }
  }))
  throwIfAborted(signal)
  return result
}
