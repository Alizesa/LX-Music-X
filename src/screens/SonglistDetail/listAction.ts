import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import { LIST_IDS } from '@/config/constant'
import listState from '@/store/list/state'
import { toggleQQMusicPlaylistCollected } from '@/core/qqMusicFavorite'
import { getQQMusicPlaylistsCache } from '@/utils/data'
import { toast } from '@/utils/tools'
import songlistState, { type Source } from '@/store/songlist/state'

const getListId = (id: string, source: LX.OnlineSource) => `${source}__${id}`

export const handlePlay = async(id: string, source: Source, list?: LX.Music.MusicInfoOnline[], index = 0) => {
  const listId = getListId(id, source)
  let isPlayingList = false
  // console.log(list)
  if (!list?.length) list = (await getListDetail(id, source, 1)).list
  if (list?.length) {
    await setTempList(listId, [...list])
    void playList(LIST_IDS.TEMP, index)
    isPlayingList = true
  }
  const fullList = await getListDetailAll(source, id)
  if (!fullList.length) return
  if (isPlayingList) {
    if (listState.tempListMeta.id == listId) {
      await setTempList(listId, [...fullList])
    }
  } else {
    await setTempList(listId, [...fullList])
    void playList(LIST_IDS.TEMP, index)
  }
}

export const handleCollect = async(id: string, source: Source, name: string) => {
  if (source !== 'tx') {
    toast(global.i18n.t('qq_playlist_collect_unsupported'), 'long')
    return false
  }
  // 自建歌单不能再作为收藏歌单写入缓存；已经收藏的也无需重复请求。
  const cached = await getQQMusicPlaylistsCache().catch(() => [])
  const existing = cached.find(item => item.id == id)
  if (existing?.subscribed === false || existing?.liked) {
    toast(global.i18n.t('qq_playlist_collect_unsupported'), 'long')
    return false
  }
  if (existing?.subscribed === true) {
    toast(global.i18n.t('qq_playlist_faved', { name }))
    return true
  }
  const detail = songlistState.listDetailInfo
  const currentDetail = detail.id == id && detail.source == source ? detail : null
  return toggleQQMusicPlaylistCollected({
    id,
    name,
    cover: currentDetail?.info.img,
    trackCount: currentDetail?.total ?? undefined,
  }, true)
}
