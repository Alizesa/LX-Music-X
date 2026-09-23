import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import Image from '@/components/common/Image'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import PlayerBar from '@/components/player/PlayerBar'
import { pop } from '@/navigation'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS, LIST_IDS } from '@/config/constant'
import commonState from '@/store/common/state'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { getQQMusicDailyRecommendations, getQQMusicSession } from '@/core/qqMusic'
import { getQQMusicDailyRecommendCache, saveQQMusicDailyRecommendCache } from '@/utils/data'
import { RECOMMEND_TEMP_LIST_ID, initQQMusicRecommendAutoRefresh } from '@/core/qqMusicRecommend'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'

const HEADER_HEIGHT = 50

export default ({ componentId }: { componentId: string }) => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()
  const [list, setList] = useState<LX.Music.MusicInfoOnline[]>([])
  const [loading, setLoading] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const initedRef = useRef(false)
  // setLoading 要到下次渲染才生效，挡不住同一个窗口内的第二次触发，会造成并发请求
  const loadingRef = useRef(false)

  const load = useCallback(async() => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const session = await getQQMusicSession()
      setLoggedIn(!!session.cookie)
      if (!session.cookie) return
      const songs = await getQQMusicDailyRecommendations(session.cookie)
      setList(songs)
      await saveQQMusicDailyRecommendCache(songs)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // 守卫要同步置位：放进异步回调里的话，effect 重跑时上一次的读取可能还没返回，
    // 两次都会通过检查，白白多发一个请求
    if (initedRef.current) return
    initedRef.current = true

    setComponentId(COMPONENT_IDS.qqMusicDailyRec, componentId)
    void getQQMusicDailyRecommendCache()
      .catch(() => [])
      .then(cache => {
        if (cache.length) {
          // 进页面只读缓存，一次请求都不发（和 QQ 音乐页同一条规矩）
          setList(cache)
          void getQQMusicSession().then(session => { setLoggedIn(!!session.cookie) })
          return
        }
        void load()
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const playFrom = useCallback((index: number) => {
    // 和首页、QQ 音乐页共用同一个临时列表 id，播到结尾时才会自动续下一批
    void setTempList(RECOMMEND_TEMP_LIST_ID, list).then(() => {
      initQQMusicRecommendAutoRefresh()
      void playList(LIST_IDS.TEMP, index)
    })
  }, [list])

  const back = () => {
    void pop(commonState.componentIds.qqMusicDailyRec!)
  }

  const renderItem = ({ item, index }: { item: LX.Music.MusicInfoOnline, index: number }) => (
    <TouchableOpacity style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }} onPress={() => { playFrom(index) }}>
      <Image url={item.meta.picUrl} style={styles.cover} />
      <View style={styles.info}>
        <Text numberOfLines={1}>{item.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{item.singer} - {item.meta.albumName}</Text>
      </View>
    </TouchableOpacity>
  )

  const emptyText = loading ? t('qq_loading') : loggedIn ? t('home_empty_recommend') : t('qq_login_hint')

  return (
    <PageContent>
      <StatusBar />
      <View style={{ height: HEADER_HEIGHT + statusBarHeight, paddingTop: statusBarHeight, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: theme['c-border-background'] }}>
        <TouchableOpacity onPress={back} style={styles.backButton}>
          <Icon name="chevron-left" size={24} color={theme['c-font']} />
        </TouchableOpacity>
        <Text style={styles.title} size={18}>{t('qq_daily_recommend')}</Text>
        <TouchableOpacity onPress={() => { void load() }} disabled={loading} style={styles.refreshButton}>
          <Text color={loading ? theme['c-font-label'] : theme['c-primary-font']}>{t('qq_refresh')}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={list}
        keyExtractor={item => item.id}
        style={styles.list}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { void load() }} colors={[theme['c-primary']]} />}
        ListHeaderComponent={list.length
          ? (
              <TouchableOpacity style={{ ...styles.playAll, borderBottomColor: theme['c-border-background'] }} onPress={() => { playFrom(0) }}>
                <Icon name="play-outline" size={20} color={theme['c-primary']} />
                <Text color={theme['c-primary']} style={styles.playAllText}>{t('play_all')}</Text>
                <Text size={12} color={theme['c-font-label']}>{list.length} {t('qq_songs')}</Text>
              </TouchableOpacity>
            )
          : null}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{emptyText}</Text>}
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  backButton: { width: 50, alignItems: 'center' },
  title: { flex: 1 },
  refreshButton: { paddingHorizontal: 14, paddingVertical: 8 },
  list: { flex: 1 },
  playAll: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, gap: 8 },
  playAllText: { flex: 1, fontWeight: '700' },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1 },
  cover: { width: 48, height: 48, borderRadius: 4 },
  info: { flex: 1, paddingLeft: 12 },
  empty: { textAlign: 'center', paddingVertical: 40 },
})
