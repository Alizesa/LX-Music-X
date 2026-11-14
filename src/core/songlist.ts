import { type ListDetailInfo } from '@/store/songlist/state'
import songlistActions from '@/store/songlist/action'
import { deduplicationList, toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'


interface DetailPageCache { data: ListDetailInfo, sourcePage: number }
type LimitDetailCache = Map<string, DetailPageCache>
interface DetailCursor {
  sourcePage: number
  nextPage: number
  loaded: number
  pending: ListDetailInfo['list']
  ids: Set<string>
  done: boolean
  info: ListDetailInfo | null
  loading: Promise<void> | null
}
const detailCursors = new WeakMap<LimitDetailCache, DetailCursor>()

const cache = new Map<string, LimitDetailCache>()
const LIST_LOAD_LIMIT = 30
// 歌单详情缓存的上限：最多留 8 个歌单、合计 3000 首。
// 没有上限的话，搜过/开过多少个歌单，就有多少份完整歌曲信息常驻到进程结束。
const DETAIL_CACHE_MAX = 8
const DETAIL_CACHE_MAX_SONGS = 3000
// 按缓存对象占用：旧请求结束不能解除同一个 ID 的新请求的保护。
const loadingDetailCaches = new Map<LimitDetailCache, number>()
// 当前正在显示的详情页；后台统一释放时也要跳过
const retainedDetailKeys = new Map<string, number>()
const detailKey = (source: LX.OnlineSource, id: string) => `sdetail__${source}__${id}`

export const retainSonglistDetail = (source: LX.OnlineSource, id: string) => {
  const key = detailKey(source, id)
  retainedDetailKeys.set(key, (retainedDetailKeys.get(key) ?? 0) + 1)
}
export const releaseSonglistDetail = (source: LX.OnlineSource, id: string) => {
  const key = detailKey(source, id)
  const count = retainedDetailKeys.get(key) ?? 0
  if (count > 1) retainedDetailKeys.set(key, count - 1)
  else retainedDetailKeys.delete(key)
}

// Map 保持插入顺序：删了再塞就排到末尾，淘汰时从头部拿最久没用的
const touchCache = (key: string) => {
  const value = cache.get(key)
  if (value === undefined) return
  cache.delete(key)
  cache.set(key, value)
}

const countCachedSongs = (value: LimitDetailCache) => {
  let total = detailCursors.get(value)?.pending.length ?? 0
  for (const page of value.values()) {
    total += page.data.list.length
  }
  return total
}

/** 后台/设置页清理：释放所有非加载中、非当前展示的歌单缓存 */
export const releaseIdleSonglistCaches = () => {
  for (const [key, value] of cache) {
    if (loadingDetailCaches.has(value) || retainedDetailKeys.has(key)) continue
    cache.delete(key)
  }
}

const pruneDetailCache = () => {
  const detailKeys: string[] = []
  let totalSongs = 0
  for (const [key, value] of cache) {
    detailKeys.push(key)
    totalSongs += countCachedSongs(value)
  }
  if (detailKeys.length <= DETAIL_CACHE_MAX && totalSongs <= DETAIL_CACHE_MAX_SONGS) return

  // 最新的那个对应刚访问/正在加载的歌单，无论如何留着，
  // 否则单个超大歌单会刚拿完就被自己挤掉
  const newestKey = detailKeys[detailKeys.length - 1]
  let count = detailKeys.length
  for (const key of detailKeys) {
    if (count <= DETAIL_CACHE_MAX && totalSongs <= DETAIL_CACHE_MAX_SONGS) break
    if (key === newestKey || loadingDetailCaches.has(cache.get(key)!) || retainedDetailKeys.has(key)) continue
    totalSongs -= countCachedSongs(cache.get(key)!)
    cache.delete(key)
    count--
  }
}


/** 整次读取期间保留缓存，完整列表的相邻源请求之间也不能被淘汰。 */
const withDetailCache = async<T>(value: LimitDetailCache, read: () => Promise<T>): Promise<T> => {
  loadingDetailCaches.set(value, (loadingDetailCaches.get(value) ?? 0) + 1)
  try { return await read() } finally {
    const users = loadingDetailCaches.get(value)!
    if (users > 1) loadingDetailCaches.set(value, users - 1)
    else loadingDetailCaches.delete(value)
    pruneDetailCache()
  }
}
const makeDetailPage = (cursor: DetailCursor, page: number, list: ListDetailInfo['list']): ListDetailInfo => {
  const total = cursor.done ? cursor.loaded : cursor.info!.total
  return { ...cursor.info!, list, page, total, limit: LIST_LOAD_LIMIT, maxPage: Math.ceil(total / LIST_LOAD_LIMIT) }
}
const loadDetailSourcePage = async(source: LX.OnlineSource, id: string, listKey: string, value: LimitDetailCache, cursor: DetailCursor) => {
  const result: ListDetailInfo = await (musicSdk[source]?.songList.getListDetail(id, cursor.sourcePage + 1) ?? Promise.reject(new Error('source not found')))
  if (cache.get(listKey) !== value) throw new Error('Songlist request superseded')
  const total = Number(result.total)
  const limit = Number(result.limit)
  if (!Number.isFinite(total) || total < 0 || (total > 0 && (!Number.isFinite(limit) || limit <= 0))) throw new Error('Invalid songlist pagination')
  const rows = deduplicationList(result.list.map(m => toNewMusicInfo(m)) as LX.Music.MusicInfoOnline[]).filter(music => {
    if (cursor.ids.has(music.id)) return false
    cursor.ids.add(music.id)
    return true
  })
  cursor.sourcePage++
  cursor.loaded += rows.length
  cursor.done = total === 0 || cursor.sourcePage >= Math.ceil(total / limit)
  cursor.info = { ...result, id, source, total, key: null, list: [] }
  const buffered = [...cursor.pending, ...rows]
  let offset = 0
  while (buffered.length - offset >= LIST_LOAD_LIMIT || (cursor.done && offset < buffered.length)) {
    const page = cursor.nextPage++
    value.set(`${listKey}__${page}`, {
      data: makeDetailPage(cursor, page, buffered.slice(offset, offset + LIST_LOAD_LIMIT)),
      sourcePage: cursor.sourcePage,
    })
    offset += LIST_LOAD_LIMIT
  }
  cursor.pending = buffered.slice(offset)
  if (cursor.done) {
    // 源总数可能含无效/被过滤的歌曲；读完后用实际行数结束，不继续请求空页。
    for (const { data } of value.values()) {
      data.total = cursor.loaded
      data.maxPage = Math.ceil(cursor.loaded / LIST_LOAD_LIMIT)
    }
  }
}

const getListDetailLimit = async(source: LX.OnlineSource, id: string, page: number): Promise<ListDetailInfo> => {
  const listKey = detailKey(source, id)
  let value = cache.get(listKey)
  if (!value) {
    value = new Map()
    cache.set(listKey, value)
  } else touchCache(listKey)
  const listCache = value
  let current = detailCursors.get(listCache)
  if (!current) {
    current = { sourcePage: 0, nextPage: 1, loaded: 0, pending: [], ids: new Set(), done: false, info: null, loading: null }
    detailCursors.set(listCache, current)
  }
  const cursor = current
  const pageKey = `${listKey}__${page}`
  return withDetailCache(listCache, async() => {
    while (!listCache.has(pageKey) && !cursor.done) {
      // 并发页面/全量点播共享同一源请求，失败只重试尚未成功的源页。
      if (!cursor.loading) {
        const request = loadDetailSourcePage(source, id, listKey, listCache, cursor).finally(() => {
          if (cursor.loading === request) cursor.loading = null
        })
        cursor.loading = request
      }
      await cursor.loading
      if (cache.get(listKey) !== listCache) throw new Error('Songlist request superseded')
    }
    return listCache.get(pageKey)?.data ?? makeDetailPage(cursor, page, [])
  })
}

/**
 * 设置歌单详情加载前的基本信息（用于加载失败后的重新加载）
 * @param source
 * @param id
 */
export const setListDetailInfo: typeof songlistActions.setListDetailInfo = (source, id) => {
  clearListDetail()
  songlistActions.setListDetailInfo(source, id)
}
export const setListDetail: typeof songlistActions.setListDetail = (result, id, page) => {
  return songlistActions.setListDetail(result, id, page)
}

export const clearListDetail = () => {
  songlistActions.clearListDetail()
}

/**
 * 详情缓存被淘汰后，从首个源页重建游标和之前的 UI 页，避免把源第一页
 * 当成第 N 页。正在加载的请求共用游标，不重复请求成功的源页。
 * 只有长期没打开、缓存已被淘汰的歌单继续往下翻时才会走到这里。
 */
const ensurePreviousPages = async(source: LX.OnlineSource, id: string, page: number) => {
  if (page <= 1) return
  const listKey = `sdetail__${source}__${id}`
  for (let p = 1; p < page; p++) {
    const listCache = cache.get(listKey)
    if (listCache?.get(`${listKey}__${p}`)) continue
    await getListDetailLimit(source, id, p)
  }
}

/**
 * 获取歌单内单页歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false): Promise<ListDetailInfo> => {
  const listKey = `sdetail__${source}__${id}`
  const pageKey = `sdetail__${source}__${id}__${page}`

  let listCache = cache.get(listKey)
  if (!listCache || isRefresh) {
    listCache = new Map()
    cache.set(listKey, listCache)
  } else {
    touchCache(listKey)
  }

  let pageCache = listCache.get(pageKey)
  if (pageCache) return pageCache.data

  await ensurePreviousPages(source, id, page)
  // 重建前面的页时，一次音源请求可能已经填好了当前页，优先复用，避免重复取页覆盖结果。
  pageCache = cache.get(listKey)?.get(pageKey)
  if (pageCache) return pageCache.data
  return getListDetailLimit(source, id, page)
}

/**
 * 获取歌单内全部歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetailAll = async(source: LX.OnlineSource, id: string, isRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  const listKey = `sdetail__${source}__${id}`
  let listCache = cache.get(listKey)
  if (!listCache || isRefresh) {
    listCache = new Map()
    cache.set(listKey, listCache)
  } else {
    touchCache(listKey)
  }

  const heldCache = listCache
  return withDetailCache(heldCache, async() => {
    const loadData = async(page: number): Promise<ListDetailInfo> => {
      if (cache.get(listKey) !== heldCache) throw new Error('Songlist request superseded')
      const pageKey = `${listKey}__${page}`
      return heldCache.get(pageKey)?.data ?? getListDetailLimit(source, id, page)
    }
    const first = await loadData(1)
    if (first.total <= first.limit) return deduplicationList(first.list)

    const all: LX.Music.MusicInfoOnline[] = [...first.list]
    for (let page = 2; page <= Math.ceil(first.total / first.limit); page++) {
      const data = await loadData(page)
      all.push(...data.list)
      if (!data.list.length || page >= Math.ceil(data.total / data.limit)) break
    }
    return deduplicationList(all)
  })
}
