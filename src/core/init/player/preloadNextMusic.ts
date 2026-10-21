import { getMusicUrl } from '@/core/music'
import { getNextPlayMusicInfo, resetRandomNextMusicInfo } from '@/core/player/player'
import { checkUrl } from '@/utils/request'
import { isUrl } from '@/utils/common'
import playerState from '@/store/player/state'
import { isCached } from '@/plugins/player/utils'


const preloadMusicInfo = {
  isLoading: false,
  preProgress: 0,
  info: null as LX.Player.PlayMusicInfo | null,
}
// 切歌/暂停时递增；旧预加载在任意 await 返回后都要检查，不能写状态或继续发请求
let preloadGeneration = 0
let preloadCancel: (() => void) | null = null

const resetPreloadInfo = () => {
  preloadGeneration++
  preloadCancel?.()
  preloadCancel = null
  preloadMusicInfo.preProgress = 0
  preloadMusicInfo.info = null
  preloadMusicInfo.isLoading = false
}
const setPreloadCancel = (generation: number, cancel: () => void) => {
  if (generation !== preloadGeneration) {
    cancel()
    return
  }
  preloadCancel?.()
  preloadCancel = cancel
}
const preloadNextMusicUrl = async(curTime: number) => {
  if (preloadMusicInfo.isLoading || curTime - preloadMusicInfo.preProgress < 3) return
  preloadMusicInfo.isLoading = true
  const generation = preloadGeneration
  console.log('preload next music url')
  const info = await getNextPlayMusicInfo()
  if (generation !== preloadGeneration) return
  if (info) {
    preloadMusicInfo.info = info
    const url = await getMusicUrl({
      musicInfo: info.musicInfo,
      onCancel: cancel => { setPreloadCancel(generation, cancel) },
    }).catch(() => '')
    if (generation !== preloadGeneration) return
    // 已下载 / 已导入的歌曲返回的是本地 URI（下载走 SAF，是 content://），不是可请求的
    // 地址。把它交给 fetch，RN 会构造 status 为 0 的 Response 并抛 RangeError；而那个
    // 异常是在 XHR 的回调里抛出的，不会变成 promise rejection，下面的 catch 接不住，
    // 会直接冒到全局错误处理 —— 所以必须在这里挡掉，而不是靠 catch。
    // 本地文件本来就在磁盘上，也无需再做预加载校验。
    if (url && isUrl(url)) {
      console.log('preload url', url)
      const [cached, available] = await Promise.all([isCached(url), checkUrl(url).then(() => true).catch(() => false)])
      if (generation !== preloadGeneration) return
      if (!cached && !available) {
        const url = await getMusicUrl({
          musicInfo: info.musicInfo,
          isRefresh: true,
          onCancel: cancel => { setPreloadCancel(generation, cancel) },
        }).catch(() => '')
        console.log('preload url refresh', url)
      }
    }
  }
  if (generation === preloadGeneration) preloadMusicInfo.isLoading = false
}

export default () => {
  const setProgress = (time: number) => {
    if (!playerState.musicInfo.id) return
    preloadMusicInfo.preProgress = time
  }

  const handleSetPlayInfo = () => {
    resetPreloadInfo()
  }

  const handleConfigUpdated: typeof global.state_event.configUpdated = (keys, settings) => {
    if (!keys.includes('player.togglePlayMethod')) return
    if (!preloadMusicInfo.info || preloadMusicInfo.info.isTempPlay) return
    resetRandomNextMusicInfo()
    resetPreloadInfo()
    preloadMusicInfo.preProgress = playerState.progress.nowPlayTime
  }

  const handlePlayProgressChanged: typeof global.state_event.playProgressChanged = (progress) => {
    const duration = progress.maxPlayTime
    if (duration > 10 && duration - progress.nowPlayTime < 10 && !preloadMusicInfo.info) {
      void preloadNextMusicUrl(progress.nowPlayTime)
    }
  }

  global.app_event.on('setProgress', setProgress)
  global.app_event.on('musicToggled', handleSetPlayInfo)
  global.state_event.on('configUpdated', handleConfigUpdated)
  global.state_event.on('playProgressChanged', handlePlayProgressChanged)
}
