import { memo } from 'react'
import { toast } from '@/utils/tools'
import { MUSIC_TOGGLE_MODE_LIST, MUSIC_TOGGLE_MODE } from '@/config/constant'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import Btn from './Btn'

type ModeName = 'play_list_loop' | 'play_list_random' | 'play_list_order' | 'play_single_loop' | 'play_single'

// 用查表而不是 switch：按钮循环的列表里只剩三种模式，但设置里可能还留着
// 历史值（顺序播放/禁用），查表能让它们也显示出对应的图标和名称。
const MODE_NAMES: Record<string, ModeName> = {
  [MUSIC_TOGGLE_MODE.listLoop]: 'play_list_loop',
  [MUSIC_TOGGLE_MODE.random]: 'play_list_random',
  [MUSIC_TOGGLE_MODE.list]: 'play_list_order',
  [MUSIC_TOGGLE_MODE.singleLoop]: 'play_single_loop',
}
const MODE_ICONS: Record<string, string> = {
  [MUSIC_TOGGLE_MODE.listLoop]: 'list-loop',
  [MUSIC_TOGGLE_MODE.random]: 'list-random',
  [MUSIC_TOGGLE_MODE.list]: 'list-order',
  [MUSIC_TOGGLE_MODE.singleLoop]: 'single-loop',
}

export default memo(() => {
  const togglePlayMethod = useSettingValue('player.togglePlayMethod')
  const t = useI18n()

  const toggleNextPlayMode = () => {
    // 当前是历史值(顺序播放/禁用)时 indexOf 得到 -1，下一次点击就回到列表循环
    let index = MUSIC_TOGGLE_MODE_LIST.indexOf(togglePlayMethod as typeof MUSIC_TOGGLE_MODE_LIST[number])
    if (++index >= MUSIC_TOGGLE_MODE_LIST.length) index = 0
    const mode = MUSIC_TOGGLE_MODE_LIST[index]
    updateSetting({ 'player.togglePlayMethod': mode })
    toast(t(MODE_NAMES[mode] ?? 'play_single'))
  }

  return <Btn icon={MODE_ICONS[togglePlayMethod] ?? 'single'} onPress={toggleNextPlayMode} />
})
