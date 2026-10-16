import { createList, getListMusics, overwriteList, overwriteListFull } from '@/core/list'
import { filterMusicList, fixNewMusicInfoQuality, toNewMusicInfo } from '@/utils'
import { log } from '@/utils/log'
import { confirmDialog, handleReadFile, handleSaveFile, showImportTip, toast } from '@/utils/tools'
import listState from '@/store/list/state'


const getAllLists = async() => {
  const lists: LX.List.UserListInfoFull[] = []

  for await (const list of listState.userList) {
    lists.push(await getListMusics(list.id).then(musics => ({ ...list, list: musics })))
  }

  return lists
}

// 老备份里会混着「试听列表」/「我的收藏」（id 是 default / love）。这两类已经没有落点了，
// 放进来只会凭空多出一个自建列表，直接跳过
const isRemovedListId = (id: unknown) => id === 'default' || id === 'love'

const importOldListData = async(lists: any[]) => {
  const allLists = await getAllLists()
  for (const list of lists) {
    try {
      if (isRemovedListId(list?.id)) continue
      const targetList = allLists.find(l => l.id == list.id)
      if (targetList) {
        targetList.list = filterMusicList((list.list as any[]).map(m => toNewMusicInfo(m)))
      } else {
        const listInfo = {
          name: list.name,
          id: list.id,
          list: filterMusicList((list.list as any[]).map(m => toNewMusicInfo(m))),
          source: list.source,
          sourceListId: list.sourceListId,
          locationUpdateTime: list.locationUpdateTime ?? null,
        }
        allLists.push(listInfo as LX.List.UserListInfoFull)
      }
    } catch (err) {
      console.log(err)
    }
  }
  await overwriteListFull({ userList: allLists })
}
const importNewListData = async(lists: LX.List.UserListInfoFull[]) => {
  const allLists = await getAllLists()
  for (const list of lists) {
    try {
      if (isRemovedListId(list?.id)) continue
      const targetList = allLists.find(l => l.id == list.id)
      if (targetList) {
        targetList.list = filterMusicList(list.list).map(m => fixNewMusicInfoQuality(m))
      } else {
        const data = {
          name: list.name,
          id: list.id,
          list: filterMusicList(list.list).map(m => fixNewMusicInfoQuality(m)),
          source: list.source,
          sourceListId: list.sourceListId,
          locationUpdateTime: list.locationUpdateTime ?? null,
        }
        allLists.push(data as LX.List.UserListInfoFull)
      }
    } catch (err) {
      console.log(err)
    }
  }
  await overwriteListFull({ userList: allLists })
}

/**
 * 导入单个列表
 * @param listData
 * @param position
 * @returns
 */
export const handleImportListPart = async(listData: LX.ConfigFile.MyListInfoPart['data'], position: number = listState.userList.length) => {
  // 老备份里可能是「试听列表」/「我的收藏」的单列表导出。这两类已经拆了，
  // 放进来只会在自建歌单里凭空多一个幽灵列表，跟整份导入那边的处理保持一致：跳过
  if (isRemovedListId(listData.id)) {
    toast(global.i18n.t('setting_backup_part_import_list_tip_removed'), 'long')
    return
  }
  const targetList = listState.allList.find(l => l.id === listData.id)
  if (targetList) {
    const confirm = await confirmDialog({
      message: global.i18n.t('list_import_part_confirm', { importName: listData.name, localName: targetList.name }),
      cancelButtonText: global.i18n.t('list_import_part_button_cancel'),
      confirmButtonText: global.i18n.t('list_import_part_button_confirm'),
      bgClose: false,
    })
    if (confirm) {
      listData.name = targetList.name
      void overwriteList(listData).then(() => {
        toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
      }).catch((err) => {
        log.error(err)
        toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
      })
      return
    }
    listData.id += `__${Date.now()}`
  }
  const userList = listData
  void createList({
    name: userList.name,
    id: userList.id,
    list: userList.list,
    source: userList.source,
    sourceListId: userList.sourceListId,
    position: Math.max(position, -1),
  }).then(() => {
    toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
  }).catch((err) => {
    log.error(err)
    toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
  })
}

const showConfirm = async() => {
  return confirmDialog({
    message: global.i18n.t('list_import_part_confirm_tip'),
    cancelButtonText: global.i18n.t('dialog_cancel'),
    confirmButtonText: global.i18n.t('confirm_button_text'),
    bgClose: false,
  })
}
const importPlayList = async(path: string) => {
  let configData: any
  try {
    configData = await handleReadFile(path)
  } catch (error: any) {
    log.error(error.stack)
    throw error
  }

  switch (configData.type) {
    // 兼容 0.6.2 及以前版本的列表数据。单列表导出的都是「试听列表」，
    // 这个列表已经拆了，导进来没有落点 —— 明确说一声并跳过，
    // 不能让它走成「导入成功」（数据其实被丢掉了）
    case 'defautlList':
      if (!await showConfirm()) return true
      toast(global.i18n.t('setting_backup_part_import_list_tip_removed'), 'long')
      return true
    case 'playList':
      if (!await showConfirm()) return true
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await importOldListData(configData.data)
      break
    case 'playList_v2':
      if (!await showConfirm()) return true
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await importNewListData(configData.data)
      break
    case 'allData':
      if (!await showConfirm()) return true
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await importOldListData(configData.playList)
      break
    case 'allData_v2':
      if (!await showConfirm()) return true
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await importNewListData(configData.playList)
      break
    case 'playListPart':
      configData.data.list = filterMusicList((configData.data as LX.ConfigFile.MyListInfoPart['data']).list.map(m => toNewMusicInfo(m)))
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      void handleImportListPart(configData.data)
      return true
    case 'playListPart_v2':
      configData.data.list = filterMusicList((configData.data as LX.ConfigFile.MyListInfoPart['data']).list).map(m => fixNewMusicInfoQuality(m))
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      void handleImportListPart(configData.data)
      return true
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    default: showImportTip(configData.type)
  }
}

export const handleImportList = (path: string) => {
  console.log(path)
  toast(global.i18n.t('setting_backup_part_import_list_tip_unzip'))
  void importPlayList(path).then((skipTip) => {
    if (skipTip) return
    toast(global.i18n.t('setting_backup_part_import_list_tip_success'))
  }).catch((err) => {
    log.error(err)
    toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
  })
}


const exportAllList = async(path: string) => {
  const data = JSON.parse(JSON.stringify({
    type: 'playList_v2',
    data: await getAllLists(),
  }))

  try {
    await handleSaveFile(path + '/lx_list.lxmc', data)
  } catch (error: any) {
    log.error(error.stack)
  }
}
export const handleExportList = (path: string) => {
  toast(global.i18n.t('setting_backup_part_export_list_tip_zip'))
  void exportAllList(path).then(() => {
    toast(global.i18n.t('setting_backup_part_export_list_tip_success'))
  }).catch((err: any) => {
    log.error(err.message)
    toast(global.i18n.t('setting_backup_part_export_list_tip_failed') + ': ' + (err.message as string))
  })
}
