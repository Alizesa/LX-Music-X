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
const pending = new Map<string, Promise<CatalogInfo | null>>()
let activeRequests = 0
const slots: Array<() => void> = []

const withCatalogSlot = async<T>(read: () => Promise<T>): Promise<T> => {
  if (activeRequests >= CONCURRENCY) await new Promise<void>(resolve => slots.push(resolve))
  else activeRequests++
  try { return await read() } finally {
    const next = slots.shift()
    if (next) next()
    else activeRequests--
  }
}

const readCatalog = async(songMid: string): Promise<CatalogInfo | null> => {
  const cached = cache.get(songMid)
  if (cached && cached.expires > Date.now()) return cached.value
  const current = pending.get(songMid)
  if (current) return current
  // 公开歌曲详情只查文件规格，不使用账号 Cookie，也不请求 VIP 播放票据。
  const request = withCatalogSlot(async() => getQQMusicInfo(songMid, { timeout: 5000 })).then(info => {
    if (!info || info.songmid !== songMid || !info.types.length) return null
    return { qualitys: info.types as LX.Music.MusicQualityType[], mediaMid: info.strMediaMid as string, interval: info.interval as string | null }
  }).catch(() => null).then(value => {
    cache.delete(songMid)
    cache.set(songMid, { value, expires: Date.now() + (value ? CACHE_TTL : FAILURE_TTL) })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return value
  }).finally(() => { pending.delete(songMid) })
  pending.set(songMid, request)
  return request
}

const prepareMusicInfo = async(musicInfo: LX.Music.MusicInfoOnline): Promise<LX.Music.MusicInfoOnline> => {
  if (musicInfo.source !== 'tx') return musicInfo
  const songMid = [musicInfo.meta.songId, musicInfo.id.replace(/^tx_/, '')]
    .find((value): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{14}$/.test(value))
  if (!songMid) return musicInfo
  const info = await readCatalog(songMid)
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

export const prepareDownloadMusicInfos = async(musicInfos: LX.Music.MusicInfoOnline[]): Promise<LX.Music.MusicInfoOnline[]> => {
  const result = [...musicInfos]
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, result.length) }, async() => {
    while (next < musicInfos.length) {
      const index = next++
      result[index] = await prepareMusicInfo(musicInfos[index])
    }
  }))
  return result
}
