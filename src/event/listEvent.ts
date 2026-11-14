import Event from './Event'

import { saveUserList, removeListMusics, saveListMusics } from '@/utils/data'
import { markLocalMatchIndexDirty, rebuildLocalMatchIndexFromList } from '@/utils/localMatchIndex'
import {
  userLists,
  userListCreate,
  userListsUpdate,
  userListsRemove,
  userListsUpdatePosition,
  listDataOverwrite,
  listMusicOverwrite,
  listMusicAdd,
  listMusicMove,
  listMusicRemove,
  listMusicUpdateInfo,
  listMusicUpdatePosition,
  listMusicClear,
  allMusicList,
  withListCacheProtection,
} from '@/utils/listManage'
import { LIST_IDS } from '@/config/constant'
import { setUserList } from '@/core/list'

const updateUserList = async(userLists: LX.List.UserListInfo[]) => {
  const snapshot = [...userLists]
  await saveUserList(snapshot)
  setUserList(snapshot)
}

// 导入、移动和普通编辑共用提交顺序，避免较早的保存覆盖后续修改。
let operationQueue: Promise<void> = Promise.resolve()
const runListOperation = async<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> => {
  const result = operationQueue.then(async() => withListCacheProtection(ids, work))
  operationQueue = result.then(() => {}, () => {})
  return result
}

export const checkUpdateList = async(changedIds: string[]) => withListCacheProtection(changedIds, async() => {
  if (!changedIds.length) return
  const snapshots = changedIds.map(id => {
    const musics = allMusicList.get(id)
    if (!musics) throw new Error(`Missing modified list: ${id}`)
    return { id, musics }
  })
  const includesLocal = changedIds.includes(LIST_IDS.LOCAL)
  // 先标 dirty：列表写成功、索引没写就崩溃时，下次启动会重建
  if (includesLocal) await markLocalMatchIndexDirty()
  for (const snapshot of snapshots) await saveListMusics([snapshot])
  if (includesLocal) {
    await rebuildLocalMatchIndexFromList(snapshots.find(list => list.id === LIST_IDS.LOCAL)!.musics)
  }
  global.app_event.myListMusicUpdate(changedIds)
})
const fixListIdType = (lists: LX.List.UserListInfo[] | LX.List.UserListInfoFull[]) => {
  for (const list of lists) {
    if (typeof list.sourceListId == 'number') {
      list.sourceListId = String(list.sourceListId)
      if (typeof list.id == 'number') {
        list.id = String(list.id)
      }
    }
  }
}

export class ListEvent extends Event {
  /**
   * 现有歌曲列表更改时触发的事件
   * @param ids
   */
  /**
   * 覆盖整个列表数据
   * @param listData 列表数据
   * @param isRemote 是否属于远程操作
   */
  async list_data_overwrite(listData: MakeOptional<LX.List.ListDataFull, 'tempList'>, isRemote: boolean = false) {
    fixListIdType(listData.userList)
    const snapshots = listData.userList.map(({ id, list }) => ({ id, musics: list }))
    if (Array.isArray(listData.localList)) snapshots.push({ id: LIST_IDS.LOCAL, musics: listData.localList })
    if (Array.isArray(listData.tempList)) snapshots.push({ id: LIST_IDS.TEMP, musics: listData.tempList })
    await runListOperation(snapshots.map(list => list.id), async() => {
      const newIds = new Set(listData.userList.map(list => list.id))
      const removedIds = userLists.map(list => list.id).filter(id => !newIds.has(id))
      const changedIds = listDataOverwrite(listData)
      if (Array.isArray(listData.localList)) await markLocalMatchIndexDirty()
      // 只保存输入中的快照；缓存淘汰和未加载的 LOCAL 都不影响持久化内容。
      for (const snapshot of snapshots) await saveListMusics([snapshot])
      await updateUserList(userLists)
      if (removedIds.length) await removeListMusics(removedIds)
      if (Array.isArray(listData.localList)) await rebuildLocalMatchIndexFromList(listData.localList)
      global.app_event.myListMusicUpdate(changedIds)
      this.emit('list_data_overwrite', listData, isRemote)
    })
  }

  /**
   * 批量创建列表
   * @param position 列表位置
   * @param lists 列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_create(position: number, lists: LX.List.UserListInfo[], isRemote: boolean = false) {
    await runListOperation([], async() => {
      fixListIdType(lists)
      for (const list of lists) userListCreate({ ...list, position })
      await updateUserList(userLists)
      this.emit('list_create', position, lists, isRemote)
    })
  }

  /**
   * 批量删除列表及列表内歌曲
   * @param ids 列表ids
   * @param isRemote 是否属于远程操作
   */
  async list_remove(ids: string[], isRemote: boolean = false) {
    await runListOperation(ids, async() => {
      const changedIds = userListsRemove(ids)
      await updateUserList(userLists)
      await removeListMusics(ids)
      this.emit('list_remove', ids, isRemote)
      global.app_event.myListMusicUpdate(changedIds)
    })
  }

