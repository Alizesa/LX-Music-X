import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import { LIST_IDS } from '@/config/constant'
import listState from '@/store/list/state'
import { getQQMusicPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { toggleQQMusicPlaylistCollected } from '@/core/qqMusicFavorite'
import { getQQMusicPlaylistsCache, saveQQMusicPlaylistsCache } from '@/utils/data'
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
  // 缓存里没有这条时先拉一次账号歌单再判断：只凭「缓存没找到」就发收藏，
  // 会把自建/已收藏的歌单也发出去（全新登录或「我的」页没打开过时缓存是空的）。
  const cached = await getQQMusicPlaylistsCache().catch(() => [])
  let existing = cached.find(item => item.id == id)
  if (!existing) {
    const { cookie } = await getQQMusicSession()
    if (cookie) {
      const fresh = await getQQMusicPlaylists(cookie, { requireAll: true }).catch(() => null)
      if (fresh) {
        await saveQQMusicPlaylistsCache(fresh).catch(() => {})
        existing = fresh.find(item => item.id == id)
      }
    }
  }
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
