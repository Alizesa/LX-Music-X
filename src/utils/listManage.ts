import {
  getUserLists as getUserListsFromStore,
  getListMusics as getListMusicsFromStore,
  // saveListMusics as saveListMusicsFromStore,
  // removeListMusics as removeListMusicsFromStore,
  overwriteListPosition,
  overwriteListUpdateInfo,
  removeListPosition,
  removeListUpdateInfo,
} from '@/utils/data'
import { arrPush, arrPushByPosition, arrUnshift } from '@/utils/common'
import { syncLocalMatchIndexWithList } from '@/utils/localMatchIndex'
import { LIST_IDS } from '@/config/constant'
import playerState from '@/store/player/state'

export const userLists: LX.List.UserListInfo[] = []
export const allMusicList = new Map<string, LX.Music.MusicInfo[]>()

// 用户列表缓存也是整份歌曲数组。没有上限时，备份导出/歌单同步碰过的列表会一直留着；
// 这里按最近访问淘汰（LOCAL/TEMP/当前播放列表不参与）。
const USER_LIST_CACHE_MAX = 2
const USER_LIST_CACHE_MAX_SONGS = 3000
// Map 保持插入顺序：访问时删了再塞，淘汰从头部拿最久没用的
const listAccessOrder = new Map<string, true>()
let listCachePruneTimer: ReturnType<typeof setTimeout> | null = null

const isListCacheProtected = (id: string) =>
  id === LIST_IDS.LOCAL ||
  id === LIST_IDS.TEMP ||
  id === playerState.playInfo.playerListId ||
  id === playerState.playMusicInfo.listId

const touchListCache = (id: string) => {
  if (!allMusicList.has(id)) return
  listAccessOrder.delete(id)
  listAccessOrder.set(id, true)
}

const pruneListCache = () => {
  // 只统计可淘汰的列表；保护的列表不触发淘汰，也不被淘汰
  const ids = [...listAccessOrder.keys()].filter(id => allMusicList.has(id) && !isListCacheProtected(id))
  if (!ids.length) return
  let count = ids.length
  let totalSongs = ids.reduce((sum, id) => sum + (allMusicList.get(id)?.length ?? 0), 0)
  if (count <= USER_LIST_CACHE_MAX && totalSongs <= USER_LIST_CACHE_MAX_SONGS) return

  // 最近访问的那个留着，否则一个超大列表会刚加载完就被自己挤掉
  const newest = ids[ids.length - 1]
  for (const id of ids) {
    if (count <= USER_LIST_CACHE_MAX && totalSongs <= USER_LIST_CACHE_MAX_SONGS) break
    if (id === newest) continue
    totalSongs -= allMusicList.get(id)?.length ?? 0
    allMusicList.delete(id)
    listAccessOrder.delete(id)
    count--
  }
}

// 延迟一点再淘汰：避免在某个列表的增删改还没走完时就把它的缓存删掉
const schedulePruneListCache = () => {
  if (listCachePruneTimer) return
  listCachePruneTimer = setTimeout(() => {
    listCachePruneTimer = null
    pruneListCache()
  }, 3000)
}

export const setUserLists = (lists: LX.List.UserListInfo[]) => {
  userLists.splice(0, userLists.length, ...lists)
  return userLists
}

export const setMusicList = (listId: string, musicList: LX.Music.MusicInfo[]): LX.Music.MusicInfo[] => {
  allMusicList.set(listId, musicList)
  touchListCache(listId)
  if (!isListCacheProtected(listId)) schedulePruneListCache()
  return musicList
}
export const removeMusicList = (id: string) => {
  allMusicList.delete(id)
  listAccessOrder.delete(id)
}


const createUserList = ({
  name,
  id,
  source,
  sourceListId,
  locationUpdateTime,
}: LX.List.UserListInfo, position: number) => {
  if (position < 0 || position >= userLists.length) {
    userLists.push({
      name,
      id,
      source,
      sourceListId,
      locationUpdateTime,
    })
  } else {
    userLists.splice(position, 0, {
      name,
      id,
      source,
      sourceListId,
      locationUpdateTime,
    })
  }
}

const updateList = ({
  name,
  id,
  source,
  sourceListId,
  // meta,
  locationUpdateTime,
}: LX.List.UserListInfo & { meta?: { id?: string } }) => {
  let index
  switch (id) {
    case LIST_IDS.TEMP:
    //   tempList.meta = meta ?? {}
      // break
    default:
      index = userLists.findIndex(l => l.id == id)
      if (index < 0) return
      userLists.splice(index, 1, { ...userLists[index], name, source, sourceListId, locationUpdateTime })
      break
  }
}

