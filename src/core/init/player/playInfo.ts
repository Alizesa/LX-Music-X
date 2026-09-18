import { getPlayInfo } from '@/utils/data'
import { playList, play } from '@/core/player/player'
import { getList } from '@/core/player/playInfo'
import { initPlayQueue } from '@/core/player/playQueue'


export default async(setting: LX.AppSetting) => {
  const info = await getPlayInfo()
  global.lx.restorePlayInfo = null
  if (!info?.listId || info.index < 0) return

  // 队列必须先载入内存。改为播放队列之后，存下来的 listId 是 play_queue，
  // 恢复要按 index 取队列里的歌，而 getList 是纯内存读、没有存储兜底
  // （上游这里用的是 getListMusics，内存没有会落盘读，所以不受影响）。
  // 队列的内存状态原本要到 dataInit 才填充，那已经在本函数之后了，
  // 于是 getList 返回空数组，下面这行判断会静默退出，播放位置就丢了。
  // initPlayQueue 是幂等的，dataInit 里那次调用会变成空操作。
  await initPlayQueue()

  const list = getList(info.listId)
  if (!list[info.index]) return
  global.lx.restorePlayInfo = info

  await playList(info.listId, info.index)

  if (setting['player.startupAutoPlay']) setTimeout(play)


  // if (!info.list || !info.list[info.index]) {
  //   const info2 = { ...info }
  //   if (info2.list) {
  //     info2.music = info2.list[info2.index]?.name
  //     info2.list = info2.list.length
  //   }
  //   toast('恢复播放数据失败，请去错误日志查看', 'long')
  //   log.warn('Restore Play Info failed: ', JSON.stringify(info2, null, 2))

  //   return
  // }

  // let setting = store.getState().common.setting
  // global.restorePlayInfo = {
  //   info,
  //   startupAutoPlay: setting.startupAutoPlay,
  // }

  // store.dispatch(playerAction.setList({
  //   list: {
  //     list: info.list,
  //     id: info.listId,
  //   },
  //   index: info.index,
  // }))
}
