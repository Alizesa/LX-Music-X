import { Platform, UIManager, View, requireNativeComponent, type ViewProps } from 'react-native'

const NAME = 'LXHorizontalScrollHost'

export const hasNativeHorizontalScrollHost = Platform.OS === 'android' && UIManager.getViewManagerConfig(NAME) != null

// 原生手势保护需要新版 APK；旧 APK 加载开发 JS 时继续使用原有的 JS 手势锁。
export default hasNativeHorizontalScrollHost
  ? requireNativeComponent<ViewProps>(NAME)
  : View
