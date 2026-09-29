// import { getPlayInfo } from '@/utils/data'
// import { log } from '@/utils/log'
import { init as musicSdkInit } from '@/utils/musicSdk'
import { getListMusics, getUserLists, setUserList, setTempListMeta } from '@/core/list'
import { LIST_IDS } from '@/config/constant'
import { setNavActiveId } from '../common'
import { getTempListMeta, getViewPrevState } from '@/utils/data'
import { bootLog } from '@/utils/bootLog'
import { getDislikeInfo, setDislikeInfo } from '@/core/dislikeList'
import { unlink } from '@/utils/fs'
import { TEMP_FILE_PATH } from '@/utils/tools'
// import { play, playList } from '../player/player'

// const initPrevPlayInfo = async(appSetting: LX.AppSetting) => {
//   const info = await getPlayInfo()
//   global.lx.restorePlayInfo = null
//   if (!info?.listId || info.index < 0) return
//   const list = await getListMusics(info.listId)
//   if (!list[info.index]) return
//   global.lx.restorePlayInfo = info
//   await playList(info.listId, info.index)

//   if (appSetting['player.startupAutoPlay']) setTimeout(play)
// }

export default async(appSetting: LX.AppSetting) => {
  // await Promise.all([
  //   initUserApi(), // 自定义API
  // ]).catch(err => log.error(err))
  void musicSdkInit() // 初始化音乐sdk
  bootLog('User list init...')
  setUserList(await getUserLists()) // 获取用户列表
  setDislikeInfo(await getDislikeInfo()) // 获取不喜欢列表
  await getListMusics(LIST_IDS.LOCAL)
  const { initPlayQueue } = await import('@/core/player/playQueue')
  await initPlayQueue()
  const { getTasks } = await import('@/core/download')
  const { default: downloadState } = await import('@/store/download/state')
  downloadState.tasks = [...await getTasks()]
  bootLog('User list inited.')
  setNavActiveId((await getViewPrevState()).id)
  // 临时列表来源标记（每日推荐靠它续播）。内存里那份重启就没了，
  // 不读回来的话，恢复出来的推荐队列播完只会一直循环。
  setTempListMeta(await getTempListMeta())
  // 自动续播的监听以前只在点「每日推荐」时注册，重启后等于没有监听，
  // 这里补上；它是幂等的，点每日推荐那次注册不会重复。
  const { initQQMusicRecommendAutoRefresh, migrateRecommendPlayQueue } = await import('@/core/qqMusicRecommend')
  initQQMusicRecommendAutoRefresh()
  // 老版本落盘的推荐队列没有专属来源标记，补一次，之后判断只看队列自己的标记。
  // 要放在上面的 setTempListMeta 之后（判断要用到临时列表标记）和 initPlayQueue 之后。
  await migrateRecommendPlayQueue()
  void unlink(TEMP_FILE_PATH)
  // await initPrevPlayInfo(appSetting).catch(err => log.error(err)) // 初始化上次的歌曲播放信息
}
