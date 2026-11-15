import { type ListDetailInfo } from '@/store/songlist/state'
import songlistActions from '@/store/songlist/action'
import { deduplicationList, toNewMusicInfo } from '@/utils'
import musicSdk from '@/utils/musicSdk'
import { withRequestSignal } from '@/utils/musicSdk/requestScope'
import { throwIfAborted, withAbort } from '@/utils/abort'
import { getDetailCache, saveDetailCache } from './detailCache'


type LimitDetailCache = Map<number, ListDetailInfo>
interface DetailCursor {
  sourcePage: number
  nextPage: number
  loaded: number
  pending: ListDetailInfo['list']
  ids: Set<string>
  done: boolean
  info: ListDetailInfo | null
  loading: Promise<void> | null
  controller: AbortController | null
  consumers: Set<symbol>
}
const detailCursors = new WeakMap<LimitDetailCache, DetailCursor>()
const restoredCaches = new WeakSet<LimitDetailCache>()
const restoringCaches = new WeakMap<LimitDetailCache, Promise<void>>()
const releasedCaches = new WeakSet<LimitDetailCache>()
type SavedCursor = Pick<DetailCursor, 'sourcePage' | 'nextPage' | 'loaded' | 'pending' | 'done' | 'info'> & { pages: number[] }

const saveCursor = (key: string, value: LimitDetailCache, cursor: DetailCursor, firstPage: number) => {
  for (const [page, result] of value) {
    if (page >= firstPage) saveDetailCache(`${key}::page:${page}`, result)
  }
  saveDetailCache(key, {
    sourcePage: cursor.sourcePage,
    nextPage: cursor.nextPage,
    loaded: cursor.loaded,
    pending: [...cursor.pending],
    done: cursor.done,
    info: cursor.info,
    pages: [...value.keys()],
  } satisfies SavedCursor)
}
const restoreCursor = async(key: string, value: LimitDetailCache) => {
  if (restoredCaches.has(value)) return
  const pending = restoringCaches.get(value)
  if (pending) return pending
  const task = (async() => {
    const saved = await getDetailCache<SavedCursor>(key)
    if (!saved || !Array.isArray(saved.pages) || !Array.isArray(saved.pending) || !saved.info ||
      !Number.isInteger(saved.sourcePage) || saved.sourcePage < 1 || !Number.isInteger(saved.loaded) || saved.loaded < 0 ||
      saved.nextPage !== saved.pages.length + 1 || typeof saved.done !== 'boolean') return
    if (detailKey(saved.info.source, saved.info.id) !== key) return
    if (cache.get(key) !== value) return
    const pages = new Map<number, ListDetailInfo>()
    for (let index = 0; index < saved.pages.length; index++) {
      const page = saved.pages[index]
      if (page !== index + 1) return
      const result = await getDetailCache<ListDetailInfo>(`${key}::page:${page}`)
      if (cache.get(key) !== value) return
      if (!result || !Array.isArray(result.list)) return
      pages.set(page, saved.done ? { ...result, total: saved.loaded, maxPage: Math.ceil(saved.loaded / LIST_LOAD_LIMIT) } : result)
    }
    if (cache.get(key) !== value || value.size || detailCursors.has(value)) return
    if ([...pages.values()].reduce((sum, page) => sum + page.list.length, saved.pending.length) !== saved.loaded) return
    const ids = new Set<string>()
    for (const page of pages.values()) for (const music of page.list) ids.add(music.id)
    for (const music of saved.pending) ids.add(music.id)
    for (const [page, result] of pages) value.set(page, result)
    detailCursors.set(value, { ...saved, ids, loading: null, controller: null, consumers: new Set() })
  })().finally(() => { restoredCaches.add(value); restoringCaches.delete(value) })
  restoringCaches.set(value, task)
  return task
}

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
  const value = cache.get(key)
  if (value) releasedCaches.delete(value)
}
export const releaseSonglistDetail = (source: LX.OnlineSource, id: string) => {
  const key = detailKey(source, id)
  const count = retainedDetailKeys.get(key) ?? 0
  if (count > 1) retainedDetailKeys.set(key, count - 1)
  else {
    retainedDetailKeys.delete(key)
    const value = cache.get(key)
    if (value) {
      releasedCaches.add(value)
      if (!loadingDetailCaches.has(value)) cache.delete(key)
    }
  }
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
    total += page.list.length
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
    if (!loadingDetailCaches.has(value) && releasedCaches.has(value)) {
      for (const [key, current] of cache) if (current === value && !retainedDetailKeys.has(key)) cache.delete(key)
    }
    pruneDetailCache()
  }
}
const makeDetailPage = (cursor: DetailCursor, page: number, list: ListDetailInfo['list']): ListDetailInfo => {
  const total = cursor.done ? cursor.loaded : cursor.info!.total
  return { ...cursor.info!, list, page, total, limit: LIST_LOAD_LIMIT, maxPage: Math.ceil(total / LIST_LOAD_LIMIT) }
}
const loadDetailSourcePage = async(source: LX.OnlineSource, id: string, listKey: string, value: LimitDetailCache, cursor: DetailCursor, signal: AbortSignal) => {
  throwIfAborted(signal)
  const provider = musicSdk[source]?.songList
  const result: ListDetailInfo = await withAbort((provider
    ? withRequestSignal(provider, signal).getListDetail(id, cursor.sourcePage + 1)
    : Promise.reject(new Error('source not found'))) as Promise<ListDetailInfo>, signal)
  throwIfAborted(signal)
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
  const firstPage = cursor.nextPage
  let offset = 0
  while (buffered.length - offset >= LIST_LOAD_LIMIT || (cursor.done && offset < buffered.length)) {
    const page = cursor.nextPage++
    value.set(page, makeDetailPage(cursor, page, buffered.slice(offset, offset + LIST_LOAD_LIMIT)))
    offset += LIST_LOAD_LIMIT
  }
  cursor.pending = buffered.slice(offset)
  if (cursor.done) {
    // 源总数可能含无效/被过滤的歌曲；读完后用实际行数结束，不继续请求空页。
    for (const data of value.values()) {
      data.total = cursor.loaded
      data.maxPage = Math.ceil(cursor.loaded / LIST_LOAD_LIMIT)
    }
  }
  saveCursor(listKey, value, cursor, firstPage)
}

