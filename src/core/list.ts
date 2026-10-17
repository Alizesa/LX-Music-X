import { LIST_IDS } from '@/config/constant'
import listAction from '@/store/list/action'
import listState from '@/store/list/state'
import settingState from '@/store/setting/state'
import { fixNewMusicInfoQuality } from '@/utils'
import { saveTempListMeta } from '@/utils/data'
import { withLocalList } from '@/core/localList'

// LOCAL 是延迟加载的：变更期间用 lease 占住，避免操作中途被释放。
// load=false：具体要不要加载由 list_event 内部决定，这里只防释放
const withLocalGuard = async<T>(isLocal: boolean, reason: string, fn: () => Promise<T>): Promise<T> => {
  return isLocal ? withLocalList(reason, fn, false) : fn()
}

/**
 * 覆盖全部列表数据
 * @param data
 */
export const overwriteListFull = async(data: LX.List.ListActionDataOverwrite) => {
  await withLocalGuard(true, 'list:overwriteFull', async() => { await global.list_event.list_data_overwrite(data) })
}


/**
 * 添加用户列表
 */
export const createUserList = async(position: number, listInfos: LX.List.UserListInfo[]) => {
  await global.list_event.list_create(position, listInfos)
}

/**
 * 移除用户列表及列表内歌曲
 */
export const removeUserList = async(ids: string[]) => {
  await global.list_event.list_remove(ids)
}

/**
 * 更新用户列表
 */
export const updateUserList = async(listInfos: LX.List.UserListInfo[]) => {
  await global.list_event.list_update(listInfos)
}

/**
 * 批量移动用户列表位置
 */
export const updateUserListPosition = async(position: number, ids: string[]) => {
  await global.list_event.list_update_position(position, ids)
}


/**
 * 批量添加歌曲到列表
 */
export const addListMusics = async(id: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType) => {
  await withLocalGuard(id === LIST_IDS.LOCAL, 'list:addMusics', async() => {
    await global.list_event.list_music_add(id, musicInfos, addMusicLocationType)
  })
}

/**
 * 跨列表批量移动歌曲
 */
export const moveListMusics = async(fromId: string, toId: string, musicInfos: LX.Music.MusicInfo[], addMusicLocationType: LX.AddMusicLocationType) => {
  const isLocal = fromId === LIST_IDS.LOCAL || toId === LIST_IDS.LOCAL
  await withLocalGuard(isLocal, 'list:moveMusics', async() => {
    await global.list_event.list_music_move(fromId, toId, musicInfos, addMusicLocationType)
  })
}

/**
 * 批量删除列表内歌曲
 */
export const removeListMusics = async(listId: string, ids: string[]) => {
  await withLocalGuard(listId === LIST_IDS.LOCAL, 'list:removeMusics', async() => {
    await global.list_event.list_music_remove(listId, ids)
  })
}

/**
 * 批量更新列表内歌曲
 */
export const updateListMusics = async(infos: Array<{ id: string, musicInfo: LX.Music.MusicInfo }>) => {
  const isLocal = infos.some(info => info.id === LIST_IDS.LOCAL)
  await withLocalGuard(isLocal, 'list:updateMusics', async() => {
    await global.list_event.list_music_update(infos)
  })
}

/**
 * 批量移动列表内歌曲的位置
 */
export const updateListMusicPosition = async(listId: string, position: number, ids: string[]) => {
  await withLocalGuard(listId === LIST_IDS.LOCAL, 'list:updatePosition', async() => {
    await global.list_event.list_music_update_position(listId, position, ids)
  })
}

/**
 * 覆盖列表内的歌曲
 */
export const overwriteListMusics = async(listId: string, musicInfos: LX.Music.MusicInfo[]) => {
  await withLocalGuard(listId === LIST_IDS.LOCAL, 'list:overwriteMusics', async() => {
    await global.list_event.list_music_overwrite(listId, musicInfos)
  })
}

/**
 * 覆盖列表内的歌曲
 */
export const clearListMusics = async(ids: string[]) => {
  await withLocalGuard(ids.includes(LIST_IDS.LOCAL), 'list:clearMusics', async() => {
    await global.list_event.list_music_clear(ids)
  })
}

/**
 * 覆盖单个列表。
 * 内置列表里只剩本地音乐（它由下载管理，不会走这里），所以现在只管自建列表。
 */
export const overwriteList = async(listInfoFull: LX.List.UserListInfoFull) => {
  const userListInfo = listInfoFull
  await updateUserList([
    {
      name: userListInfo.name,
      id: userListInfo.id,
      source: userListInfo.source,
      sourceListId: userListInfo.sourceListId,
      locationUpdateTime: userListInfo.locationUpdateTime,
    },
  ])
  await overwriteListMusics(listInfoFull.id, listInfoFull.list.map(m => fixNewMusicInfoQuality(m)))
}
/**
 * 覆盖单个列表
 * @param listInfo
 * @param musics
 */
export const createList = async({ name, id = `userlist_${Date.now()}`, list = [], source, sourceListId, position = -1 }: {
  name?: string
  id?: string
  list?: LX.Music.MusicInfo[]
  source?: LX.OnlineSource
  sourceListId?: string
  position?: number
}) => {
  await createUserList(position < 0 ? listState.userList.length : position, [
    {
      id,
      name: name ?? 'list',
      source,
      sourceListId,
      locationUpdateTime: position < 0 ? null : Date.now(),
    },
  ])
  if (list) await addListMusics(id, list, settingState.setting['list.addMusicLocationType'])
}

/**
 * 设置歌曲列表
 */
export const setUserList = (lists: LX.List.UserListInfo[]) => {
  listAction.setUserLists(lists)
}

/**
 * 设置临时列表内歌曲
 * @param id
 * @param list
 */
export const setTempList = async(id: string, list: LX.Music.MusicInfoOnline[]) => {
  await overwriteListMusics(LIST_IDS.TEMP, list)
  listAction.setTempListMeta({ id })
  // 落盘：重启后要靠它认出「这条队列来自每日推荐」，自动续播才能接着工作
  await saveTempListMeta({ id })
}

/** 启动时把上次的临时列表来源标记读回来 */
export const setTempListMeta: typeof listAction['setTempListMeta'] = (meta) => {
  listAction.setTempListMeta(meta)
}


export const setFetchingListStatus = (id: string, status: boolean) => {
  listAction.setFetchingListStatus(id, status)
}


export { getUserLists, getListMusics } from '@/utils/listManage'

