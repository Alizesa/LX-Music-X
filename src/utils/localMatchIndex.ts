import { getData, removeData, saveData } from '@/plugins/storage'
import { LIST_IDS, storageDataPrefix } from '@/config/constant'
import { getListMusics as getListMusicsFromStore } from './data'
import { log } from './log'

/**
 * 本地音乐匹配索引。
 *
 * 完整 LOCAL 列表（`@list__local`）可能很大，启动时整份读进内存是主要的内存来源。
 * 这里维护一份精简的派生索引：只保留匹配和重建播放所需的最小字段，
 * 启动只读它；完整列表按需加载（见 core/localList）。
 *
 * 索引是派生缓存，`@list__local` 仍是唯一数据源，任何异常都可以重建。
 */

export const LOCAL_MATCH_INDEX_VERSION = 1

/**
 * 紧凑元组，顺序不能改。字段：
 * id/path、name、singer、albumName、interval、ext、picUrl、toggleKey、
 * fingerprint（归一化 name/singer/album）、durationSec
 *
 * 不存 `source`（恒为 local）、`meta.filePath/songId`（都等于 id）、
 * 完整 `meta.toggleMusicInfo`（匹配只需要 source + id）。
 */
export type LocalIndexRow = [
  id: string,
  name: string,
  singer: string,
  albumName: string,
  interval: string | null,
  ext: string,
  picUrl: string | null,
  toggleKey: string | null,
  fingerprint: string,
  durationSec: number | null,
]

export interface LocalMatchIndex {
  rows: LocalIndexRow[]
  /** LOCAL 列表总长度（含非 local 条目的防御性计数），「我的」页数量用 */
  listCount: number
  /** toggleKey -> 第一条匹配行 */
  byToggle: Map<string, number>
  /** fingerprint -> 按列表顺序排列的行下标 */
  byFingerprint: Map<string, number[]>
  /** id/path -> 第一条匹配行 */
  byId: Map<string, number>
}

interface StoredLocalMatchIndex {
  v: number
  listCount: number
  rows: LocalIndexRow[]
}

export const normalizeLocalMatchText = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

export const intervalToSeconds = (interval: string | null) => {
  if (!interval) return null
  const parts = interval.split(':').map(Number)
  if (parts.some(Number.isNaN)) return null
  return parts.reduce((total, value) => total * 60 + value, 0)
}

export const buildLocalToggleKey = (source: string | number, id: string | number) =>
  `${String(source)}\u0000${String(id)}`

// 长度前缀拼接，避免用分隔符时和歌名/歌手里的字符冲突。
// 任一字段归一化为空时返回 null：原实现里在线歌曲这种值直接不参与匹配。
const buildFingerprint = (name: string, singer: string, albumName: string): string | null => {
  const n = normalizeLocalMatchText(name)
  const s = normalizeLocalMatchText(singer)
  const a = normalizeLocalMatchText(albumName)
  if (!n || !s || !a) return null
  return `${n.length}:${n}${s.length}:${s}${a.length}:${a}`
}

const buildRow = (item: LX.Music.MusicInfoLocal, previous?: LocalMatchIndex): LocalIndexRow => {
  const toggle = item.meta.toggleMusicInfo
  // 索引里的封面可能比列表里的新（拿到在线封面时列表未加载，只写了索引）
  const prevRow = previous?.byId.get(item.id)
  const prevPicUrl = prevRow == null ? null : previous!.rows[prevRow][6]
  const picUrl = item.meta.picUrl == null || item.meta.picUrl === '' ? prevPicUrl : item.meta.picUrl
  return [
    item.id,
    item.name,
    item.singer,
    item.meta.albumName ?? '',
    item.interval ?? null,
    item.meta.ext ?? '',
    picUrl ?? null,
    toggle ? buildLocalToggleKey(toggle.source, toggle.id) : null,
    // 归一化后有空的本地条目永远匹配不上合法在线歌曲，空串足够
    buildFingerprint(item.name, item.singer, item.meta.albumName ?? '') ?? '',
    intervalToSeconds(item.interval),
  ]
}

const buildIndex = (rows: LocalIndexRow[], listCount: number): LocalMatchIndex => {
  const byToggle = new Map<string, number>()
  const byFingerprint = new Map<string, number[]>()
  const byId = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row[7] != null && !byToggle.has(row[7])) byToggle.set(row[7], index)
    const sameFingerprint = byFingerprint.get(row[8])
    if (sameFingerprint) sameFingerprint.push(index)
    else byFingerprint.set(row[8], [index])
    if (!byId.has(row[0])) byId.set(row[0], index)
  })
  return { rows, listCount, byToggle, byFingerprint, byId }
}

