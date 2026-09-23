import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { toast } from '@/utils/tools'
import { isLikedPlaylist } from '@/core/qqMusic'

/**
 * 首页和「我的」都要从推荐歌单/自建歌单进详情，放在一处避免两边行为不一致。
 */
export const openQQPlaylist = (item: LX.QQMusic.PlaylistInfo) => {
  // 「我喜欢」是 dirid=201 的虚拟歌单，通用歌单详情接口打不开，会连发注定失败的请求。
  // 想收进本地要走 QQ 音乐页面里的导入按钮（那条路径用 CgiGetDiss 取歌）。
  if (isLikedPlaylist(item)) {
    toast(global.i18n.t('qq_liked_open_unsupported'), 'long')
    return
  }
  const componentId = commonState.componentIds.home
  if (!componentId) return
  navigations.pushSonglistDetailScreen(componentId, {
    id: item.id,
    name: item.name,
    author: item.author ?? '',
    img: item.cover,
    desc: item.description,
    source: 'tx',
    total: item.trackCount ? String(item.trackCount) : undefined,
  })
}
