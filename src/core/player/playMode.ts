import { MUSIC_TOGGLE_MODE, MUSIC_TOGGLE_MODE_LIST } from '@/config/constant'
import { updateSetting } from '@/core/common'
import { toast } from '@/utils/tools'
import { translate } from '@/lang'
import settingState from '@/store/setting/state'


type ModeName = 'play_list_loop' | 'play_list_random' | 'play_list_order' | 'play_single_loop' | 'play_single'

const MODE_NAMES: Record<string, ModeName> = {
  [MUSIC_TOGGLE_MODE.listLoop]: 'play_list_loop',
  [MUSIC_TOGGLE_MODE.random]: 'play_list_random',
  [MUSIC_TOGGLE_MODE.list]: 'play_list_order',
  [MUSIC_TOGGLE_MODE.singleLoop]: 'play_single_loop',
}

export type TogglePlayMethod = typeof MUSIC_TOGGLE_MODE_LIST[number]

/**
 * 循环里的下一种播放模式。
 * 当前是历史值（顺序播放/禁用）时 indexOf 得到 -1，下一次点击就回到列表循环
 */
export const getNextPlayMode = (mode: string): TogglePlayMethod => {
  let index = MUSIC_TOGGLE_MODE_LIST.indexOf(mode as TogglePlayMethod)
  if (++index >= MUSIC_TOGGLE_MODE_LIST.length) index = 0
  return MUSIC_TOGGLE_MODE_LIST[index]
}

/**
 * 切到下一种播放模式，并提示一下切成了哪种。
 * 播放详情页的模式按钮与通知栏的那个按钮共用这里，省得两边的循环走岔
 */
export const toggleNextPlayMode = () => {
  const mode = getNextPlayMode(settingState.setting['player.togglePlayMethod'])
  updateSetting({ 'player.togglePlayMethod': mode })
  toast(translate(MODE_NAMES[mode] ?? 'play_single'))
}