export const buildLocalMatchIndex = (list: LX.Music.MusicInfo[], previous?: LocalMatchIndex): LocalMatchIndex => {
  const rows: LocalIndexRow[] = []
  for (const item of list) {
    if (item.source !== 'local') continue
    rows.push(buildRow(item, previous))
  }
  return buildIndex(rows, list.length)
}

const isRow = (row: unknown): row is LocalIndexRow => {
  if (!Array.isArray(row) || row.length !== 10) return false
  return typeof row[0] === 'string' &&
    typeof row[1] === 'string' &&
    typeof row[2] === 'string' &&
    typeof row[3] === 'string' &&
    (row[4] == null || typeof row[4] === 'string') &&
    typeof row[5] === 'string' &&
    (row[6] == null || typeof row[6] === 'string') &&
    (row[7] == null || typeof row[7] === 'string') &&
    typeof row[8] === 'string' &&
    (row[9] == null || typeof row[9] === 'number')
}

const loadStoredIndex = async(): Promise<LocalMatchIndex | null> => {
  const data = await getData<StoredLocalMatchIndex>(storageDataPrefix.localMatchIndex)
  if (!data || data.v !== LOCAL_MATCH_INDEX_VERSION || !Number.isInteger(data.listCount) || !Array.isArray(data.rows)) return null
  if (!data.rows.every(isRow)) return null
  return buildIndex(data.rows, data.listCount)
}

let current: LocalMatchIndex | null = null
let initPromise: Promise<LocalMatchIndex | null> | null = null
let saveChain: Promise<void> = Promise.resolve()
let saveTimer: ReturnType<typeof setTimeout> | null = null

export const getCurrentLocalMatchIndex = () => current

export const saveLocalMatchIndex = async(index: LocalMatchIndex) => {
  saveChain = saveChain.catch(() => {}).then(async() => {
    await saveData(storageDataPrefix.localMatchIndex, {
      v: LOCAL_MATCH_INDEX_VERSION,
      listCount: index.listCount,
      rows: index.rows,
    } satisfies StoredLocalMatchIndex)
  })
  await saveChain
}

/** 封面这类小改动合并写盘，避免连续加载多张封面时反复序列化整份索引 */
export const scheduleSaveLocalMatchIndex = (index: LocalMatchIndex) => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveLocalMatchIndex(index).catch(error => {
      log.warn('[LocalMatchIndex] save failed: ' + (error instanceof Error ? error.message : String(error)))
    })
  }, 500)
}

export const markLocalMatchIndexDirty = async() => {
  await saveData(storageDataPrefix.localMatchIndexDirty, true)
}
export const clearLocalMatchIndexDirty = async() => {
  await removeData(storageDataPrefix.localMatchIndexDirty)
}
const isLocalMatchIndexDirty = async() =>
  (await getData<boolean>(storageDataPrefix.localMatchIndexDirty)) === true

/**
 * 确保索引已就绪。首次升级时索引不存在，会从 `@list__local` 读一次构建。
 * 并发调用共用一个 Promise；失败不缓存结果，下次调用会重试。
 */
export const ensureLocalMatchIndex = async(): Promise<LocalMatchIndex | null> => {
  if (current) return current
  initPromise ??= (async() => {
    try {
      if (!await isLocalMatchIndexDirty()) {
        const stored = await loadStoredIndex()
        if (stored) {
          current = stored
          return stored
        }
      }
      const list = await getListMusicsFromStore(LIST_IDS.LOCAL)
      const index = buildLocalMatchIndex(list)
      current = index
      await saveLocalMatchIndex(index)
      await clearLocalMatchIndexDirty()
      return index
    } catch (error) {
      log.warn('[LocalMatchIndex] init failed: ' + (error instanceof Error ? error.message : String(error)))
      return null
    } finally {
      initPromise = null
    }
  })()
  return initPromise
}

