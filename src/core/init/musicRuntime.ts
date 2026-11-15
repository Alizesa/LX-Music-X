import { AppState } from 'react-native'
import { initSetting } from '@/core/common'
import { setApiSource } from '@/core/apiSource'
import settingState from '@/store/setting/state'
import initI18n from './i18n'
import initUserApi from './userApi'

let settings: Promise<LX.AppSetting> | null = null
let musicRuntime: Promise<void> | null = null

// 前台启动和后台下载共用设置、语言与音源初始化，监听只注册一次。
export const initializeRuntimeSettings = async(): Promise<LX.AppSetting> => {
  settings ??= initSetting().catch((error: unknown) => { settings = null; throw error })
  return settings
}

export const initializeMusicRuntime = async(setting: LX.AppSetting): Promise<void> => {
  musicRuntime ??= (async() => {
    await initI18n(setting)
    // 后台没有可绘制的帧，翻译实例直接应用语言。
    const locale = settingState.setting['common.langId']
    if (locale && global.i18n.availableLocales.includes(locale)) global.i18n.setLanguage(locale)
    await initUserApi(setting, { suppressDialogs: () => AppState.currentState !== 'active' })
    setApiSource(settingState.setting['common.apiSource'])
  })().catch((error: unknown) => { musicRuntime = null; throw error })
  return musicRuntime
}
