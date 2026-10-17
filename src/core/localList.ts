import { LIST_IDS } from '@/config/constant'
import { allMusicList, getListMusics } from '@/utils/listManage'
import { ensureLocalMatchIndex, getCurrentLocalMatchIndex, patchLocalMatchIndexRow } from '@/utils/localMatchIndex'
import { isPlayQueueFromList } from '@/core/player/playQueue'
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
  if (playerState.playInfo.playerListId === LIST_IDS.LOCAL) return true
  if (playerState.playMusicInfo.listId === LIST_IDS.LOCAL) return true
  // 从本地列表建的播放队列：切歌要靠同步 getList(LOCAL) 取列表
  if (isPlayQueueFromList(LIST_IDS.LOCAL)) return true
  // 启动恢复还没走完时也不能释放
  if (global.lx.restorePlayInfo?.listId === LIST_IDS.LOCAL) return true
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
  return getListMusics(LIST_IDS.LOCAL)
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
  // 从 LOCAL 队列切走后没有后续本地操作，也要能把整表释放掉
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

  const list = allMusicList.get(LIST_IDS.LOCAL)
  if (!list) return
  const item = list.find(item => item.id === filePath)
  if (!item) return
  if (patch.picUrl !== undefined) item.meta.picUrl = patch.picUrl
  // 传列表里的真实条目，保留 toggleMusicInfo 等索引里没有的字段
  await global.list_event.list_music_update([{ id: LIST_IDS.LOCAL, musicInfo: item }])
}
