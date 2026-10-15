import { hideDesktopLyric } from './desktopLyric'
import { exitApp as utilExitApp } from '@/utils/nativeModules/utils'
import { destroy as destroyPlayer } from '@/plugins/player/utils'
import { initSetting as initAppSetting } from '@/config/setting'
import { setLanguage as applyLanguage } from '@/lang/i18n'

import settingActions from '@/store/setting/action'
import settingState from '@/store/setting/state'
import commonActions from '@/store/common/action'
import commonState, { type InitState as CommonStateType } from '@/store/common/state'

import { storageDataPrefix, type NAV_ID_Type } from '@/config/constant'
import { saveData } from '@/plugins/storage'
import { throttle } from '@/utils/common'
import { getSelectedManagedFolder, saveFontSize, saveViewPrevState, setSelectedManagedFolder } from '@/utils/data'
import { showPactModal as handleShowPactModal } from '@/navigation'
import { hideDesktopLyricView } from '@/utils/nativeModules/lyricDesktop'
import { getPersistedUriList, selectManagedFolder } from '@/utils/fs'


const throttleSaveSetting = throttle(() => {
  void saveData(storageDataPrefix.setting, settingState.setting)
})

/**
 * 初始化设置
 */
export const initSetting = async() => {
  const setting = (await initAppSetting()).setting
  settingActions.updateSetting(setting)
  return setting
}

/**
 * 更新设置
 * @param setting 新设置
 */
export const updateSetting = (setting: Partial<LX.AppSetting>) => {
  settingActions.updateSetting(setting)
  throttleSaveSetting()
}

export const setLanguage = (locale: Parameters<typeof applyLanguage>[0]) => {
  updateSetting({ 'common.langId': locale })
  global.state_event.languageChanged(locale)
  requestAnimationFrame(() => {
    applyLanguage(locale)
  })
}


let isDestroying = false
export const exitApp = (reason: string) => {
  console.log('Handle Exit App, Reason: ' + reason)
  if (isDestroying) return
  isDestroying = true
  void Promise.all([
    hideDesktopLyric(),
    destroyPlayer(),
    hideDesktopLyricView(),
  ]).finally(() => {
    isDestroying = false
    utilExitApp()
  })
}

export const setFontSize = (size: number) => {
  commonActions.setFontSize(size)
  void saveFontSize(size)
}

export const setStatusbarHeight = (size: number) => {
  commonActions.setStatusbarHeight(size)
}

export const setComponentId = (name: keyof CommonStateType['componentIds'], id: string) => {
  commonActions.setComponentId(name, id)
}
export const removeComponentId = (name: string) => {
  commonActions.removeComponentId(name)
}

// 底部导航只剩这两个 tab，页面上也只有它们。旧版本会把 nav_search / nav_setting 这类
// id 存进 viewPrevState，启动时原样恢复会让两个 tab 同时失去选中态，所以入口统一折回
// 「首页」。设置页改成推入式页面后不再占 nav id，原来对 nav_setting 的特判也一并去掉。
const TAB_NAV_IDS = new Set<NAV_ID_Type>(['nav_home', 'nav_mine'])

export const setNavActiveId = (id: Parameters<typeof commonActions.setNavActiveId>['0']) => {
  const nextId = TAB_NAV_IDS.has(id) ? id : 'nav_home'
  if (nextId == commonState.navActiveId) return
  commonActions.setNavActiveId(nextId)
  saveViewPrevState({ id: nextId })
}

export const showPactModal = () => {
  handleShowPactModal()
}

export const checkStoragePermissions = async() => {
  const selectedManagedFolder = await getSelectedManagedFolder()
  if (selectedManagedFolder) return (await getPersistedUriList()).some(uri => selectedManagedFolder.startsWith(uri))
  return false
}

export const requestStoragePermission = async() => {
  const isGranted = await checkStoragePermissions()
  if (isGranted) return isGranted

  const uri = await selectManagedFolder()
  if (!uri.isDirectory) return false
  await setSelectedManagedFolder(uri.path)
  return true
}

export const setBgPic = (pic: string | null) => {
  commonActions.setBgPic(pic)
}
