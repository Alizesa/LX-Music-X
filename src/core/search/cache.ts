import music from '@/store/search/music/state'
import songlist from '@/store/search/songlist/state'
import singer from '@/store/search/singer/state'
import album from '@/store/search/album/state'
import { getSearchResultCache, removeSearchResultCache, saveSearchResultCache } from '@/utils/data'
import { isSearchPending, onSearchSettled } from './request'

type Kind = 'music' | 'songlist' | 'singer' | 'album'
interface ListInfo { list: unknown[], key: string | null, page: number, limit: number, total: number, maxPage?: number }
interface Snapshot { savedAt: number, info: ListInfo, maxPages?: Partial<Record<LX.OnlineSource | 'all', number>> }
const IDLE_DELAY = 60_000
const MEMORY_LIMIT = 3000
const DISK_TTL = 15 * 60_000
let holders = 0
let timer: ReturnType<typeof setTimeout> | null = null
let releasing: Promise<void> = Promise.resolve()
// 磁盘删除失败时也不能在本次运行中恢复已被新结果取代的快照。
const invalidated = new Set<string>()

const records = () => [
  ...Object.entries(music.listInfos).map(([source, info]) => ({ kind: 'music' as const, source, info: info as ListInfo })),
  ...Object.entries(songlist.listInfos).map(([source, info]) => ({ kind: 'songlist' as const, source, info: info as ListInfo })),
  { kind: 'singer' as const, source: 'tx', info: singer.listInfo as ListInfo },
  { kind: 'album' as const, source: 'tx', info: album.listInfo as ListInfo },
]

const scheduleRelease = () => {
  if (holders || timer) return
  const count = records().reduce((sum, record) => sum + record.info.list.length, 0)
  if (!count) return
  timer = setTimeout(() => { void releaseIdleSearchCaches() }, count > MEMORY_LIMIT ? 0 : IDLE_DELAY)
}
onSearchSettled(scheduleRelease)

/** 首次加载/刷新成功后使旧快照失效；空结果同样有效，失败或取消的请求不调用。 */
export const invalidateSearchResult = (kind: Kind, source: string) => {
  const key = `${kind}_${source}`
  invalidated.add(key)
  // 与闲置保存串行：已经开始的旧快照写入必须先结束，再删除。
  releasing = releasing.catch(() => {}).then(async() => {
    try {
      await removeSearchResultCache(key)
    } catch (error) {
      console.warn('[Search] cache remove:', error instanceof Error ? error.message : error)
    }
  })
}

/** 搜索页面仍在导航栈中时保留返回所需数据；关闭后才允许淘汰。 */
export const retainSearchResults = () => {
  holders++
  if (timer) clearTimeout(timer)
  timer = null
  let released = false
  return () => {
    if (released) return
    released = true
    holders--
    if (holders) return
    scheduleRelease()
  }
}

export const releaseIdleSearchCaches = async() => {
  if (holders) return
  if (timer) clearTimeout(timer)
  timer = null
  releasing = releasing.catch(() => {}).then(async() => {
    for (const { kind, source, info } of records()) {
      if (holders) return
      if (!info.list.length || isSearchPending(kind)) continue
      const snapshot: Snapshot = {
        savedAt: Date.now(),
        info: { ...info },
        maxPages: kind === 'music' ? { ...music.maxPages } : kind === 'songlist' ? { ...songlist.maxPages } : undefined,
      }
      const key = `${kind}_${source}`
      let saved = false
      try {
        await saveSearchResultCache(key, snapshot)
        saved = true
      } catch (error) {
        console.warn('[Search] cache save:', error instanceof Error ? error.message : error)
      }
      if (holders || info.list !== snapshot.info.list || info.key !== snapshot.info.key) continue
      if (saved) invalidated.delete(key)
      // 重新赋值，不修改播放队列或尚未完成的调用持有的原数组。
      info.list = []
      info.key = null
      info.page = 0
      info.total = 0
      if (info.maxPage != null) info.maxPage = 0
    }
  })
  return releasing
}

/** 淘汰后的同一搜索可从本地恢复所有已翻页结果，不增加音源请求。 */
export const restoreSearchResult = async(kind: Kind, source: string, text: string, signal?: AbortSignal) => {
  await releasing
  const cacheKey = `${kind}_${source}`
  const isInvalid = () => signal?.aborted === true || invalidated.has(cacheKey)
  const record = records().find(item => item.kind === kind && item.source === source)
  if (!record || record.info.list.length || isInvalid()) return false
  const saved = await getSearchResultCache<Snapshot>(cacheKey).catch(() => null)
  if (saved == null || record.info.list.length > 0 || isInvalid()) return false
  if (!Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > DISK_TTL) return false
  if (!Array.isArray(saved.info?.list) || !saved.info.list.length || !Number.isInteger(saved.info.page) || saved.info.page < 1) return false
  const key = kind === 'songlist' ? `${saved.info.page}__${source}__${text}` : `${saved.info.page}__${text}`
  if (saved.info.key !== key) return false
  Object.assign(record.info, saved.info)
  if (kind === 'music') {
    music.searchText = text
    music.source = source as typeof music.source
    Object.assign(music.maxPages, saved.maxPages)
  } else if (kind === 'songlist') {
    songlist.searchText = text
    songlist.source = source as typeof songlist.source
    Object.assign(songlist.maxPages, saved.maxPages)
  } else if (kind === 'singer') singer.searchText = text
  else album.searchText = text
  return true
}
