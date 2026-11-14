import { useMemo } from 'react'
import { FlatList, type FlatListProps, RefreshControl, View } from 'react-native'

// import { useMusicList } from '@/store/list/hook'
import CommentFloor from './CommentFloor'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { type Comment } from '../utils'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'

type FlatListType = FlatListProps<Comment>

export interface ListProps {
  list: Comment[]
  status: Status
  hasPrevious: boolean
  onRefresh: () => void
  onLoadMore: () => void
  onLoadPrevious: () => void
}
export type Status = 'loading' | 'refreshing' | 'end' | 'error' | 'idle'

const List = ({
  list,
  status,
  hasPrevious,
  onRefresh,
  onLoadMore,
  onLoadPrevious,
}: ListProps) => {
  const t = useI18n()
  const theme = useTheme()

  const handleLoadMore = () => {
    if (status != 'idle') return
    onLoadMore()
  }

  const renderItem: FlatListType['renderItem'] = ({ item }) => <CommentFloor comment={item} />

  const getkey: FlatListType['keyExtractor'] = item => item.id

  const refreshControl = useMemo(() => (
    <RefreshControl
      colors={[theme['c-primary']]}
      // progressBackgroundColor={theme.primary}
      refreshing={status == 'refreshing'}
      onRefresh={onRefresh} />
  ), [status, onRefresh, theme])
  const footerComponent = useMemo(() => {
    let label: FooterLabel
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
    return <Footer label={label} onLoadMore={onLoadMore} />
  }, [onLoadMore, status])

  return (
    <FlatList
      style={styles.list}
      data={list}
      onEndReachedThreshold={0.5}
      maxToRenderPerBatch={4}
      windowSize={5}
      removeClippedSubviews={false}
      initialNumToRender={8}
      renderItem={renderItem}
      keyExtractor={getkey}
      // onRefresh={onRefresh}
      // refreshing={refreshing}
      onEndReached={handleLoadMore}
      refreshControl={refreshControl}
      ListHeaderComponent={hasPrevious ? <Text style={styles.footer} onPress={onLoadPrevious}>{t('comment_load_previous')}</Text> : null}
      ListFooterComponent={footerComponent}
    />
  )
}

type FooterLabel = 'list_loading' | 'list_end' | 'list_error' | null
const Footer = ({ label, onLoadMore }: {
  label: FooterLabel
  onLoadMore: () => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  const handlePress = () => {
    if (label != 'list_error') return
    onLoadMore()
  }
  return (
    label
      ? (
          <View>
            <Text onPress={handlePress} style={styles.footer} color={theme['c-font-label']}>{t(label)}</Text>
          </View>
        )
      : null
  )
}

const styles = createStyle({
  container: {
    flex: 1,
  },
  list: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 15,
    paddingRight: 15,
  },
  footer: {
    textAlign: 'center',
    padding: 10,
  },
})

export default List
