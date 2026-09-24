// import { dateFormat } from '@/utils/common'
import { setListUpdateTime } from '@/utils/data'
import { overwriteListMusics, setFetchingListStatus } from './list'
import { getListDetailAll } from '@/core/songlist'
import { getListDetailAll as getBoardListAll } from '@/core/leaderboard'
import { getQQMusicPlaylistSongs, getQQMusicSession, isLikedPlaylistId } from '@/core/qqMusic'

const fetchList = async(id: string, source: LX.OnlineSource, sourceListId: string) => {
  setFetchingListStatus(id, true)

  let promise
  if (/^board__/.test(sourceListId)) {
    const id = sourceListId.replace(/^board__/, '')
    promise = id ? getBoardListAll(id, true) : Promise.reject(new Error('id not defined: ' + sourceListId))
  } else if (source == 'tx' && isLikedPlaylistId(sourceListId)) {
    // 「我喜欢」是 dirid=201 的虚拟歌单，没有可用的 disstid，通用歌单详情接口取不到歌，
    // 所以导入后一直更新不了。它只有 CgiGetDiss 那条路认（导入用的就是它），这里走同一条。
    promise = getQQMusicSession().then(async({ cookie }) => {
      if (!cookie) throw new Error(global.i18n.t('qq_not_logged_in'))
      return getQQMusicPlaylistSongs(cookie, String(sourceListId))
    })
  } else {
    promise = getListDetailAll(source, sourceListId, true)
  }
  return promise.finally(() => {
    setFetchingListStatus(id, false)
  })
}

export default async(targetListInfo: LX.List.UserListInfo) => {
  // console.log(targetListInfo)
  if (!targetListInfo.source || !targetListInfo.sourceListId) return
  const list = await fetchList(targetListInfo.id, targetListInfo.source, targetListInfo.sourceListId)
  // console.log(list)
  void overwriteListMusics(targetListInfo.id, list)
  const now = Date.now()
  void setListUpdateTime(targetListInfo.id, now)
  // TODO
  // setUpdateTime(targetListInfo.id, dateFormat(now))
}
