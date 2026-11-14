import { memo, useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { View, TouchableOpacity } from 'react-native'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'
import Header from './components/Header'
import { Icon } from '@/components/common/Icon'
import CommentList from './CommentList'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { COMPONENT_IDS } from '@/config/constant'
import { setComponentId } from '@/core/common'
import PageContent from '@/components/PageContent'
import playerState from '@/store/player/state'
import { scaleSizeH } from '@/utils/pixelRatio'
import { BorderWidths } from '@/theme'

type ActiveId = 'hot' | 'new'

const BAR_HEIGHT = scaleSizeH(34)

const HeaderItem = ({ id, label, isActive, onPress }: {
  id: ActiveId
  label: string
  isActive: boolean
  onPress: (id: ActiveId) => void
}) => {
  const theme = useTheme()
  // console.log(theme)
  const components = useMemo(() => (
    <TouchableOpacity style={styles.tabBtn} onPress={() => { !isActive && onPress(id) }}>
      <Text color={isActive ? theme['c-primary-font-active'] : theme['c-font']}>{label}</Text>
    </TouchableOpacity>
  ), [isActive, theme, label, onPress, id])

  return components
}

const TABS = [
  'hot',
  'new',
] as const
const getMusicInfo = (musicInfo: LX.Player.PlayMusic | null) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
}
export default memo(({ componentId }: {
  componentId: string
}) => {
  const pagerViewRef = useRef<PagerView>(null)
  const visible = useScreenVisible()
  const [activeId, setActiveId] = useState<ActiveId>('hot')
  const [musicInfo, setMusicInfo] = useState<LX.Music.MusicInfo | null>(getMusicInfo(playerState.playMusicInfo.musicInfo))
  const t = useI18n()
  const theme = useTheme()
  const [total, setTotal] = useState({ hot: 0, new: 0 })

  useEffect(() => {
    setComponentId(COMPONENT_IDS.comment, componentId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tabs = useMemo(() => {
    return [
      { id: TABS[0], label: t('comment_tab_hot', { total: total.hot ? `(${total.hot})` : '' }) },
      { id: TABS[1], label: t('comment_tab_new', { total: total.new ? `(${total.new})` : '' }) },
    ] as const
  }, [total, t])

  const toggleTab = useCallback((id: ActiveId) => {
    setActiveId(id)
    pagerViewRef.current?.setPage(TABS.findIndex(tab => tab == id))
  }, [])

  const onPageSelected = useCallback(({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    setActiveId(TABS[nativeEvent.position])
  }, [])

  const refreshComment = useCallback(() => {
    if (!playerState.playMusicInfo.musicInfo) return
    let playerMusicInfo = playerState.playMusicInfo.musicInfo
    if ('progress' in playerMusicInfo) playerMusicInfo = playerMusicInfo.metadata.musicInfo

    if (musicInfo && musicInfo.id == playerMusicInfo.id) {
      toast(t('comment_refresh', { name: musicInfo.name }))
      return
    }
    setMusicInfo(playerMusicInfo)
    setTotal({ hot: 0, new: 0 })
  }, [musicInfo, t])

  const setHotTotal = useCallback((total: number) => {
    setTotal(totalInfo => ({ ...totalInfo, hot: total }))
  }, [])
  const setNewTotal = useCallback((total: number) => {
    setTotal(totalInfo => ({ ...totalInfo, new: total }))
  }, [])

  const commentComponent = useMemo(() => {
    return (
      <View style={styles.container}>
        <View style={{ ...styles.tabHeader, borderBottomColor: theme['c-border-background'], height: BAR_HEIGHT }}>
          <View style={styles.left}>
            {tabs.map(({ id, label }) => <HeaderItem id={id} label={label} key={id} isActive={activeId == id} onPress={toggleTab} />)}
          </View>
          <View>
            <TouchableOpacity onPress={refreshComment} style={{ ...styles.btn, width: BAR_HEIGHT }}>
              <Icon name="available_updates" size={20} color={theme['c-600']} />
            </TouchableOpacity>
          </View>
        </View>
        <PagerView
          ref={pagerViewRef}
          onPageSelected={onPageSelected}
          // onPageScrollStateChanged={onPageScrollStateChanged}
          style={styles.pagerView}
        >
          <View collapsable={false} style={styles.pageStyle}>
            {visible && activeId === 'hot' && <CommentList type="hot" musicInfo={musicInfo as LX.Music.MusicInfoOnline} onUpdateTotal={setHotTotal} />}
          </View>
          <View collapsable={false} style={styles.pageStyle}>
            {visible && activeId === 'new' && <CommentList type="new" musicInfo={musicInfo as LX.Music.MusicInfoOnline} onUpdateTotal={setNewTotal} />}
          </View>
        </PagerView>
      </View>
    )
  }, [activeId, musicInfo, onPageSelected, refreshComment, setHotTotal, setNewTotal, tabs, theme, toggleTab, visible])

  return (
    <PageContent>
      {
        musicInfo == null
          ? null
          : <>
            <Header musicInfo={musicInfo} />
            {
              musicInfo.source == 'local'
                ? (
                <View style={{ ...styles.container, alignItems: 'center', justifyContent: 'center' }}>
                  <Text>{t('comment_not support')}</Text>
                </View>
                  )
                : commentComponent
            }
        </>
      }

    </PageContent>
  )
})

const styles = createStyle({
  container: {
    flex: 1,
  },
  tabHeader: {
    flexDirection: 'row',
    // paddingLeft: 10,
    paddingRight: 10,
    // justifyContent: 'center',
    borderBottomWidth: BorderWidths.normal,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    paddingLeft: 5,
  },
  tabBtn: {
    // flex: 1,
    paddingLeft: 10,
    paddingRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  btn: {
    // flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  pagerView: {
    flex: 1,
  },
  pageStyle: {
    overflow: 'hidden',
  },
})