  /**
   * 批量更新列表信息
   * @param lists 列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_update(lists: LX.List.UserListInfo[], isRemote: boolean = false) {
    await runListOperation([], async() => {
      userListsUpdate(lists)
      await updateUserList(userLists)
      this.emit('list_update', lists, isRemote)
    })
  }

  /**
   * 批量更新列表位置
   * @param position 列表位置
   * @param ids 列表ids
   * @param isRemote 是否属于远程操作
   */
  async list_update_position(position: number, ids: string[], isRemote: boolean = false) {
    await runListOperation([], async() => {
      userListsUpdatePosition(position, ids)
      await updateUserList(userLists)
      this.emit('list_update_position', position, ids, isRemote)
    })
  }

  /**
   * 覆盖列表内歌曲
   * @param listId 列表id
   * @param musicInfos 音乐信息
   * @param isRemote 是否属于远程操作
   */
  async list_music_overwrite(listId: string, musicInfos: LX.Music.MusicInfo[], isRemote: boolean = false) {
    await runListOperation([listId], async() => {
      const changedIds = await listMusicOverwrite(listId, musicInfos)
      await checkUpdateList(changedIds)
      this.emit('list_music_overwrite', listId, musicInfos, isRemote)
    })
  }

  /**
   * 批量添加歌曲到列表
   * @param listId 列表id
   * @param musicInfos 添加的歌曲信息
   * @param addMusicLocationType 添加在到列表的位置
   * @param isRemote 是否属于远程操作
   */
  async list_music_add(listId: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType, isRemote: boolean = false) {
    await runListOperation([listId], async() => {
      const changedIds = await listMusicAdd(listId, musicInfos, addMusicLocationType)
      await checkUpdateList(changedIds)
      this.emit('list_music_add', listId, musicInfos, addMusicLocationType, isRemote)
    })
  }

  /**
   * 批量移动歌曲
   * @param fromId 源列表id
   * @param toId 目标列表id
   * @param musicInfos 移动的歌曲信息
   * @param addMusicLocationType 添加在到列表的位置
   * @param isRemote 是否属于远程操作
   */
  async list_music_move(fromId: string, toId: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType, isRemote: boolean = false) {
    await runListOperation([fromId, toId], async() => {
      const changedIds = await listMusicMove(fromId, toId, musicInfos, addMusicLocationType)
      await checkUpdateList(changedIds)
      this.emit('list_music_move', fromId, toId, musicInfos, addMusicLocationType, isRemote)
    })
  }

  /**
   * 批量移除歌曲
   * @param listId
   * @param listId 列表Id
   * @param ids 要删除歌曲的id
   * @param isRemote 是否属于远程操作
   */
  async list_music_remove(listId: string, ids: string[], isRemote: boolean = false) {
    await runListOperation([listId], async() => {
      const changedIds = await listMusicRemove(listId, ids)
      await checkUpdateList(changedIds)
      this.emit('list_music_remove', listId, ids, isRemote)
    })
  }

  /**
   * 批量更新歌曲信息
   * @param musicInfos 歌曲&列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_music_update(musicInfos: LX.List.ListActionMusicUpdate, isRemote: boolean = false) {
    await runListOperation(musicInfos.map(info => info.id), async() => {
      const changedIds = await listMusicUpdateInfo(musicInfos)
      await checkUpdateList(changedIds)
      this.emit('list_music_update', musicInfos, isRemote)
    })
  }

  /**
   * 清空列表内的歌曲
   * @param ids 列表Id
   * @param isRemote 是否属于远程操作
   */
  async list_music_clear(ids: string[], isRemote: boolean = false) {
    await runListOperation(ids, async() => {
      const changedIds = await listMusicClear(ids)
      await checkUpdateList(changedIds)
      this.emit('list_music_clear', ids, isRemote)
    })
  }

  /**
   * 批量更新歌曲位置
   * @param listId 列表ID
   * @param position 新位置
   * @param ids 歌曲id
   * @param isRemote 是否属于远程操作
   */
  async list_music_update_position(listId: string, position: number, ids: string[], isRemote: boolean = false) {
    await runListOperation([listId], async() => {
      const changedIds = await listMusicUpdatePosition(listId, position, ids)
      await checkUpdateList(changedIds)
      this.emit('list_music_update_position', listId, position, ids, isRemote)
    })
  }
}

type EventMethods = Omit<EventType, keyof Event>

declare class EventType extends ListEvent {
  on<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
  off<K extends keyof EventMethods>(event: K, listener: EventMethods[K]): any
}

export type ListEventTypes = Omit<EventType, keyof Omit<Event, 'on' | 'off'>>
export const createListEventHub = (): ListEventTypes => {
  return new ListEvent()
}

