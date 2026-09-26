import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'
import { FlatList, Platform, RefreshControl, TouchableOpacity, View, type FlatListProps } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useLayout } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { type AlbumItem } from '@/store/singer/state'

const MIN_WIDTH = scaleSizeW(110)
const GAP = scaleSizeW(20)

export type Status = 'loading' | 'refreshing' | 'end' | 'error' | 'idle'

export interface AlbumListProps {
  onRefresh: () => void
  onLoadMore: () => void
  onOpenDetail: (item: AlbumItem, index: number) => void
}

export interface AlbumListType {
  setList: (list: AlbumItem[]) => void
  setStatus: (val: Status) => void
}

export default forwardRef<AlbumListType, AlbumListProps>(({ onRefresh, onLoadMore, onOpenDetail }, ref) => {
  const [currentList, setList] = useState<AlbumItem[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const { onLayout, width } = useLayout()
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    setList(list) {
      setList(list)
    },
    setStatus(val) {
      setStatus(val)
    },
  }))

  const handleLoadMore = () => {
    if (status != 'idle') return
    onLoadMore()
  }

  const rowInfo = useMemo(() => {
    const w = width - GAP
    let n = width / (MIN_WIDTH + GAP)
    if (n > 10) n = 10
    const itemWidth = Math.floor(w / n)
    const num = Math.max(Math.floor(width / itemWidth), 2)
    return {
      num,
      width: (width - GAP) / num,
    }
  }, [width])

  // 末行补齐占位项，保证最后一行的卡片宽度一致
  const list = useMemo(() => {
    const list = [...currentList]
    let whiteItemNum = list.length % rowInfo.num
    if (whiteItemNum > 0) whiteItemNum = rowInfo.num - whiteItemNum
    for (let i = 0; i < whiteItemNum; i++) {
      list.push({ id: `white__${i}`, mid: '', name: '', author: '', img: '', publishDate: '', albumType: '', source: 'tx' })
    }
    return list
  }, [currentList, rowInfo])

  const refreshControl = useMemo(() => (
    <RefreshControl
      colors={[theme['c-primary']]}
      refreshing={status == 'refreshing'}
      onRefresh={onRefresh} />
  ), [status, onRefresh, theme])

  const footerComponent = useMemo(() => <Footer status={status} onLoadMore={onLoadMore} />, [status, onLoadMore])

  const renderItem: FlatListProps<AlbumItem>['renderItem'] = ({ item, index }) => {
    if (!item.mid) return <View style={{ ...styles.item, width: rowInfo.width - GAP }} />
    return <AlbumItemCard item={item} index={index} width={rowInfo.width - GAP} onPress={onOpenDetail} />
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      {
        width == 0
          ? null
          : (
            <FlatList
              key={String(rowInfo.num)}
              style={styles.list}
              columnWrapperStyle={{ justifyContent: 'space-evenly' }}
              numColumns={rowInfo.num}
              data={list}
              maxToRenderPerBatch={4}
              windowSize={8}
              removeClippedSubviews={true}
              renderItem={renderItem}
              keyExtractor={item => item.id}
              onEndReachedThreshold={0.6}
              onEndReached={handleLoadMore}
              refreshControl={refreshControl}
              ListFooterComponent={footerComponent}
            />
            )
      }
    </View>
  )
})

const AlbumItemCard = ({ item, index, width, onPress }: {
  item: AlbumItem
  index: number
  width: number
  onPress: (item: AlbumItem, index: number) => void
}) => {
  const theme = useTheme()
  const handlePress = () => {
    onPress(item, index)
  }
  return (
    <View style={{ ...styles.item, width }}>
      <TouchableOpacity activeOpacity={0.5} onPress={handlePress} style={{ ...styles.imgWrapper, backgroundColor: theme['c-content-background'] }}>
        <Image
          url={item.img}
          nativeID={`${NAV_SHEAR_NATIVE_IDS.albumDetail_pic}_from_${item.id}`}
          style={{ width, height: width, borderRadius: 4 }}
        />
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.5} onPress={handlePress}>
        <Text style={styles.title} numberOfLines={2}>{item.name}</Text>
        <Text style={styles.date} size={11} color={theme['c-font-label']} numberOfLines={1}>{item.publishDate}</Text>
      </TouchableOpacity>
    </View>
  )
}

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
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  list: {
    flex: 1,
    paddingLeft: 10,
    paddingRight: 10,
  },
  item: {
    margin: 10,
  },
  imgWrapper: {
    borderRadius: 4,
    marginBottom: 5,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.20,
        shadowRadius: 1.41,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  title: {
    fontSize: 12,
    marginBottom: 2,
  },
  date: {
    marginBottom: 5,
  },
  footer: {
    textAlign: 'center',
    padding: 10,
  },
})
