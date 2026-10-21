import {
  getQQMusicPlaylistSongsCache,
  getQQMusicPlaylistSongsIndex,
  getQQMusicPlaylistSongsItem,
  getQQMusicPlaylistSongsItemKey,
  getQQMusicPlaylistSongsItemKeys,
  getQQMusicPlaylistSongsItemPrefix,
  removeQQMusicPlaylistSongsCache,
  removeQQMusicPlaylistSongsIndexAndLegacy,
  removeQQMusicPlaylistSongsItem,
  removeQQMusicPlaylistSongsItems,
  saveQQMusicPlaylistSongsIndex,
  saveQQMusicPlaylistSongsItem,
  type QQMusicPlaylistSongsIndex,
  type QQMusicPlaylistSongsItem,
} from '@/utils/data'

/**
 * 歌单歌曲的持久缓存。
 *
 * 取一个歌单的歌要翻好几页（上百首），所以打开过的歌单缓存下来，
 * 下次进页面直接显示，只有下拉刷新才联网 —— 这个分支有意压低对音源的请求量。
 *
 * 旧版把所有歌单放在一个对象里，打开一个也要读写全部；现在改成：
 * - `@qq_music_playlist_songs_index`：轻量索引（最多 6 个歌单）
 * - `@qq_music_playlist_songs__<id>`：每个歌单自己的歌曲
 *
 * 所有索引读改写都走同一条队列；换号用 generation 让在途请求的结果失效。
 */
const MAX_ENTRIES = 6

const warn = (message: string, error?: unknown) => {
  console.warn(`[QQMusic] playlist songs cache: ${message}`, error instanceof Error ? error.message : error ?? '')
}

let cacheGeneration = 0
let writeQueue: Promise<unknown> = Promise.resolve()
let migratePromise: Promise<void> | null = null
let orphanPruned = false

export const getPlaylistSongsCacheVersion = () => cacheGeneration

const enqueue = async<T>(task: () => Promise<T>): Promise<T> => {
  // 前一个任务失败也要继续跑下一个；任务串行，索引读改写不会交叉
  const run = (async() => {
    try {
      await writeQueue
    } catch {}
    return await task()
  })()
  writeQueue = run.then(() => {}, () => {})
  return run
}

const sortEntries = (index: QQMusicPlaylistSongsIndex) =>
  Object.entries(index).sort((a, b) => b[1].savedAt - a[1].savedAt || a[0].localeCompare(b[0]))

const trimIndex = (index: QQMusicPlaylistSongsIndex): QQMusicPlaylistSongsIndex => {
  const next: QQMusicPlaylistSongsIndex = {}
  for (const [id, entry] of sortEntries(index).slice(0, MAX_ENTRIES)) next[id] = entry
  return next
}

/** 迁移成功后每进程跑一次：清掉索引里没有的孤儿 item，修掉没有 item 的索引项 */
const runOrphanPrune = async() => {
  if (orphanPruned) return
  orphanPruned = true
  try {
    // 旧 key 还在说明迁移还没完成，别动中间产物
    const legacy = await getQQMusicPlaylistSongsCache()
    if (Object.keys(legacy).length) return
    let index: QQMusicPlaylistSongsIndex
    try {
      index = (await getQQMusicPlaylistSongsIndex()) ?? {}
    } catch (error) {
      warn('read index for prune failed', error)
      return
    }
    const itemKeys = await getQQMusicPlaylistSongsItemKeys()
    const itemKeySet = new Set(itemKeys)
    const prefix = getQQMusicPlaylistSongsItemPrefix()
    const orphans = itemKeys.filter(key => index[key.slice(prefix.length)] == null)
    if (orphans.length) await removeQQMusicPlaylistSongsItems(orphans).catch(error => { warn('remove orphan items failed', error) })

    let changed = false
    for (const id of Object.keys(index)) {
      if (!itemKeySet.has(getQQMusicPlaylistSongsItemKey(id))) {
        delete index[id]
        changed = true
      }
    }
    if (changed) await saveQQMusicPlaylistSongsIndex(index).catch(error => { warn('repair index failed', error) })
  } catch (error) {
    warn('prune failed', error)
  }
}

