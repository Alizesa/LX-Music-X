import { useCallback, useEffect, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import SwipePager, { type SwipePagerType } from '@/components/SwipePager'
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
  const pagerRef = useRef<SwipePagerType>(null)
  const [activeId, setActiveId] = useState<TabId>('song')
  const [singerInfo, setSingerInfo] = useState<SingerInfo | null>(null)
  // 没露过面的 tab 不挂载，进页面就只发歌手信息那一条请求
  const [mounted, setMounted] = useState<Record<TabId, boolean>>({ song: true, album: false })

  useEffect(() => {
    setComponentId(COMPONENT_IDS.singerDetail, componentId)
  }, [componentId])

  const markMounted = useCallback((id: TabId) => {
    setMounted(current => current[id] ? current : { ...current, [id]: true })
  }, [])

  const toggleTab = useCallback((id: TabId) => {
    markMounted(id)
    setActiveId(id)
    pagerRef.current?.setPage(TABS.indexOf(id))
  }, [markMounted])
  const handlePageChange = useCallback((index: number) => {
    const id = TABS[index]
    if (id) setActiveId(id)
  }, [])
  // 手指刚往旁边滑就把那一页挂出来，滑到位时内容已经在了，不会先白一下
  const handleReveal = useCallback((index: number) => {
    const id = TABS[index]
    if (id) markMounted(id)
  }, [markMounted])

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
      <SwipePager
        ref={pagerRef}
        pageCount={TABS.length}
        onPageChange={handlePageChange}
        onReveal={handleReveal}
      >
        <View style={styles.page}>
          <SingerSongs mid={info.mid} onInfoLoaded={setSingerInfo} />
        </View>
        <View style={styles.page}>
          { mounted.album ? <SingerAlbums mid={info.mid} /> : null }
        </View>
      </SwipePager>
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
  page: {
    flex: 1,
    overflow: 'hidden',
  },
})
