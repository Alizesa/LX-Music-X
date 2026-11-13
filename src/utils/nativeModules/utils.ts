import { AppState, NativeEventEmitter, NativeModules } from 'react-native'

const { UtilsModule } = NativeModules

export const supportsScrollAnimationCancellation = typeof UtilsModule.stopScrollAnimation === 'function'

export const stopScrollAnimation = async(viewTag: number): Promise<void> => {
  if (!supportsScrollAnimationCancellation) return
  return UtilsModule.stopScrollAnimation(viewTag) as Promise<void>
}

export const exitApp = UtilsModule.exitApp

export const getSupportedAbis = UtilsModule.getSupportedAbis as () => Promise<string[]>

export interface InstalledAppInfo {
  version: string
  versionCode: number
}

export const getInstalledAppInfo = async(): Promise<InstalledAppInfo> => {
  // An old APK can run a newer development bundle without this native method.
  // Its actual ABI version code cannot safely be inferred from package.json.
  if (typeof UtilsModule.getInstalledAppInfo !== 'function') throw new Error('Installed app version information is unavailable')
  return UtilsModule.getInstalledAppInfo() as Promise<InstalledAppInfo>
}

export const installApk = async(filePath: string, fileProviderAuthority: string): Promise<void> => UtilsModule.installApk(filePath, fileProviderAuthority) as Promise<void>


export const screenkeepAwake = () => {
  if (global.lx.isScreenKeepAwake) return
  global.lx.isScreenKeepAwake = true
  UtilsModule.screenkeepAwake()
}
export const screenUnkeepAwake = () => {
  // console.log('screenUnkeepAwake')
  if (!global.lx.isScreenKeepAwake) return
  global.lx.isScreenKeepAwake = false
  UtilsModule.screenUnkeepAwake()
}

export const isNotificationsEnabled = UtilsModule.isNotificationsEnabled as () => Promise<boolean>

export const requestNotificationPermission = async() => new Promise<boolean>((resolve) => {
  let subscription = AppState.addEventListener('change', (state) => {
    if (state != 'active') return
    subscription.remove()
    setTimeout(() => {
      void isNotificationsEnabled().then(resolve)
    }, 1000)
  })
  UtilsModule.openNotificationPermissionActivity().then((result: boolean) => {
    if (result) return
    subscription.remove()
    resolve(false)
  })
})

export const shareText = async(shareTitle: string, title: string, text: string): Promise<void> => {
  UtilsModule.shareText(shareTitle, title, text)
}

export const getSystemLocales = async(): Promise<string> => {
  return UtilsModule.getSystemLocales()
}

/** Android onTrimMemory 的内存压力信号；level 见 ComponentCallbacks2 */
export const onMemoryPressure = (handler: (level: number) => void): () => void => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventEmitter = new NativeEventEmitter(UtilsModule)
  const eventListener = eventEmitter.addListener('memory-pressure', event => {
    handler(event.level as number)
  })

  return () => {
    eventListener.remove()
  }
}

export const onScreenStateChange = (handler: (state: 'ON' | 'OFF') => void): () => void => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const eventEmitter = new NativeEventEmitter(UtilsModule)
  const eventListener = eventEmitter.addListener('screen-state', event => {
    handler(event.state as 'ON' | 'OFF')
  })

  return () => {
    eventListener.remove()
  }
}

export const getWindowSize = async(): Promise<{ width: number, height: number }> => {
  return UtilsModule.getWindowSize()
}

export const isIgnoringBatteryOptimization = async(): Promise<boolean> => {
  return UtilsModule.isIgnoringBatteryOptimization()
}

export const requestIgnoreBatteryOptimization = async() => new Promise<boolean>((resolve) => {
  let subscription = AppState.addEventListener('change', (state) => {
    if (state != 'active') return
    subscription.remove()
    setTimeout(() => {
      void isIgnoringBatteryOptimization().then(resolve)
    }, 1000)
  })
  UtilsModule.requestIgnoreBatteryOptimization().then((result: boolean) => {
    if (result) return
    subscription.remove()
    resolve(false)
  })
})
