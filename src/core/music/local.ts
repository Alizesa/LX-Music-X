
import { saveLyric, saveMusicUrl } from '@/utils/data'
import { updateListMusics } from '@/core/list'
import {
  buildLyricInfo,
  getCachedLyricInfo,
  getOnlineOtherSourceLyricByLocal,
  getOnlineOtherSourceLyricInfo,
  getOnlineOtherSourceMusicUrl,
  getOnlineOtherSourceMusicUrlByLocal,
  getOnlineOtherSourcePicByLocal,
  getOnlineOtherSourcePicUrl,
  getOtherSource,
} from './utils'
import { getLocalFilePath } from '@/utils/music'
import { readLyric, readPic } from '@/utils/localMediaMetadata'
import { stat } from '@/utils/fs'
import { getListMusicSync } from '@/utils/listManage'
import { LIST_IDS } from '@/config/constant'

const getOtherSourceByLocal = async<T>(musicInfo: LX.Music.MusicInfoLocal, handler: (infos: LX.Music.MusicInfoOnline[]) => Promise<T>) => {
  let result: LX.Music.MusicInfoOnline[] = []
  result = await getOtherSource(musicInfo)
  if (result.length) try { return await handler(result) } catch {}
  if (musicInfo.name.includes('-')) {
    const [name, singer] = musicInfo.name.split('-').map(val => val.trim())
    result = await getOtherSource({
      ...musicInfo,
      name,
      singer,
    }, true)
    if (result.length) try { return await handler(result) } catch {}
    result = await getOtherSource({
      ...musicInfo,
      name: singer,
      singer: name,
    }, true)
    if (result.length) try { return await handler(result) } catch {}
  }
  let fileName = (await stat(musicInfo.meta.filePath).catch(() => ({ name: null }))).name ?? musicInfo.meta.filePath.split(/\/|\\/).at(-1)
  if (fileName) {
    fileName = fileName.substring(0, fileName.lastIndexOf('.'))
    if (fileName != musicInfo.name) {
      if (fileName.includes('-')) {
        const [name, singer] = fileName.split('-').map(val => val.trim())
        result = await getOtherSource({
          ...musicInfo,
          name,
          singer,
        }, true)
        if (result.length) try { return await handler(result) } catch {}
        result = await getOtherSource({
          ...musicInfo,
          name: singer,
          singer: name,
        }, true)
      } else {
        result = await getOtherSource({
          ...musicInfo,
          name: fileName,
          singer: '',
        }, true)
      }
      if (result.length) try { return await handler(result) } catch {}
    }
  }

  throw new Error('source not found')
}

const normalize = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const intervalToSeconds = (interval: string | null) => {
  if (!interval) return null
  const parts = interval.split(':').map(Number)
  if (parts.some(Number.isNaN)) return null
  return parts.reduce((total, value) => total * 60 + value, 0)
}

interface NormalizedLocalEntry {
  name: string
  singer: string
  album: string
  duration: number | null
  // 归一化前的原始值，仅用于校验缓存是否还有效
  rawName: string
  rawSinger: string
  rawAlbum: string
  rawInterval: string | null
}

// 归一化的 NFKC + Unicode 属性正则是这条路径上最贵的运算，而每次切歌要跑三遍
// （取址 / 封面 / 歌词），对本地库大的用户是实打实的卡顿来源。归一化是纯函数，
// 结果按条目缓存；用原始值做一次字符串比对来校验，就地改过字段也能自动重算，
// 因此不需要失效通知，也就没有"通知漏发导致索引过期"这类问题。
const normalizedCache = new WeakMap<LX.Music.MusicInfoLocal, NormalizedLocalEntry>()