const removeUserList = (id: string) => {
  const index = userLists.findIndex(l => l.id == id)
  if (index < 0) return
  userLists.splice(index, 1)
  // removeMusicList(id)
}

const overwriteUserList = (lists: LX.List.UserListInfo[]) => {
  userLists.splice(0, userLists.length, ...lists)
}


// const sendMyListUpdateEvent = (ids: string[]) => {
//   window.app_event.myListUpdate(ids)
// }

/**
 * 获取用户列表
 * @returns 所有用户列表
 */
export const getUserLists = async() => {
  const lists = await getUserListsFromStore()
  return setUserLists(lists)
}


export const listDataOverwrite = ({ localList, userList, tempList }: MakeOptional<LX.List.ListDataFull, 'tempList'>): string[] => {
  const updatedListIds: string[] = []
  const newUserIds: string[] = []
  const newUserListInfos = userList.map(({ list, ...listInfo }) => {
    if (allMusicList.has(listInfo.id)) updatedListIds.push(listInfo.id)
    newUserIds.push(listInfo.id)
    setMusicList(listInfo.id, list)
    return listInfo
  })
  for (const list of userLists) {
    if (!allMusicList.has(list.id) || newUserIds.includes(list.id)) continue
    removeMusicList(list.id)
    updatedListIds.push(list.id)
  }
  overwriteUserList(newUserListInfos)

  // Older backups and sync payloads do not contain localList. Keep local files
  // managed on this device unless the sender explicitly provides the list.
  // 注意：LOCAL 现在是延迟加载的，「没加载」不能当成「空列表」写盘。
  // 只有显式传入（包括空数组）才替换；否则保持现状，未加载就完全不碰。
  if (Array.isArray(localList)) {
    setMusicList(LIST_IDS.LOCAL, localList)
    updatedListIds.push(LIST_IDS.LOCAL)
  }

  if (tempList && allMusicList.has(LIST_IDS.TEMP)) {
    setMusicList(LIST_IDS.TEMP, tempList)
    updatedListIds.push(LIST_IDS.TEMP)
  }
  const newIds = [LIST_IDS.LOCAL, ...userList.map(l => l.id)]
  if (tempList) newIds.push(LIST_IDS.TEMP)
  void overwriteListPosition(newIds)
  void overwriteListUpdateInfo(newIds)
  return updatedListIds
}

export const userListCreate = ({ name, id, source, sourceListId, position, locationUpdateTime }: {
  name: string
  id: string
  source?: LX.OnlineSource
  sourceListId?: string
  position: number
  locationUpdateTime: number | null
}) => {
  if (userLists.some(item => item.id == id)) return
  const newList: LX.List.UserListInfo = {
    name,
    id,
    source,
    sourceListId,
    locationUpdateTime,
  }
  createUserList(newList, position)
}

export const userListsRemove = (ids: string[]) => {
  const changedIds = []
  for (const id of ids) {
    removeUserList(id)
    if (!allMusicList.has(id)) continue
    removeMusicList(id)
    void removeListPosition(id)
    void removeListUpdateInfo(id)
    changedIds.push(id)
  }

  return changedIds
}

export const userListsUpdate = (listInfos: LX.List.UserListInfo[]) => {
  for (const info of listInfos) {
    updateList(info)
  }
}

export const userListsUpdatePosition = (position: number, ids: string[]) => {
  const newUserLists = [...userLists]

  // console.log(position, ids)

  const updateLists: LX.List.UserListInfo[] = []

  // const targetItem = list[position]
  const map = new Map<string, LX.List.UserListInfo>()
  for (const item of newUserLists) map.set(item.id, item)
  for (const id of ids) {
    const listInfo = map.get(id)!
    listInfo.locationUpdateTime = Date.now()
    updateLists.push(listInfo)
    map.delete(id)
  }
  newUserLists.splice(0, newUserLists.length, ...newUserLists.filter(mInfo => map.has(mInfo.id)))
  newUserLists.splice(Math.min(position, newUserLists.length), 0, ...updateLists)

  setUserLists(newUserLists)
}

export const getListMusicSync = (id: string | null) => {
  return id ? allMusicList.get(id) ?? [] : []
}

/**
 * 获取列表内的歌曲
 * @param listId
 */
// 同一列表的并发加载共用一个 Promise。LOCAL 延迟加载后，两首下载几乎同时完成时
// 会并发调用 getListMusics(LOCAL)；各读各的旧快照再各自覆盖内存/存储会丢掉其中一首
const loadingListPromises = new Map<string, Promise<LX.Music.MusicInfo[]>>()