/** 旧单 key → 新索引/独立 key。失败保留旧 key，下次重试 */
const migrate = async() => {
  const version = cacheGeneration
  let legacy: Record<string, { songs: LX.Music.MusicInfoOnline[], savedAt: number }>
  try {
    legacy = await getQQMusicPlaylistSongsCache()
  } catch (error) {
    warn('read legacy cache failed', error)
    return
  }
  const entries = Object.entries(legacy).filter(([, value]) => Array.isArray(value?.songs))
  if (!entries.length) {
    await removeQQMusicPlaylistSongsCache().catch(error => { warn('remove empty legacy failed', error) })
    await runOrphanPrune()
    return
  }

  let index: QQMusicPlaylistSongsIndex
  try {
    index = (await getQQMusicPlaylistSongsIndex()) ?? {}
  } catch (error) {
    warn('read index for migration failed', error)
    return
  }
  entries.sort((a, b) => b[1].savedAt - a[1].savedAt)
  for (const [id, entry] of entries.slice(0, MAX_ENTRIES)) {
    if (version !== cacheGeneration) return
    const existing = index[id]
    if (existing && existing.savedAt >= entry.savedAt) continue
    try {
      await saveQQMusicPlaylistSongsItem(id, { savedAt: entry.savedAt, songs: entry.songs })
      index[id] = { savedAt: entry.savedAt, count: entry.songs.length }
    } catch (error) {
      // 不删旧 key，下次打开还会重试
      warn('write migrated item failed', error)
      return
    }
  }
  if (version !== cacheGeneration) return
  try {
    await saveQQMusicPlaylistSongsIndex(trimIndex(index))
  } catch (error) {
    warn('write migrated index failed', error)
    return
  }
  if (version !== cacheGeneration) return
  await removeQQMusicPlaylistSongsCache().catch(error => { warn('remove legacy failed', error) })
  await runOrphanPrune()
}

const ensureMigrated = async() => {
  if (migratePromise) return migratePromise
  migratePromise = enqueue(migrate).catch(error => {
    migratePromise = null
    throw error
  })
  return migratePromise
}

export const getCachedPlaylistSongs = async(id: string): Promise<LX.Music.MusicInfoOnline[] | null> => {
  const version = cacheGeneration
  try {
    await ensureMigrated()
  } catch (error) {
    // 迁移失败时退回旧 key，尽量不丢离线缓存
    const legacy = await getQQMusicPlaylistSongsCache().catch(
      (): Record<string, { songs: LX.Music.MusicInfoOnline[], savedAt: number }> => ({}),
    )
    return legacy[id]?.songs ?? null
  }
  if (version !== cacheGeneration) return null

  let index: QQMusicPlaylistSongsIndex | null
  try {
    index = await getQQMusicPlaylistSongsIndex()
  } catch (error) {
    warn('read index failed', error)
    return null
  }
  const entry = index?.[id]
  if (!entry) return null

  let item: QQMusicPlaylistSongsItem | null = null
  try {
    item = await getQQMusicPlaylistSongsItem(id)
  } catch (error) {
    warn('read item failed', error)
  }
  if (version !== cacheGeneration) return null
  if (!item || !Array.isArray(item.songs)) {
    // 索引有、数据丢失/损坏：异步修索引，按 savedAt CAS，避免删掉刚写入的新条目
    void enqueue(async() => {
      const current = await getQQMusicPlaylistSongsIndex().catch(() => null)
      if (!current?.[id] || current[id].savedAt !== entry.savedAt) return
      delete current[id]
      await saveQQMusicPlaylistSongsIndex(current)
    }).catch(error => { warn('repair missing item failed', error) })
    return null
  }

  const songs = item.songs
  // 访问 LRU：不阻塞页面，只更新小索引
  void enqueue(async() => {
    const current = await getQQMusicPlaylistSongsIndex().catch(() => null)
    if (!current?.[id]) return
    current[id].savedAt = Date.now()
    current[id].count = songs.length
    await saveQQMusicPlaylistSongsIndex(current)
  }).catch(error => { warn('touch index failed', error) })
  return songs
}