const getNormalizedEntry = (item: LX.Music.MusicInfoLocal): NormalizedLocalEntry => {
  const rawName = item.name
  const rawSinger = item.singer
  const rawAlbum = item.meta.albumName
  const rawInterval = item.interval
  const cached = normalizedCache.get(item)
  if (
    cached &&
    cached.rawName === rawName &&
    cached.rawSinger === rawSinger &&
    cached.rawAlbum === rawAlbum &&
    cached.rawInterval === rawInterval
  ) return cached
  const entry: NormalizedLocalEntry = {
    name: normalize(rawName),
    singer: normalize(rawSinger),
    album: normalize(rawAlbum),
    duration: intervalToSeconds(rawInterval),
    rawName,
    rawSinger,
    rawAlbum,
    rawInterval,
  }
  normalizedCache.set(item, entry)
  return entry
}

export const findLocalMusicInfo = (musicInfo: LX.Music.MusicInfoOnline) => {
  const localList = getListMusicSync(LIST_IDS.LOCAL).filter((item): item is LX.Music.MusicInfoLocal => item.source == 'local')
  const bySourceId = localList.find(item => item.meta.toggleMusicInfo?.id == musicInfo.id && item.meta.toggleMusicInfo?.source == musicInfo.source)
  if (bySourceId) return bySourceId
  // 先做便宜的判空，再归一化。反过来的话，缺专辑名/歌手的歌会白跑几次正则归一化
  if (!musicInfo.name || !musicInfo.singer || !musicInfo.meta.albumName || !musicInfo.interval) return undefined
  const name = normalize(musicInfo.name)
  const singer = normalize(musicInfo.singer)
  const album = normalize(musicInfo.meta.albumName)
  const duration = intervalToSeconds(musicInfo.interval)
  if (!name || !singer || !album || duration == null) return undefined
  const candidates: Array<{ item: LX.Music.MusicInfoLocal, durationGap: number }> = []
  for (const item of localList) {
    const entry = getNormalizedEntry(item)
    if (entry.duration == null) continue
    const durationGap = Math.abs(entry.duration - duration)
    if (durationGap > 3) continue
    if (entry.name != name || entry.singer != singer || entry.album != album) continue
    candidates.push({ item, durationGap })
  }
  if (!candidates.length) return undefined
  if (candidates.length == 1) return candidates[0].item
  // 同一首歌可能有多条本地记录（同曲不同音质各下一份、或专辑里有重复曲目）。
  // 早先遇到多个候选就放弃，结果是明明有本地文件却退回在线播放。
  // 这里改成择优：优先已关联在线来源的那条，其次时长最接近的。
  return candidates.reduce((best, current) => {
    const bestLinked = !!best.item.meta.toggleMusicInfo
    const currentLinked = !!current.item.meta.toggleMusicInfo
    if (bestLinked != currentLinked) return currentLinked ? current : best
    return current.durationGap < best.durationGap ? current : best
  }).item
}

export const getMusicUrl = async({ musicInfo, isRefresh, allowToggleSource = true, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoLocal
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  allowToggleSource?: boolean
}): Promise<string> => {
  if (!isRefresh) {
    const path = await getLocalFilePath(musicInfo)
    // console.log(path)
    if (path) return path
  }

  try {
    return await getOnlineOtherSourceMusicUrlByLocal(musicInfo, isRefresh).then(({ url, quality, isFromCache }) => {
      if (!isFromCache) void saveMusicUrl(musicInfo, quality, url)
      return url
    })
  } catch {}

  if (!allowToggleSource) throw new Error('failed')

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourceMusicUrl({ musicInfos: [...otherSource], onToggleSource, isRefresh }).then(({ url, quality: targetQuality, musicInfo: targetMusicInfo, isFromCache }) => {
      // saveLyric(musicInfo, data.lyricInfo)
      if (!isFromCache) void saveMusicUrl(targetMusicInfo, targetQuality, url)

      // TODO: save url ?
      return url
    })
  })
}

export const getPicUrl = async({ musicInfo, listId, isRefresh, skipFilePic, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoLocal
  listId?: string | null
  isRefresh: boolean
  skipFilePic?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if (!isRefresh && !skipFilePic) {
    let pic = await readPic(musicInfo.meta.filePath).catch(() => null)
    if (pic) {
      if (pic.startsWith('/')) pic = `file://${pic}`
      return pic
    }

    if (musicInfo.meta.picUrl) return musicInfo.meta.picUrl
  }

  try {
    return await getOnlineOtherSourcePicByLocal(musicInfo).then(({ url }) => {
      return url
    })
  } catch {}

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourcePicUrl({ musicInfos: [...otherSource], onToggleSource, isRefresh }).then(({ url, musicInfo: targetMusicInfo, isFromCache }) => {
      if (listId) {
        musicInfo.meta.picUrl = url
        void updateListMusics([{ id: listId, musicInfo }])
      }

      return url
    })
  })
}

