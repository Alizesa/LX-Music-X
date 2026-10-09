import { memo } from 'react'
import { MUSIC_TOGGLE_MODE } from '@/config/constant'
import { useSettingValue } from '@/store/setting/hook'
import { toggleNextPlayMode } from '@/core/player/playMode'
import Btn from './Btn'

// 用查表而不是 switch：按钮循环的列表里只剩三种模式，但设置里可能还留着
// 历史值（顺序播放/禁用），查表能让它们也显示出对应的图标。
const MODE_ICONS: Record<string, string> = {
  [MUSIC_TOGGLE_MODE.listLoop]: 'list-loop',
  [MUSIC_TOGGLE_MODE.random]: 'list-random',
  [MUSIC_TOGGLE_MODE.list]: 'list-order',
  [MUSIC_TOGGLE_MODE.singleLoop]: 'single-loop',
}

export default memo(() => {
  const togglePlayMethod = useSettingValue('player.togglePlayMethod')

  // 循环和提示都在 core/player/playMode 里，跟通知栏那个播放模式按钮共用一套
  return <Btn icon={MODE_ICONS[togglePlayMethod] ?? 'single'} onPress={toggleNextPlayMode} />
})
