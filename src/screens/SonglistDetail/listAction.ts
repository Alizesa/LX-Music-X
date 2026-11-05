import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getListDetail, getListDetailAll } from '@/core/songlist'
import { LIST_IDS } from '@/config/constant'
import listState from '@/store/list/state'
import { getQQMusicPlaylists, getQQMusicSession, isQQMusicSessionCurrent, QQMusicSessionExpiredError, updateQQMusicPlaylistsCache } from '@/core/qqMusic'
import { toggleQQMusicPlaylistCollected } from '@/core/qqMusicFavorite'
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
  // 每次收藏前都向服务器确认一次账号歌单，不能只信本地缓存：
  // 缓存可能过时（在 QQ 客户端取消过收藏），也可能为空（全新登录/没进过「我的」页）。
  // 这样也能顺手判断自建歌单，避免把它们当收藏歌单发出去。
  const session = await getQQMusicSession()
  const { cookie } = session
  if (!cookie) {
    toast(global.i18n.t('qq_not_logged_in'), 'long')
    return false
  }
  if (!isQQMusicSessionCurrent(session)) return false
  let fresh: LX.QQMusic.PlaylistInfo[]
  try {
    fresh = await getQQMusicPlaylists(cookie, { requireAll: true })
  } catch (error) {
    // 票据失效交给上层走重新登录
    if (error instanceof QQMusicSessionExpiredError) throw error
    console.warn('[QQMusic] 收藏前刷新歌单失败:', error instanceof Error ? error.message : error)
    toast(global.i18n.t('qq_load_failed'), 'long')
    return false
  }
  // 缓存写入与退出清理串行；同号重新登录也会使这次请求的会话代次失效。
  const current = await updateQQMusicPlaylistsCache(session, () => fresh).catch(() => isQQMusicSessionCurrent(session))
  if (!current || !isQQMusicSessionCurrent(session)) return false
  const existing = fresh.find(item => item.id == id)
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
  }, true, { session })
}
