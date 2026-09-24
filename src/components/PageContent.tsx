// import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import ImageBackground from '@/components/common/ImageBackground'
import { useWindowSize } from '@/utils/hooks'
import { useMemo } from 'react'
import { scaleSizeAbsHR } from '@/utils/pixelRatio'
import { defaultHeaders } from './common/Image'
import SizeView from './SizeView'
import { useBgPic } from '@/store/common/hook'
import { useSettingValue } from '@/store/setting/hook'

interface Props {
  children: React.ReactNode
}

const BLUR_RADIUS = Math.max(scaleSizeAbsHR(18), 10)

// 本地图片路径要补上 file:// 才能给 Image 用
const toFileUri = (path: string) => path.startsWith('/') ? `file://${path}` : path

export default ({ children }: Props) => {
  const theme = useTheme()
  const windowSize = useWindowSize()
  const pic = useBgPic()
  const customBgImage = useSettingValue('theme.customBgImage')
  const bgOpacity = useSettingValue('theme.bgOpacity')
  const hideBgDark = useSettingValue('theme.hideBgDark')
  // 和主题自带背景一样，深色主题勾了「隐藏黑色主题背景」时自定义背景也一起隐藏
  const customBgUri = customBgImage && !(theme.isDark && hideBgDark) ? toFileUri(customBgImage) : ''

  const themeComponent = useMemo(() => (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <ImageBackground
        style={{ position: 'absolute', left: 0, top: 0, height: windowSize.height, width: windowSize.width, backgroundColor: theme['c-content-background'] }}
        source={theme['bg-image']}
        resizeMode="cover"
      >
      </ImageBackground>
      <View style={{ flex: 1, flexDirection: 'column', backgroundColor: theme['c-main-background'] }}>
        {children}
      </View>
    </View>
  ), [children, theme, windowSize.height, windowSize.width])

  const picComponent = useMemo(() => {
    // 自定义背景优先，其次是动态背景（播放封面）
    const uri = customBgUri || pic
    if (!uri) return null
    const isCustom = !!customBgUri
    return (
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <ImageBackground
          style={{ position: 'absolute', left: 0, top: 0, height: windowSize.height, width: windowSize.width, backgroundColor: theme['c-content-background'] }}
          // 自定义背景是本地文件，不需要请求头；动态背景是网络图，带上它
          source={isCustom ? { uri } : { uri, headers: defaultHeaders }}
          // cover = 等比铺满，图片比例与屏幕不合适时从中心裁掉超出部分，不拉伸
          resizeMode="cover"
          // 播放封面模糊是为了压住花纹好压字；用户自己选的壁纸原样显示
          blurRadius={isCustom ? 0 : BLUR_RADIUS}
        >
          <View style={{ flex: 1, flexDirection: 'column', backgroundColor: theme['c-content-background'], opacity: bgOpacity }}></View>
        </ImageBackground>
        <View style={{ flex: 1, flexDirection: 'column' }}>
          {children}
        </View>
      </View>
    )
  }, [bgOpacity, children, customBgUri, pic, theme, windowSize.height, windowSize.width])

  return (
    <>
      <SizeView />
      {picComponent ?? themeComponent}
    </>
  )
}