export const parseLyric = (lrc: string): LX.Music.LyricInfo => {
  const verifyAwlrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)]<\d+,\d+>.+$/m.test(lrc)
  }
  const verifylrc = (lrc: string) => {
    return /(?:^|\s*)\[\d+:\d+(?:\.\d+)].+$/m.test(lrc)
  }
  const lrcTags = {
    awlrc: {
      name: 'lxlyric',
      verify: verifyAwlrc,
    },
    lrc: {
      name: 'lyric',
      verify: verifylrc,
    },
    tlrc: {
      name: 'tlyric',
      verify: verifylrc,
    },
    rlrc: {
      name: 'rlyric',
      verify: verifylrc,
    },
  } as const
  const tagRxp = /(?:^|\n\s*)\[awlrc:([^\]]+)]/i
  const lrcRxp = /^(lrc|awlrc|tlrc|rlrc):([^,]+)$/i
  const parse = (content: string) => {
    const lyricInfo: Partial<LX.Music.LyricInfo> = {}
    const lrcs = content.trim().split(',')
    for (const lrc of lrcs) {
      const result = lrcRxp.exec(lrc.trim())
      if (!result) continue
      const target = lrcTags[result[1].toLowerCase() as 'tlrc' | 'rlrc' | 'lrc' | 'awlrc']
      if (!target) continue
      const data = Buffer.from(result[2], 'base64').toString('utf-8').trim()
      if (target.verify(data)) lyricInfo[target.name] = data
    }
    return lyricInfo
  }
  let parsedInfo: Partial<LX.Music.LyricInfo> = {}
  let lyric = lrc.replace(tagRxp, (_: string, p1: string) => {
    parsedInfo = parse(p1)
    return ''
  }).trim()
  return { lyric, ...parsedInfo }
}

const getMusicFileLyric = async(filePath: string) => {
  const lyric = await readLyric(filePath).catch(() => null)
  if (!lyric) return null
  return parseLyric(lyric)
}
export const getLyricInfo = async({ musicInfo, isRefresh, skipFileLyric, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoLocal
  skipFileLyric?: boolean
  isRefresh: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  if (!isRefresh && !skipFileLyric) {
    // const lyricInfo = await getCachedLyricInfo(musicInfo)
    // if (lyricInfo?.rawlrcInfo.lyric && lyricInfo.lyric != lyricInfo.rawlrcInfo.lyric) {
    //   // 存在已编辑歌词
    //   return buildLyricInfo(lyricInfo)
    // }

    // 尝试读取文件内歌词
    const rawlrcInfo = await getMusicFileLyric(musicInfo.meta.filePath)
    if (rawlrcInfo) return buildLyricInfo(rawlrcInfo)

    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo?.lyric) return buildLyricInfo(lyricInfo)
  }

  try {
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    return await getOnlineOtherSourceLyricByLocal(musicInfo, isRefresh).then(({ lyricInfo, isFromCache }) => {
      if (!isFromCache) void saveLyric(musicInfo, lyricInfo)
      return buildLyricInfo(lyricInfo)
    })
  } catch {}

  onToggleSource()
  return getOtherSourceByLocal(musicInfo, async(otherSource) => {
    return getOnlineOtherSourceLyricInfo({ musicInfos: [...otherSource], onToggleSource, isRefresh }).then(async({ lyricInfo, musicInfo: targetMusicInfo, isFromCache }) => {
      void saveLyric(musicInfo, lyricInfo)

      if (isFromCache) return buildLyricInfo(lyricInfo)
      void saveLyric(targetMusicInfo, lyricInfo)

      return buildLyricInfo(lyricInfo)
    })
  })
}
