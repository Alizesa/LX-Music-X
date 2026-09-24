import { memo, useCallback, useState } from 'react'
import { View, StyleSheet, TouchableOpacity } from 'react-native'

import Progress, { ProgressPlain } from '@/components/player/Progress'
import Status from './Status'
import { useProgress, usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { COMPONENT_IDS } from '@/config/constant'
import { usePageVisible } from '@/store/common/hook'
import { scaleSizeH, scaleSizeW, scaleSizeWR } from '@/utils/pixelRatio'
import { useBufferProgress } from '@/plugins/player'
import { useSettingValue } from '@/store/setting/hook'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'

const FONT_SIZE = 13
const PADDING_TOP_RAW = 1.8
const PADDING_TOP = Math.round(scaleSizeWR(PADDING_TOP_RAW))
const MARGIN_TOP = Math.round(scaleSizeH(2))
const PADDING_TOP_PROGRESS = PADDING_TOP + MARGIN_TOP

const PlayTimeCurrent = ({ timeStr }: { timeStr: string }) => {
  const theme = useTheme()
  // console.log(timeStr)
  return <Text size={FONT_SIZE} color={theme['c-500']}>{timeStr}</Text>
}

const PlayTimeMax = memo(({ timeStr }: { timeStr: string }) => {
  const theme = useTheme()
  return <Text size={FONT_SIZE} color={theme['c-500']}>{timeStr}</Text>
})

export default ({ isHome }: { isHome: boolean }) => {
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const [autoUpdate, setAutoUpdate] = useState(true)
  const { maxPlayTimeStr, nowPlayTimeStr, progress, maxPlayTime } = useProgress(autoUpdate)
  const buffered = useBufferProgress()
  const allowProgressBarSeek = useSettingValue('common.allowProgressBarSeek')

  usePageVisible([COMPONENT_IDS.home], useCallback((visible) => {
    if (isHome) setAutoUpdate(visible)
  }, [isHome]))

  // 关掉「允许通过底栏进度条调整播放进度」时，这一整行都可以点开播放详情。
  // 否则能点开的只有左边的封面和上面那行歌名，想从进度条这一带点开就会点空。
  const openPlayDetail = useCallback(() => {
    if (!musicInfo.id) return
    navigations.pushPlayDetailScreen(commonState.componentIds.home!)
  }, [musicInfo.id])

  const content = (
    <>
      {/* <MusicName /> */}
      <View style={styles.status}>
        <Status autoUpdate={autoUpdate} />
      </View>
      <View style={{ flexGrow: 0, flexShrink: 0, flexDirection: 'row', alignItems: 'flex-start' }} >
        <PlayTimeCurrent timeStr={nowPlayTimeStr} />
        <Text size={FONT_SIZE} color={theme['c-500']}> / </Text>
        <PlayTimeMax timeStr={maxPlayTimeStr} />
      </View>
      {/* 不拖动进度时把这层让出去，点击才会落到整行的 TouchableOpacity 上 */}
      <View style={[StyleSheet.absoluteFill, stylesRaw.progress]} pointerEvents={allowProgressBarSeek ? 'auto' : 'none'}>
        {
          allowProgressBarSeek
            ? <Progress progress={progress} duration={maxPlayTime} buffered={buffered} paddingTop={PADDING_TOP_PROGRESS} />
            : <ProgressPlain progress={progress} duration={maxPlayTime} buffered={buffered} paddingTop={PADDING_TOP_PROGRESS} />
        }
      </View>
    </>
  )

  return allowProgressBarSeek
    ? <View style={stylesRaw.container}>{content}</View>
    : <TouchableOpacity style={stylesRaw.container} activeOpacity={0.6} onPress={openPlayDetail}>{content}</TouchableOpacity>
}


const styles = createStyle({
  // container: {
  //   // height: 16,
  //   maxHeight: 32,
  //   flexGrow: 1,
  //   flexShrink: 0,
  //   // flexDirection: 'column',
  //   // justifyContent: 'center',
  //   // alignItems: 'center',
  //   // marginBottom: -1,
  //   // backgroundColor: '#ccc',
  //   // overflow: 'hidden',
  //   // height:
  //   // position: 'absolute',
  //   // width: '100%',
  //   // top: 0,
  //   paddingTop: PADDING_TOP_RAW,
  //   paddingHorizontal: 3,
  //   flexDirection: 'row',
  //   alignItems: 'center',
  //   justifyContent: 'space-between',
  // },
  status: {
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 5,
    // backgroundColor: '#ccc',
  },
})

const stylesRaw = StyleSheet.create({
  container: {
    // height: 16,
    maxHeight: scaleSizeH(32),
    flexGrow: 1,
    flexShrink: 0,
    paddingTop: PADDING_TOP,
    paddingHorizontal: scaleSizeW(3),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progress: {
    // paddingVertical: 2,
    marginBottom: MARGIN_TOP,
    zIndex: 100,
  },
})
