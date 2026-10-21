import { AppState } from 'react-native'
import { releaseIdleListCaches } from '@/utils/listManage'
import { releaseIdleSonglistCaches } from '@/core/songlist'
import { releaseIdleSingerCaches } from '@/store/singer/action'
import { clearOtherSourceCache } from '@/core/music/utils'

/**
 * 可重建内存缓存的统一释放入口。
 *
 * 只释放「不在用、不在显示、不在加载」的部分：LOCAL 由 core/localList 的 holds 管理，
 * 当前播放队列/正在播放的歌曲对象不在这些缓存里；页面 hold 的记录也由各自的 release 跳过。
 */
export const releaseIdleCaches = () => {
  releaseIdleListCaches() // TEMP 条件释放 + 用户列表 prune
  releaseIdleSonglistCaches() // 歌单详情/广场列表
  releaseIdleSingerCaches() // 歌手/专辑详情
  clearOtherSourceCache() // 换源结果
}

let initialized = false
/** 由 dataInit 调用一次：App 进后台时释放闲置缓存；队列变化时检查 TEMP 能否释放 */
export const initCacheLifecycle = () => {
  if (initialized) return
  initialized = true
  AppState.addEventListener('change', state => {
    if (state === 'background') releaseIdleCaches()
  })
  global.app_event.on('playQueueUpdate', () => { releaseIdleListCaches() })
}