export const getListMusics = async(listId: string): Promise<LX.Music.MusicInfo[]> => {
  if (!listId) return []
  const cached = allMusicList.get(listId)
  if (cached) {
    touchListCache(listId)
    return cached
  }

  let promise = loadingListPromises.get(listId)
  if (!promise) {
    promise = (async() => {
      const list = await getListMusicsFromStore(listId)
      setMusicList(listId, list)
      // 完整列表才是数据源：加载时校对/重建匹配索引，并把索引里较新的封面覆盖回来
      if (listId === LIST_IDS.LOCAL) await syncLocalMatchIndexWithList(list)
      return list
    })().finally(() => {
      loadingListPromises.delete(listId)
    })
    loadingListPromises.set(listId, promise)
  }
  return promise
}

export const listMusicOverwrite = async(listId: string, musicInfos: LX.Music.MusicInfo[]): Promise<string[]> => {
  setMusicList(listId, musicInfos)
  return [listId]
}

export const listMusicAdd = async(id: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType): Promise<string[]> => {
  const targetList = await getListMusics(id)

  const listSet = new Set<string>()
  for (const item of targetList) listSet.add(item.id)
  musicInfos = musicInfos.filter(item => {
    if (listSet.has(item.id)) return false
    listSet.add(item.id)
    return true
  })
  switch (addMusicLocationType) {
    case 'top':
      arrUnshift(targetList, musicInfos)
      break
    case 'bottom':
    default:
      arrPush(targetList, musicInfos)
      break
  }

  setMusicList(id, targetList)

  return [id]
}

export const listMusicRemove = async(listId: string, ids: string[]): Promise<string[]> => {
  let targetList = await getListMusics(listId)

  const listSet = new Set<string>()
  for (const item of targetList) listSet.add(item.id)
  for (const id of ids) listSet.delete(id)
  const newList = targetList.filter(mInfo => listSet.has(mInfo.id))
  targetList.splice(0, targetList.length)
  arrPush(targetList, newList)

  return [listId]
}

export const listMusicMove = async(fromId: string, toId: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType): Promise<string[]> => {
  return [
    ...await listMusicRemove(fromId, musicInfos.map(musicInfo => musicInfo.id)),
    ...await listMusicAdd(toId, musicInfos, addMusicLocationType),
  ]
}

export const listMusicUpdateInfo = async(musicInfos: LX.List.ListActionMusicUpdate): Promise<string[]> => {
  const updateListIds = new Set<string>()
  for (const { id, musicInfo } of musicInfos) {
    const targetList = await getListMusics(id)
    if (!targetList.length) continue
    const index = targetList.findIndex(l => l.id == musicInfo.id)
    if (index < 0) continue
    const info: LX.Music.MusicInfo = { ...targetList[index] }
    Object.assign(info, {
      name: musicInfo.name,
      singer: musicInfo.singer,
      source: musicInfo.source,
      interval: musicInfo.interval,
      meta: musicInfo.meta,
    })
    targetList.splice(index, 1, info)
    updateListIds.add(id)
  }
  return Array.from(updateListIds)
}


export const listMusicUpdatePosition = async(listId: string, position: number, ids: string[]): Promise<string[]> => {
  let targetList = await getListMusics(listId)

  // const infos = Array(ids.length)
  // for (let i = targetList.length; i--;) {
  //   const item = targetList[i]
  //   const index = ids.indexOf(item.id)
  //   if (index < 0) continue
  //   infos.splice(index, 1, targetList.splice(i, 1)[0])
  // }
  // targetList.splice(Math.min(position, targetList.length - 1), 0, ...infos)

  // console.time('ts')

  // const list = createSortedList(targetList, position, ids)
  const infos: LX.Music.MusicInfo[] = []
  const map = new Map<string, LX.Music.MusicInfo>()
  for (const item of targetList) map.set(item.id, item)
  for (const id of ids) {
    infos.push(map.get(id)!)
    map.delete(id)
  }
  const list = targetList.filter(mInfo => map.has(mInfo.id))
  arrPushByPosition(list, infos, Math.min(position, list.length))

  targetList.splice(0, targetList.length)
  arrPush(targetList, list)

  // console.timeEnd('ts')
  return [listId]
}


export const listMusicClear = async(ids: string[]): Promise<string[]> => {
  const changedIds: string[] = []
  for (const id of ids) {
    const list = await getListMusics(id)
    if (!list.length) continue
    setMusicList(id, [])
    changedIds.push(id)
  }
  return changedIds
}