export const cachePlaylistSongs = async(id: string, songs: LX.Music.MusicInfoOnline[], version = cacheGeneration) => {
  if (version !== cacheGeneration) return
  try {
    await ensureMigrated()
  } catch (error) {
    warn('migration failed before cache', error)
  }
  if (version !== cacheGeneration) return

  try {
    await enqueue(async() => {
      if (version !== cacheGeneration) return
      const savedAt = Date.now()
      // 数据先写：索引指向的内容一定已经存在
      await saveQQMusicPlaylistSongsItem(id, { savedAt, songs })
      if (version !== cacheGeneration) {
        // 写盘期间换号了：把刚写的旧账号数据清掉
        await removeQQMusicPlaylistSongsItem(id).catch(() => {})
        return
      }

      let index: QQMusicPlaylistSongsIndex
      try {
        index = (await getQQMusicPlaylistSongsIndex()) ?? {}
      } catch (error) {
        // 读不到索引就不要用空对象覆盖，item 留给孤儿剪枝
        warn('read index before cache failed', error)
        return
      }
      index[id] = { savedAt, count: songs.length }
      const sorted = sortEntries(index)
      const evicted = sorted.slice(MAX_ENTRIES).map(([evictedId]) => evictedId)
      const next: QQMusicPlaylistSongsIndex = {}
      for (const [key, value] of sorted.slice(0, MAX_ENTRIES)) next[key] = value
      await saveQQMusicPlaylistSongsIndex(next)
      if (evicted.length) {
        await Promise.all(evicted.map(async evictedId => {
          await removeQQMusicPlaylistSongsItem(evictedId).catch(error => { warn(`remove evicted ${evictedId} failed`, error) })
        }))
      }
    })
  } catch (error) {
    // 写缓存失败不阻塞页面，下次打开会重新联网
    warn('cache failed', error)
  }
}

/** 往歌单里加/删歌之后调用，别让界面再拿旧的列表 */
export const dropCachedPlaylistSongs = async(id: string, version = cacheGeneration) => {
  if (version !== cacheGeneration) return
  try {
    await ensureMigrated()
  } catch (error) {
    warn('migration failed before drop', error)
  }
  if (version !== cacheGeneration) return

  try {
    await enqueue(async() => {
      if (version !== cacheGeneration) return
      // 先让索引 miss，再删数据
      try {
        const index = await getQQMusicPlaylistSongsIndex()
        if (index?.[id]) {
          delete index[id]
          await saveQQMusicPlaylistSongsIndex(index)
        }
      } catch (error) {
        warn('drop index failed', error)
      }
      await removeQQMusicPlaylistSongsItem(id).catch(error => { warn('drop item failed', error) })
    })
  } catch (error) {
    warn('drop failed', error)
  }
}

/** 换号时清掉，否则新号会看到上一个号的歌单内容 */
export const clearPlaylistSongsCache = async() => {
  // 同步递增：正在网络上的旧请求返回后会因为这个版本不符而不写回
  cacheGeneration++
  try {
    await enqueue(async() => {
      // 旧 key 和索引一批删掉，避免清理中途崩溃后旧数据又被迁移
      await removeQQMusicPlaylistSongsIndexAndLegacy().catch(error => { warn('remove index/legacy failed', error) })
      const itemKeys = await getQQMusicPlaylistSongsItemKeys().catch(() => [])
      if (itemKeys.length) await removeQQMusicPlaylistSongsItems(itemKeys).catch(error => { warn('remove items failed', error) })
    })
  } catch (error) {
    warn('clear failed', error)
  }
}
