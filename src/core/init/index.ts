import { initSetting, showPactModal } from '@/core/common'
import registerPlaybackService from '@/plugins/player/service'
import initTheme from './theme'
import initI18n from './i18n'
import initUserApi from './userApi'
import initPlayer from './player'
import dataInit from './dataInit'
import initCommonState from './common'
import { initDeeplink } from './deeplink'
import { setApiSource } from '@/core/apiSource'
import commonActions from '@/store/common/action'
import settingState from '@/store/setting/state'
import { checkUpdate, initializeVersion } from '@/core/version'
import { bootLog } from '@/utils/bootLog'
import { cheatTip } from '@/utils/tools'
import initPlaybackLog from './playbackLog'

let isFirstPush = true
const handlePushedHomeScreen = async() => {
  void import('@/core/download').then(async({ initDownloads }) => initDownloads()).catch(error => {
    console.warn('[Download] init failed:', error instanceof Error ? error.message : error)
  })
  await cheatTip()
  if (settingState.setting['common.isAgreePact']) {
    if (isFirstPush) {
      isFirstPush = false
      // 根据用户开关检查本仓库已成功发布的更新。
      if (settingState.setting['version.autoCheckUpdate']) void checkUpdate()
      void initDeeplink()
    }
  } else {
    if (isFirstPush) isFirstPush = false
    showPactModal()
  }
}

let isInited = false
export default async() => {
  if (isInited) return handlePushedHomeScreen
  bootLog('Initing...')
  commonActions.setFontSize(global.lx.fontSize)
  bootLog('Font size changed.')
  const setting = await initSetting()
  initPlaybackLog(setting)
  bootLog('Setting inited.')
  // console.log(setting)

  await initTheme(setting)
  bootLog('Theme inited.')
  await initI18n(setting)
  bootLog('I18n inited.')

  await initUserApi(setting)
  bootLog('User Api inited.')

  setApiSource(setting['common.apiSource'])
  bootLog('Api inited.')

  registerPlaybackService()
  bootLog('Playback Service Registered.')
  await initPlayer(setting)
  bootLog('Player inited.')
  await dataInit(setting)
  bootLog('Data inited.')
  await initCommonState(setting)
  bootLog('Common State inited.')

  // 首次运行保存更新渠道选择；本地初始化不阻塞首页。
  void initializeVersion().catch(() => {})

  isInited ||= true

  return handlePushedHomeScreen
}
