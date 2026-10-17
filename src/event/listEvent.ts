import Event from './Event'

import { getListMusics as getListMusicsFromStore, saveUserList, removeListMusics, saveListMusics } from '@/utils/data'
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
} from '@/utils/listManage'
import { LIST_IDS } from '@/config/constant'
import { setUserList } from '@/core/list'

const updateUserList = async(userLists: LX.List.UserListInfo[]) => {
  await saveUserList(userLists)
  setUserList(userLists)
}

export const checkUpdateList = async(changedIds: string[]) => {
  if (!changedIds.length) return
  const includesLocal = changedIds.includes(LIST_IDS.LOCAL)
  // 先标 dirty：列表写成功、索引没写就崩溃时，下次启动会重建
  if (includesLocal) await markLocalMatchIndexDirty()
  await saveListMusics(changedIds.map(id => ({ id, musics: allMusicList.get(id) as LX.List.ListMusics })))
  if (includesLocal) {
    // 延迟加载阶段 LOCAL 可能不在内存里，防御性地从存储读一次再建
    const list = allMusicList.get(LIST_IDS.LOCAL) ?? await getListMusicsFromStore(LIST_IDS.LOCAL)
    await rebuildLocalMatchIndexFromList(list)
  }
  global.app_event.myListMusicUpdate(changedIds)
}


// {
//   // sync: {
//   //   send_action_list: 'send_action_list',
//   //   handle_action_list: 'handle_action_list',
//   //   send_sync_list: 'send_sync_list',
//   //   handle_sync_list: 'handle_sync_list',
//   // },
// }

