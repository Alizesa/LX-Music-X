import { LIST_IDS } from '@/config/constant'
import { setTempList } from '@/core/list'
import { createPlaySelection, playList } from '@/core/player/player'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import listState from '@/store/list/state'

const getListPlayIndex = (list: LX.Music.MusicInfoOnline[], index?: number) => {
  if (index == null) {
    index = 1
  } else {
    if (index < 1) index = 1
    else if (index > list.length) index = list.length
  }
  return index - 1
}

const playSongListDetail = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  // console.log(source, link, playIndex)
  if (link == null) return
  const selection = createPlaySelection()
  let isPlayingList = false
  const id = decodeURIComponent(link)
  const playListId = `${source}__${id}`
  let list = (await getListDetail(id, source, 1)).list
  if (!selection()) return
  // 指定首屏末曲时先取完整歌单，保证下一曲也进入实际播放队列。
  // 播放队列是 TEMP 的快照；后续补写 TEMP 不会扩展已经建立的队列。
  if (list.length && (playIndex == null || list.length > playIndex)) {
    await setTempList(playListId, list)
    if (!selection()) return
    await playList(LIST_IDS.TEMP, getListPlayIndex(list, playIndex), selection)
    isPlayingList = true
  }
  if (!selection.isLatest()) return
  list = await getListDetailAll(source, id)
  if (!list.length || !selection.isLatest()) return
  if (isPlayingList) {
    if (listState.tempListMeta.id == playListId) await setTempList(playListId, list)
  } else {
    if (!selection()) return
    await setTempList(playListId, list)
    if (selection()) await playList(LIST_IDS.TEMP, getListPlayIndex(list, playIndex), selection)
  }
}
export const playSonglist = async(source: LX.OnlineSource, link: string, playIndex?: number) => {
  try {
    await playSongListDetail(source, link, playIndex)
  } catch (err) {
    console.error(err)
    throw new Error('Get play list failed.')
  }
}
