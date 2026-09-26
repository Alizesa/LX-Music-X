import { useCallback, useEffect, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'
import PagerView, { type PagerViewOnPageSelectedEvent } from 'react-native-pager-view'

import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import Text from '@/components/common/Text'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { BorderWidths } from '@/theme'
import { type SingerDetailParams, type SingerInfo } from '@/store/singer/state'
import Header from './Header'
import SingerSongs from './SingerSongs'
import SingerAlbums from './SingerAlbums'

const TABS = ['song', 'album'] as const
type TabId = typeof TABS[number]

const BAR_HEIGHT = scaleSizeH(38)

export default ({ componentId, info }: { componentId: string, info: SingerDetailParams }) => {
  const t = useI18n()
  const theme = useTheme()
  const pagerViewRef = useRef<PagerView>(null)
  const [activeId, setActiveId] = useState<TabId>('song')
  const [singerInfo, setSingerInfo] = useState<SingerInfo | null>(null)
  // 没打开过的 tab 不挂载，进页面就只发歌手信息那一条请求
  const initedRef = useRef<Record<TabId, boolean>>({ song: true, album: false })

  useEffect(() => {
    setComponentId(COMPONENT_IDS.singerDetail, componentId)
  }, [componentId])

  const toggleTab = useCallback((id: TabId) => {
    setActiveId(id)
    pagerViewRef.current?.setPage(TABS.findIndex(tab => tab == id))
  }, [])
  const onPageSelected = useCallback(({ nativeEvent }: PagerViewOnPageSelectedEvent) => {
    const id = TABS[nativeEvent.position]
    if (!id) return
    initedRef.current[id] = true
    setActiveId(id)
  }, [])

  return (
    <PageContent>
      <StatusBar />
      <Header params={info} info={singerInfo} />
      <View style={{ ...styles.tabBar, height: BAR_HEIGHT, borderBottomColor: theme['c-border-background'] }}>
        {
          TABS.map(id => (
            <TouchableOpacity key={id} style={styles.tabBtn} onPress={() => { if (id != activeId) toggleTab(id) }}>
              <Text
                style={{ ...styles.tabText, borderBottomColor: id == activeId ? theme['c-primary-background-active'] : 'transparent' }}
                color={id == activeId ? theme['c-primary-font-active'] : theme['c-font']}
              >{t(`singer_tab_${id}`)}</Text>
            </TouchableOpacity>
          ))
        }
      </View>
      <PagerView ref={pagerViewRef} onPageSelected={onPageSelected} style={styles.pagerView}>
        <View collapsable={false} style={styles.pageStyle}>
          <SingerSongs mid={info.mid} onInfoLoaded={setSingerInfo} />
        </View>
        <View collapsable={false} style={styles.pageStyle}>
          { initedRef.current.album ? <SingerAlbums mid={info.mid} /> : null }
        </View>
      </PagerView>
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  tabBar: {
    flexDirection: 'row',
    flexGrow: 0,
    flexShrink: 0,
    paddingLeft: 10,
    borderBottomWidth: BorderWidths.normal,
  },
  tabBtn: {
    paddingLeft: 10,
    paddingRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  tabText: {
    paddingTop: 3,
    paddingBottom: 3,
    textAlign: 'center',
    borderBottomWidth: BorderWidths.normal3,
  },
  pagerView: {
    flex: 1,
  },
  pageStyle: {
    overflow: 'hidden',
  },
})
