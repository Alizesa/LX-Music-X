import { LIST_IDS } from '@/config/constant'
import { allMusicList, getListMusics } from '@/utils/listManage'
import { ensureLocalMatchIndex, getCurrentLocalMatchIndex, patchLocalMatchIndexRow } from '@/utils/localMatchIndex'
import playerState from '@/store/player/state'

/**
 * 完整 LOCAL 列表（`@list__local`）的生命周期。
 *
 * 启动只加载匹配索引后，完整列表只在需要时加载：
 * 打开本地歌曲页、从 LOCAL 列表播放、以及列表增删改时。
 * 用引用计数管理占用，没有占用且没在播放时延迟释放，避免连续操作反复读盘。
 */

const holds = new Map<string, number>()
let releaseTimer: ReturnType<typeof setTimeout> | null = null
// 合并连续下载完成这类操作，避免每首之间都丢一次缓存
const RELEASE_DELAY = 3000
let initialized = false

export const isLocalListInUse = () => {
  // 旧数据/非队列链路仍可能直接以 LOCAL 作为当前列表
  if (playerState.playInfo.playerListId === LIST_IDS.LOCAL) return true
  if (playerState.playMusicInfo.listId === LIST_IDS.LOCAL) return true
  // 启动恢复还没走完时也不能释放
  if (global.lx.restorePlayInfo?.listId === LIST_IDS.LOCAL) return true
  // 注意：不要因为播放队列的 sourceListId 是 LOCAL 就钉住。
  // 队列里的歌已经持有自己的对象，切歌走 getList(PLAY_QUEUE)，
  // 不需要同步读整份 LOCAL；钉住会让「播过本地」变成整场常驻。
  return false
}

const canRelease = () => holds.size === 0 && !isLocalListInUse()

export const maybeRelease = () => {
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  if (!canRelease()) return
  releaseTimer = setTimeout(() => {
    releaseTimer = null
    if (canRelease()) allMusicList.delete(LIST_IDS.LOCAL)
  }, RELEASE_DELAY)
}

/** 占用完整列表并确保已加载。调用方必须配对 releaseLocalList */
export const retainLocalList = async(reason: string, load = true): Promise<LX.Music.MusicInfo[]> => {
  holds.set(reason, (holds.get(reason) ?? 0) + 1)
  if (!load) return allMusicList.get(LIST_IDS.LOCAL) ?? []
  try {
    return await getListMusics(LIST_IDS.LOCAL)
  } catch (error) {
    // 加载失败要回滚占用，否则这个 reason 永远配不上 release，整表再也释放不了
    releaseLocalList(reason)
    throw error
  }
}

export const releaseLocalList = (reason: string) => {
  const count = holds.get(reason)
  if (count == null) return
  if (count > 1) holds.set(reason, count - 1)
  else holds.delete(reason)
  maybeRelease()
}

export const withLocalList = async<T>(
  reason: string,
  fn: (list: LX.Music.MusicInfo[]) => Promise<T>,
  load = true,
): Promise<T> => {
  const list = await retainLocalList(reason, load)
  try {
    return await fn(list)
  } finally {
    releaseLocalList(reason)
  }
}

export const initLocalListLifecycle = () => {
  if (initialized) return
  initialized = true
  // 队列变化时再检查一次释放条件：播放状态变了，可能要放掉整表
  global.app_event.on('playQueueUpdate', () => { maybeRelease() })
}

/**
 * 只更新本地条目的白名单字段（目前只有封面）。
 *
 * 匹配索引返回的是重建对象，不能整对象写回列表 —— `listMusicUpdateInfo` 会用传入的
 * `meta` 覆盖原条目，把下载歌曲的 `toggleMusicInfo` 丢掉。
 */
export const patchLocalMusicMeta = async(filePath: string, patch: { picUrl?: string | null }) => {
  const index = getCurrentLocalMatchIndex() ?? await ensureLocalMatchIndex()
  if (index) patchLocalMatchIndexRow(index, filePath, patch)

  // 已加载时同步改内存里的条目，界面立即拿到新封面。
  // 不触发 list_music_update：那会把整份 LOCAL 写盘并全量重建索引，
  // 为一个封面字段不值得；持久化由索引的延迟写负责，下次加载时 overlay 回来
  const list = allMusicList.get(LIST_IDS.LOCAL)
  if (!list || patch.picUrl === undefined) return
  const item = list.find(item => item.id === filePath)
  if (item) item.meta.picUrl = patch.picUrl
}