// 兼容v2.3.0之前版本插入数字类型的ID导致其意外在末尾追加 .0 的问题，确保所有ID都是字符串类型
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
  // list_music_changed(ids: string[]) {
  //   this.emit('list_music_changed', ids)
  // }

  /**
   * 覆盖整个列表数据
   * @param listData 列表数据
   * @param isRemote 是否属于远程操作
   */
  async list_data_overwrite(listData: MakeOptional<LX.List.ListDataFull, 'tempList'>, isRemote: boolean = false) {
    fixListIdType(listData.userList)
    const oldIds = userLists.map(l => l.id)
    const changedIds = listDataOverwrite(listData)
    await updateUserList(userLists)
    // await checkUpdateList(changedIds)
    const removedList = oldIds.filter(id => !allMusicList.has(id))
    if (removedList.length) await removeListMusics(removedList)
    // LOCAL 只在「已加载」或「本次显式提供了 localList」时才写：
    // 延迟加载下，没加载不等于空列表，不能拿它覆盖存储
    const includesLocal = allMusicList.has(LIST_IDS.LOCAL)
    const allListIds = includesLocal
      ? [LIST_IDS.LOCAL, ...userLists.map(l => l.id)]
      : userLists.map(l => l.id)
    if (changedIds.includes(LIST_IDS.TEMP)) allListIds.push(LIST_IDS.TEMP)
    if (includesLocal) await markLocalMatchIndexDirty()
    await saveListMusics([...allListIds.map(id => ({ id, musics: allMusicList.get(id) as LX.List.ListMusics }))])
    if (includesLocal) await rebuildLocalMatchIndexFromList(allMusicList.get(LIST_IDS.LOCAL)!)

    global.app_event.myListMusicUpdate(changedIds)
    this.emit('list_data_overwrite', listData, isRemote)
  }

  /**
   * 批量创建列表
   * @param position 列表位置
   * @param lists 列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_create(position: number, lists: LX.List.UserListInfo[], isRemote: boolean = false) {
    // const changedIds: string[] = []
    fixListIdType(lists)
    for (const list of lists) {
      userListCreate({ ...list, position })
      // changedIds.push(list.id)
    }
    await updateUserList(userLists)
    this.emit('list_create', position, lists, isRemote)
  }

  /**
   * 批量删除列表及列表内歌曲
   * @param ids 列表ids
   * @param isRemote 是否属于远程操作
   */
  async list_remove(ids: string[], isRemote: boolean = false) {
    const changedIds = userListsRemove(ids)
    await updateUserList(userLists)
    await removeListMusics(ids)
    this.emit('list_remove', ids, isRemote)
    global.app_event.myListMusicUpdate(changedIds)
  }

  /**
   * 批量更新列表信息
   * @param lists 列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_update(lists: LX.List.UserListInfo[], isRemote: boolean = false) {
    userListsUpdate(lists)
    await updateUserList(userLists)
    this.emit('list_update', lists, isRemote)
  }

  /**
   * 批量更新列表位置
   * @param position 列表位置
   * @param ids 列表ids
   * @param isRemote 是否属于远程操作
   */
  async list_update_position(position: number, ids: string[], isRemote: boolean = false) {
    userListsUpdatePosition(position, ids)
    await updateUserList(userLists)
    this.emit('list_update_position', position, ids, isRemote)
  }

  /**
   * 覆盖列表内歌曲
   * @param listId 列表id
   * @param musicInfos 音乐信息
   * @param isRemote 是否属于远程操作
   */
  async list_music_overwrite(listId: string, musicInfos: LX.Music.MusicInfo[], isRemote: boolean = false) {
    const changedIds = await listMusicOverwrite(listId, musicInfos)
    await checkUpdateList(changedIds)
    this.emit('list_music_overwrite', listId, musicInfos, isRemote)
  }

  /**
   * 批量添加歌曲到列表
   * @param listId 列表id
   * @param musicInfos 添加的歌曲信息
   * @param addMusicLocationType 添加在到列表的位置
   * @param isRemote 是否属于远程操作
   */
  async list_music_add(listId: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType, isRemote: boolean = false) {
    const changedIds = await listMusicAdd(listId, musicInfos, addMusicLocationType)
    await checkUpdateList(changedIds)
    this.emit('list_music_add', listId, musicInfos, addMusicLocationType, isRemote)
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
    const changedIds = await listMusicMove(fromId, toId, musicInfos, addMusicLocationType)
    await checkUpdateList(changedIds)
    this.emit('list_music_move', fromId, toId, musicInfos, addMusicLocationType, isRemote)
  }

  /**
   * 批量移除歌曲
   * @param listId
   * @param listId 列表Id
   * @param ids 要删除歌曲的id
   * @param isRemote 是否属于远程操作
   */
  async list_music_remove(listId: string, ids: string[], isRemote: boolean = false) {
    const changedIds = await listMusicRemove(listId, ids)
    // console.log(changedIds)
    await checkUpdateList(changedIds)
    this.emit('list_music_remove', listId, ids, isRemote)
  }

  /**
   * 批量更新歌曲信息
   * @param musicInfos 歌曲&列表信息
   * @param isRemote 是否属于远程操作
   */
  async list_music_update(musicInfos: LX.List.ListActionMusicUpdate, isRemote: boolean = false) {
    const changedIds = await listMusicUpdateInfo(musicInfos)
    await checkUpdateList(changedIds)
    this.emit('list_music_update', musicInfos, isRemote)
  }

  /**
   * 清空列表内的歌曲
   * @param ids 列表Id
   * @param isRemote 是否属于远程操作
   */
  async list_music_clear(ids: string[], isRemote: boolean = false) {
    const changedIds = await listMusicClear(ids)
    await checkUpdateList(changedIds)
    this.emit('list_music_clear', ids, isRemote)
  }

  /**
   * 批量更新歌曲位置
   * @param listId 列表ID
   * @param position 新位置
   * @param ids 歌曲id
   * @param isRemote 是否属于远程操作
   */
  async list_music_update_position(listId: string, position: number, ids: string[], isRemote: boolean = false) {
    const changedIds = await listMusicUpdatePosition(listId, position, ids)
    await checkUpdateList(changedIds)
    this.emit('list_music_update_position', listId, position, ids, isRemote)
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