/** 同一源游标顺序推进到目标 UI 页，缺失的前页由该循环一并补齐。 */
const getListDetailLimit = async(source: LX.OnlineSource, id: string, page: number, isRefresh = false, signal?: AbortSignal): Promise<ListDetailInfo> => {
  throwIfAborted(signal)
  const listKey = detailKey(source, id)
  let value = cache.get(listKey)
  if (!value || isRefresh) {
    value = new Map()
    cache.set(listKey, value)
    if (isRefresh) restoredCaches.add(value)
  } else touchCache(listKey)
  const listCache = value
  await restoreCursor(listKey, listCache)
  throwIfAborted(signal)
  if (cache.get(listKey) !== listCache) throw new Error('Songlist request superseded')
  const cached = listCache.get(page)
  if (cached) return cached
  let current = detailCursors.get(listCache)
  if (!current) {
    current = { sourcePage: 0, nextPage: 1, loaded: 0, pending: [], ids: new Set(), done: false, info: null, loading: null, controller: null, consumers: new Set() }
    detailCursors.set(listCache, current)
  }
  const cursor = current
  return withDetailCache(listCache, async() => {
    const consumer = Symbol('songlist consumer')
    cursor.consumers.add(consumer)
    try {
      while (!listCache.has(page) && !cursor.done) {
        throwIfAborted(signal)
        // 并发页面/全量点播共享同一源请求，失败只重试尚未成功的源页。
        if (!cursor.loading) {
          const controller = new AbortController()
          cursor.controller = controller
          const request = loadDetailSourcePage(source, id, listKey, listCache, cursor, controller.signal).finally(() => {
            if (cursor.loading === request) cursor.loading = null
            if (cursor.controller === controller) cursor.controller = null
          })
          cursor.loading = request
        }
        await withAbort(cursor.loading, signal)
        throwIfAborted(signal)
        if (cache.get(listKey) !== listCache) throw new Error('Songlist request superseded')
      }
      return listCache.get(page) ?? makeDetailPage(cursor, page, [])
    } finally {
      cursor.consumers.delete(consumer)
      if (!cursor.consumers.size && cursor.loading) {
        cursor.controller?.abort()
        cursor.controller = null
        cursor.loading = null
      }
    }
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
 * 获取歌单内单页歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetail = async(id: string, source: LX.OnlineSource, page: number, isRefresh = false, signal?: AbortSignal): Promise<ListDetailInfo> => {
  return getListDetailLimit(source, id, page, isRefresh, signal)
}

/**
 * 获取歌单内全部歌曲
 * @param id 歌单id
 * @param source 歌单源
 * @param isRefresh 是否跳过缓存
 * @returns
 */
export const getListDetailAll = async(source: LX.OnlineSource, id: string, isRefresh = false, signal?: AbortSignal): Promise<LX.Music.MusicInfoOnline[]> => {
  throwIfAborted(signal)
  const listKey = `sdetail__${source}__${id}`
  let listCache = cache.get(listKey)
  if (!listCache || isRefresh) {
    listCache = new Map()
    cache.set(listKey, listCache)
    if (isRefresh) restoredCaches.add(listCache)
  } else {
    touchCache(listKey)
  }

  const heldCache = listCache
  return withDetailCache(heldCache, async() => {
    const loadData = async(page: number): Promise<ListDetailInfo> => {
      throwIfAborted(signal)
      if (cache.get(listKey) !== heldCache) throw new Error('Songlist request superseded')
      return heldCache.get(page) ?? getListDetailLimit(source, id, page, false, signal)
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
