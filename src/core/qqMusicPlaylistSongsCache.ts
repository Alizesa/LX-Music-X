import { getQQMusicPlaylistSongsCache, removeQQMusicPlaylistSongsCache, saveQQMusicPlaylistSongsCache } from '@/utils/data'

/**
 * 歌单歌曲的持久缓存。
 *
 * 取一个歌单的歌要翻好几页（上百首），所以打开过的歌单缓存下来，
 * 下次进页面直接显示，只有下拉刷新才联网 —— 这个分支有意压低对音源的请求量。
 *
 * 只留最近打开的若干个：歌单歌曲动辄上百首，全存下来 storage 会越来越臃肿。
 */
const MAX_ENTRIES = 6

export const getCachedPlaylistSongs = async(id: string): Promise<LX.Music.MusicInfoOnline[] | null> => {
  const cache = await getQQMusicPlaylistSongsCache()
  return cache[id]?.songs ?? null
}

export const cachePlaylistSongs = async(id: string, songs: LX.Music.MusicInfoOnline[]) => {
  const cache = await getQQMusicPlaylistSongsCache()
  cache[id] = { songs, savedAt: Date.now() }
  const entries = Object.entries(cache)
  if (entries.length > MAX_ENTRIES) {
    // 按时间倒序留下最新的几个，其余丢掉
    entries.sort((a, b) => b[1].savedAt - a[1].savedAt)
    for (const [key] of entries.slice(MAX_ENTRIES)) delete cache[key]
  }
  await saveQQMusicPlaylistSongsCache(cache)
}

/** 往歌单里加/删歌之后调用，别让界面再拿旧的列表 */
export const dropCachedPlaylistSongs = async(id: string) => {
  const cache = await getQQMusicPlaylistSongsCache()
  if (!(id in cache)) return
  delete cache[id]
  await saveQQMusicPlaylistSongsCache(cache)
}

/** 换号时清掉，否则新号会看到上一个号的歌单内容 */
export const clearPlaylistSongsCache = async() => {
  await removeQQMusicPlaylistSongsCache()
}