/** 列表变更后重建。dirty 由调用方在写列表前标记，保存成功后在这里清除 */
export const rebuildLocalMatchIndexFromList = async(list: LX.Music.MusicInfo[]): Promise<LocalMatchIndex> => {
  const index = buildLocalMatchIndex(list, current ?? undefined)
  current = index
  try {
    await saveLocalMatchIndex(index)
    await clearLocalMatchIndexDirty()
  } catch (error) {
    // 索引写失败不影响本次运行：内存索引已更新，dirty 留给下次启动重建
    log.warn('[LocalMatchIndex] rebuild save failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  return index
}

const isSameIndex = (a: LocalMatchIndex, b: LocalMatchIndex) => {
  if (a.listCount !== b.listCount || a.rows.length !== b.rows.length) return false
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i]
    const y = b.rows[i]
    // picUrl 不参与比较：索引里的可能比列表里的新
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2] || x[3] !== y[3] ||
      x[4] !== y[4] || x[5] !== y[5] || x[7] !== y[7] || x[8] !== y[8] || x[9] !== y[9]) return false
  }
  return true
}

/**
 * 完整 LOCAL 列表加载后调用：列表才是数据源，不一致就重建；
 * 一致则只把索引里较新的封面覆盖到列表对象上。
 */
export const syncLocalMatchIndexWithList = async(list: LX.Music.MusicInfo[]): Promise<LocalMatchIndex> => {
  const next = buildLocalMatchIndex(list, current ?? undefined)
  if (current && isSameIndex(current, next)) {
    applyLocalPicOverlay(list, current)
    return current
  }
  current = next
  try {
    await saveLocalMatchIndex(next)
  } catch (error) {
    log.warn('[LocalMatchIndex] sync save failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  return next
}

export const applyLocalPicOverlay = (list: LX.Music.MusicInfo[], index: LocalMatchIndex) => {
  for (const item of list) {
    if (item.source !== 'local') continue
    const rowIndex = index.byId.get(item.id)
    if (rowIndex == null) continue
    const picUrl = index.rows[rowIndex][6]
    if (picUrl && item.meta.picUrl !== picUrl) item.meta.picUrl = picUrl
  }
}

/** 只允许改白名单字段，避免把索引重建对象整份写回列表（会丢 toggleMusicInfo） */
export const patchLocalMatchIndexRow = (
  index: LocalMatchIndex,
  id: string,
  patch: { picUrl?: string | null },
) => {
  const rowIndex = index.byId.get(id)
  if (rowIndex == null) return false
  if (patch.picUrl !== undefined) index.rows[rowIndex][6] = patch.picUrl
  scheduleSaveLocalMatchIndex(index)
  return true
}

export const getLocalMusicCount = async() => (await ensureLocalMatchIndex())?.listCount ?? 0

/**
 * 匹配顺序严格对齐原 `findLocalMusicInfo`：
 * 先 toggle id+source 精确命中；再归一化名称/歌手/专辑完全相等 + 时长 ±3 秒；
 * 多候选「已关联在线来源」优先，其次时长差更小，完全并列保留先出现者。
 */
export const findLocalMatchRow = (index: LocalMatchIndex, musicInfo: LX.Music.MusicInfoOnline) => {
  const toggleKey = buildLocalToggleKey(musicInfo.source, musicInfo.id)
  const byToggleIndex = index.byToggle.get(toggleKey)
  if (byToggleIndex != null) return index.rows[byToggleIndex]

  if (!musicInfo.name || !musicInfo.singer || !musicInfo.meta.albumName || !musicInfo.interval) return undefined
  const fingerprint = buildFingerprint(musicInfo.name, musicInfo.singer, musicInfo.meta.albumName)
  if (!fingerprint) return undefined
  const duration = intervalToSeconds(musicInfo.interval)
  if (duration == null) return undefined
  const candidates = index.byFingerprint.get(fingerprint)
  if (!candidates) return undefined

  let best: LocalIndexRow | undefined
  let bestGap = 0
  let bestLinked = false
  for (const rowIndex of candidates) {
    const row = index.rows[rowIndex]
    if (row[9] == null) continue
    const gap = Math.abs(row[9] - duration)
    if (gap > 3) continue
    const linked = row[7] != null
    if (best == null) {
      best = row
      bestGap = gap
      bestLinked = linked
      continue
    }
    if (linked !== bestLinked) {
      if (linked) {
        best = row
        bestGap = gap
        bestLinked = linked
      }
    } else if (gap < bestGap) {
      best = row
      bestGap = gap
      bestLinked = linked
    }
  }
  return best
}

export const localIndexRowToMusicInfo = (row: LocalIndexRow): LX.Music.MusicInfoLocal => ({
  id: row[0],
  name: row[1],
  singer: row[2],
  source: 'local',
  interval: row[4],
  meta: {
    albumName: row[3],
    filePath: row[0],
    songId: row[0],
    picUrl: row[6],
    ext: row[5],
  },
})
