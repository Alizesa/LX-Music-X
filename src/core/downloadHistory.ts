import { storageDataPrefix } from '@/config/constant'
import {
  getDownloadHistory,
  getDownloadHistoryItems,
  getDownloadHistoryKeys,
  getDownloadHistoryMigrated,
  removeDownloadHistoryItems,
  removeLegacyDownloadHistory,
  saveDownloadHistoryItems,
  saveDownloadHistoryMigrated,
} from '@/utils/data'

interface Entry { id: string, createdAt: number, key: string }
const PAGE_SIZE = 100
const CACHE_LIMIT = 200
const entries = new Map<string, Entry>()
let ordered: Entry[] = []
const cache = new Map<string, LX.Download.DownloadHistoryItem>()
let initPromise: Promise<void> | null = null
let writes: Promise<void> = Promise.resolve()

const keyFor = (item: LX.Download.DownloadHistoryItem) =>
  `${storageDataPrefix.downloadHistoryItem}${item.createdAt}__${encodeURIComponent(item.id)}`

const readKey = (key: string): Entry | null => {
  const value = key.slice(storageDataPrefix.downloadHistoryItem.length)
  const split = value.indexOf('__')
  const createdAt = Number(value.slice(0, split))
  if (split < 1 || !Number.isFinite(createdAt)) return null
  try {
    const id = decodeURIComponent(value.slice(split + 2))
    return id ? { key, createdAt, id } : null
  } catch { return null }
}

const sortIndex = () => {
  ordered = [...entries.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}
const remember = (item: LX.Download.DownloadHistoryItem) => {
  cache.delete(item.id)
  cache.set(item.id, item)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

/** 只常驻 id、排序时间与存储 key。旧整表成功迁移后才删除，失败可以原样重试。 */
export const initDownloadHistory = async() => {
  initPromise ??= (async() => {
    entries.clear()
    for (const key of await getDownloadHistoryKeys()) {
      const entry = readKey(key)
      if (entry) entries.set(entry.id, entry)
    }
    if (!await getDownloadHistoryMigrated()) {
      const legacy = await getDownloadHistory()
      for (let offset = 0; offset < legacy.length; offset += PAGE_SIZE) {
        const page = [...new Map(legacy.slice(offset, offset + PAGE_SIZE).filter(item =>
          item && typeof item.id === 'string' && Number.isFinite(item.createdAt)).map(item => [item.id, item])).values()]
          .filter(item => !entries.has(item.id))
        await saveDownloadHistoryItems(page.map(item => [keyFor(item), item]))
        for (const item of page) entries.set(item.id, { id: item.id, createdAt: item.createdAt, key: keyFor(item) })
      }
      await saveDownloadHistoryMigrated()
    }
    sortIndex()
    await removeLegacyDownloadHistory().catch(() => {})
  })().catch((error: unknown) => {
    initPromise = null
    throw error
  })
  return initPromise
}

export const getDownloadHistoryCount = () => entries.size
export const getDownloadHistoryIds = () => entries.keys()
export const getDownloadHistoryEntries = (): ReadonlyArray<Pick<Entry, 'id' | 'createdAt'>> => ordered
export const hasDownloadHistory = (id: string) => entries.has(id)
export const releaseDownloadHistoryCache = () => { cache.clear() }

const readEntries = async(selected: Entry[]) => {
  const result: LX.Download.DownloadHistoryItem[] = []
  for (let offset = 0; offset < selected.length; offset += PAGE_SIZE) {
    const page = selected.slice(offset, offset + PAGE_SIZE)
    // 等待读盘期间缓存可能因页面隐藏被清空，先保留本页命中的引用。
    const cached = new Map(page.map(entry => [entry.id, cache.get(entry.id)]))
    const missing = page.filter(entry => !cached.get(entry.id))
    const loaded = new Map(missing.length ? await getDownloadHistoryItems(missing.map(entry => entry.key)) : [])
    for (const entry of page) {
      if (entries.get(entry.id)?.key !== entry.key) continue
      const value = cached.get(entry.id) ?? loaded.get(entry.key) as LX.Download.DownloadHistoryItem | null
      if (!value || value.id !== entry.id) continue
      remember(value)
      result.push(value)
    }
  }
  return result
}

export const getDownloadHistoryPage = async(offset: number, limit: number) => {
  await initDownloadHistory()
  await writes
  return readEntries(ordered.slice(offset, offset + limit))
}

export const getDownloadHistoryByIds = async(ids: string[]) => {
  await initDownloadHistory()
  await writes
  return readEntries(ids.map(id => entries.get(id)).filter((entry): entry is Entry => entry != null))
}

const enqueueWrite = async<T>(work: () => Promise<T>): Promise<T> => {
  await initDownloadHistory()
  const result = writes.then(work)
  writes = result.then(() => {}, () => {})
  return result
}

export const addDownloadHistory = async(items: LX.Download.DownloadHistoryItem[]) => enqueueWrite(async() => {
  const added = [...new Map(items.map(item => [item.id, item])).values()].filter(item => !entries.has(item.id))
  try {
    for (let offset = 0; offset < added.length; offset += PAGE_SIZE) {
      const page = added.slice(offset, offset + PAGE_SIZE)
      await saveDownloadHistoryItems(page.map(item => [keyFor(item), item]))
      for (const item of page) {
        entries.set(item.id, { id: item.id, createdAt: item.createdAt, key: keyFor(item) })
        remember(item)
      }
    }
  } finally { sortIndex() }
})

export const removeDownloadHistory = async(ids: Set<string>, readRemoved = true) => enqueueWrite(async() => {
  const selected = ordered.filter(entry => ids.has(entry.id))
  const removed = readRemoved ? await readEntries(selected) : []
  try {
    for (let offset = 0; offset < selected.length; offset += PAGE_SIZE) {
      const page = selected.slice(offset, offset + PAGE_SIZE)
      await removeDownloadHistoryItems(page.map(entry => entry.key))
      for (const entry of page) {
        entries.delete(entry.id)
        cache.delete(entry.id)
      }
    }
  } finally { sortIndex() }
  return removed
})
