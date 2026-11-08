import { AppState } from 'react-native'
import playerState from '@/store/player/state'
import { prefetch } from '@/components/common/ImageBackground'
import { setBgPic } from '@/core/common'

const formatUri = (url: string) => url.startsWith('/') ? `file://${url}` : url

export default async(setting: LX.AppSetting) => {
  let enabled = setting['theme.dynamicBg']
  let applied: string | null = null
  let prefetched: string | null = null
  const pending = new Set<string>()

  const updatePic = () => {
    const pic = playerState.musicInfo.pic
    if (!enabled || AppState.currentState !== 'active' || !pic || pic === playerState.loadErrorPicUrl || pic === applied) return
    const apply = () => {
      if (!enabled || AppState.currentState !== 'active' || pic !== playerState.musicInfo.pic || pic === playerState.loadErrorPicUrl || pic === applied) return
      applied = pic
      setBgPic(formatUri(pic))
    }
    if (prefetched === pic) {
      apply()
      return
    }
    if (pending.has(pic)) return
    pending.add(pic)
    // 歌词和其他元数据更新不应重复预取同一封面；后台切歌只在回到前台时取最新一张。
    void prefetch(formatUri(pic)).then(success => {
      if (!success) return
      prefetched = pic
      apply()
    }).catch(error => {
      console.warn('[Background] image prefetch failed:', error instanceof Error ? error.message : error)
    }).finally(() => { pending.delete(pic) })
  }

  const handleConfigUpdate = (keys: Array<keyof LX.AppSetting>, next: Partial<LX.AppSetting>) => {
    if (!keys.includes('theme.dynamicBg')) return
    enabled = next['theme.dynamicBg']!
    if (enabled) updatePic()
    else {
      applied = null
      setBgPic(null)
    }
  }
  updatePic()
  global.state_event.on('playerMusicInfoChanged', updatePic)
  global.state_event.on('configUpdated', handleConfigUpdate)
  AppState.addEventListener('change', state => { if (state === 'active') updatePic() })
}
