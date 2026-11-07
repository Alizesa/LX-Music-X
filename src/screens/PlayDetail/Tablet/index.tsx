import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import Image from '@/components/common/Image'
import Text from '@/components/common/Text'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { pop } from '@/navigation'
import { useStatusbarHeight } from '@/store/common/hook'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { useWindowSize } from '@/utils/hooks'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { screenkeepAwake, screenUnkeepAwake } from '@/utils/nativeModules/utils'
import SettingPopup, { type SettingPopupType } from '../components/SettingPopup'
import Lyric from '../Horizontal/Lyric'
import Player from '../Vertical/Player'
import Btn, { HEADER_HEIGHT } from '../Vertical/components/Btn'
import TimeoutExitBtn from '../Vertical/components/TimeoutExitBtn'

const Artwork = memo(() => {
  const { pic } = usePlayerMusicInfo()
  const windowSize = useWindowSize()
  const [bounds, setBounds] = useState<{ width: number, height: number } | null>(null)
  const handleLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setBounds(previous => previous?.width === layout.width && previous.height === layout.height
      ? previous
      : { width: layout.width, height: layout.height })
  }, [])
  // 按实际剩余空间缩放，让封面为标题和播放控件留出空间。
  const size = Math.max(0, Math.floor(Math.min(440,
    bounds?.width ?? windowSize.width * 0.32,
    bounds?.height ?? windowSize.height * 0.45,
  )))

  return (
    <View style={styles.artwork} onLayout={handleLayout}>
      <Image url={pic} nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_pic} style={{ width: size, height: size, borderRadius: 8 }} />
    </View>
  )
})

/** 平板横屏：左侧封面、歌曲信息和完整播放控制，右侧独立滚动歌词。 */
export default memo(({ componentId }: { componentId: string }) => {
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const statusBarHeight = useStatusbarHeight()
  const visible = useScreenVisible()
  const popupRef = useRef<SettingPopupType>(null)

  useEffect(() => {
    if (!visible) return
    screenkeepAwake()
    return () => { screenUnkeepAwake() }
  }, [visible])

  const back = () => { void pop(componentId) }
  const showSetting = () => { popupRef.current?.show() }

  return (
    <View style={[styles.container, { paddingTop: statusBarHeight }]}>
      <View style={[styles.header, { height: HEADER_HEIGHT }]} nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_header}>
        <Btn icon="chevron-left" onPress={back} />
        <View style={styles.headerSpace} />
        <TimeoutExitBtn />
        <Btn icon="slider" onPress={showSetting} />
      </View>
      <View style={styles.panes}>
        <View style={styles.leftPane}>
          <View style={styles.leftContent}>
            <Artwork />
            <View style={styles.trackInfo}>
              <Text style={styles.title} size={23} numberOfLines={2}>{musicInfo.name}</Text>
              <Text style={styles.singer} size={14} color={theme['c-font-label']} numberOfLines={1}>{musicInfo.singer}</Text>
            </View>
            <Player />
          </View>
        </View>
        <View style={styles.rightPane}>
          <Lyric />
        </View>
      </View>
      <SettingPopup ref={popupRef} direction="horizontal" position="right" />
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerSpace: {
    flex: 1,
  },
  panes: {
    flex: 1,
    flexDirection: 'row',
    paddingHorizontal: '4%',
    paddingTop: 12,
    paddingBottom: 12,
  },
  leftPane: {
    width: '46%',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  leftContent: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
  },
  artwork: {
    flex: 1,
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    overflow: 'hidden',
  },
  trackInfo: {
    flexShrink: 0,
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  title: {
    fontWeight: '600',
  },
  singer: {
    marginTop: 10,
  },
  rightPane: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 24,
    paddingRight: 12,
    position: 'relative',
  },
})
