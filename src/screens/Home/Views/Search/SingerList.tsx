import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FlatList, RefreshControl, TouchableOpacity, View, type FlatListProps } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { formatPlayCount } from '@/utils'
import { navigations } from '@/navigation'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import commonState from '@/store/common/state'
import searchSingerState, { type SingerItem } from '@/store/search/singer/state'
import { search } from '@/core/search/singer'
import { type Source } from '@/store/search/music/state'

export type Status = 'loading' | 'refreshing' | 'end' | 'error' | 'idle'

export interface SingerListType {
  loadList: (text: string, source: Source) => void
}

const AVATAR_SIZE = scaleSizeW(48)

export default forwardRef<SingerListType, {}>((props, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const [list, setList] = useState<SingerItem[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const textRef = useRef('')
  const isUnmountedRef = useRef(false)

  const load = useCallback(async(page: number, isRefresh = false) => {
    try {
      const result = await search(textRef.current, page, isRefresh)
      // null：这次结果已经作废（关键词换了），列表归新的那次请求管
      if (result == null || isUnmountedRef.current) return
      setList([...result])
      setStatus(searchSingerState.listInfo.maxPage <= page ? 'end' : 'idle')
    } catch (err) {
      console.log(err)
      if (isUnmountedRef.current) return
      setStatus('error')
    }
  }, [])

  useImperativeHandle(ref, () => ({
    loadList(text) {
      // 歌手搜索只有 tx 源，source 参数用不上
      textRef.current = text
      setList([])
      if (!text) {
        setStatus('idle')
        return
      }
      setStatus('loading')
      void load(1)
    },
  }), [load])

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleRefresh = () => {
    setStatus('refreshing')
    void load(1, true)
  }
  const handleLoadMore = () => {
    if (status != 'idle') return
    setStatus('loading')
    void load(searchSingerState.listInfo.page + 1)
  }
  const handleOpenDetail = (item: SingerItem) => {
    navigations.pushSingerDetailScreen(commonState.componentIds.home!, {
      id: item.mid,
      mid: item.mid,
      name: item.name,
      picUrl: item.picUrl,
    })
  }

  const renderItem: FlatListProps<SingerItem>['renderItem'] = ({ item }) => (
    <TouchableOpacity
      activeOpacity={0.5}
      style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}
      onPress={() => { handleOpenDetail(item) }}
    >
      <Image
        url={item.picUrl}
        nativeID={`${NAV_SHEAR_NATIVE_IDS.singerDetail_pic}_from_${item.mid}`}
        style={{ ...styles.avatar, width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2 }}
      />
      <View style={styles.info}>
        <Text size={15} numberOfLines={1}>{item.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>
          {[
            t('singer_song_count', { num: formatPlayCount(item.songSize) }),
            t('singer_album_count', { num: formatPlayCount(item.albumSize) }),
          ].join('  ·  ')}
        </Text>
      </View>
    </TouchableOpacity>
  )

  const refreshControl = useMemo(() => (
    <RefreshControl
      colors={[theme['c-primary']]}
      refreshing={status == 'refreshing'}
      onRefresh={handleRefresh} />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [status, theme])

  return (
    <FlatList
      data={list}
      style={styles.list}
      keyExtractor={item => item.mid}
      renderItem={renderItem}
      onEndReachedThreshold={0.6}
      onEndReached={handleLoadMore}
      refreshControl={refreshControl}
      ListEmptyComponent={
        status == 'end' || status == 'idle'
          ? <Text style={styles.empty} color={theme['c-font-label']}>{t('no_item')}</Text>
          : null
      }
      ListFooterComponent={<Footer status={status} onLoadMore={handleLoadMore} />}
    />
  )
})

const Footer = ({ status, onLoadMore }: { status: Status, onLoadMore: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  let label: 'list_loading' | 'list_end' | 'list_error' | null
  switch (status) {
    case 'refreshing': return null
    case 'loading':
      label = 'list_loading'
      break
    case 'end':
      label = 'list_end'
      break
    case 'error':
      label = 'list_error'
      break
    case 'idle':
      label = null
      break
  }
  if (!label) return null
  return (
    <Text
      onPress={() => { if (label == 'list_error') onLoadMore() }}
      style={styles.footer}
      color={theme['c-font-label']}
    >{t(label)}</Text>
  )
}

const styles = createStyle({
  list: {
    flex: 1,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
  },
  avatar: {
    flexGrow: 0,
    flexShrink: 0,
    overflow: 'hidden',
  },
  info: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 10,
  },
  empty: {
    textAlign: 'center',
    paddingTop: 40,
  },
  footer: {
    textAlign: 'center',
    padding: 10,
  },
})
