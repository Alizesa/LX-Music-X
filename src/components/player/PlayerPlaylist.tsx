import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Animated, FlatList, PanResponder, TouchableOpacity, View } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { usePlayInfo } from '@/store/player/hook'
import { clearQueue, moveQueueMusic, playList, removeQueueMusic } from '@/core/player/player'
import { getPlayQueue } from '@/core/player/playQueue'
import { LIST_IDS, LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
import { createStyle } from '@/utils/tools'

export interface PlayerPlaylistType {
  show: () => void
}

// 行高必须跟着字号缩放：Text 用的是 setSpText（会乘字号设置），
// 这里写死常量的话，字号调大后两行文字会溢出被裁掉。
// 其它列表统一用 scaleSizeH(LIST_ITEM_HEIGHT)，这里保持一致，
// getItemLayout 也用同一个值，滚动定位才和实际渲染对得上。
const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)
// 滚动定位时把目标行放在视口偏上的位置，而不是 0.35 这种贴边的比例，
// 上下都留出余量，不会出现"定位到了但贴着边缘"的观感
const SCROLL_VIEW_POSITION = 0.5

const QueueRow = ({ item, index, active, onMove, onRemove, onPlay }: {
  item: LX.Player.PlayQueueItem
  index: number
  active: boolean
  onMove: (from: number, to: number) => void
  onRemove: () => void
  onPlay: () => void
}) => {
  const theme = useTheme()
  const musicInfo = 'progress' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
  const translateY = useRef(new Animated.Value(0)).current
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 3,
    onPanResponderMove: Animated.event([null, { dy: translateY }], { useNativeDriver: false }),
    onPanResponderRelease: (_, gesture) => {
      translateY.setValue(0)
      const target = Math.max(0, Math.min(getPlayQueue().length - 1, index + Math.round(gesture.dy / ITEM_HEIGHT)))
      if (target != index) onMove(index, target)
    },
    onPanResponderTerminate: () => { translateY.setValue(0) },
  }), [index, onMove, translateY])

  return (
    <Animated.View style={{ ...styles.item, borderBottomColor: theme['c-border-background'], backgroundColor: active ? theme['c-primary-background-hover'] : 'rgba(0,0,0,0)', transform: [{ translateY }], zIndex: 1 }}>
      <TouchableOpacity style={styles.playArea} onPress={onPlay}>
        {/* 当前播放的行用喇叭图标替掉序号，配合整行底色，比只改文字颜色好认得多 */}
        {active
          ? <View style={styles.index}><Icon name="volume-higt" size={14} color={theme['c-primary-font']} /></View>
          : <Text style={styles.index} color={theme['c-font-label']}>{index + 1}</Text>}
        <View style={styles.info}>
          <Text numberOfLines={1} color={active ? theme['c-primary-font'] : theme['c-font']}>{musicInfo.name}</Text>
          <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{musicInfo.singer}</Text>
        </View>
      </TouchableOpacity>
      <View style={styles.iconButton} {...responder.panHandlers}><Icon name="menu" size={17} color={theme['c-font-label']} /></View>
      <TouchableOpacity style={styles.iconButton} onPress={onRemove}><Icon name="remove" size={15} color={theme['c-font-label']} /></TouchableOpacity>
    </Animated.View>
  )
}

export default forwardRef<PlayerPlaylistType, {}>((props, ref) => {
  const popupRef = useRef<PopupType>(null)
  const listRef = useRef<FlatList<LX.Player.PlayQueueItem>>(null)
  const scrollOffsetRef = useRef(0)
  const listHeightRef = useRef(0)
  const [visible, setVisible] = useState(false)
  const [queue, setQueue] = useState<LX.Player.PlayQueueItem[]>([...getPlayQueue()])
  const playInfo = usePlayInfo()
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    show() {
      setQueue([...getPlayQueue()])
      // 面板每次显示都是重新挂载的 FlatList，滚动位置回到 0；
      // 缓存的值也要重置，否则会拿上一次的偏移量误判成「已经可见」而跳过定位
      scrollOffsetRef.current = 0
      listHeightRef.current = 0
      setVisible(true)
      requestAnimationFrame(() => popupRef.current?.setVisible(true))
    },
  }))

  useEffect(() => {
    const handleUpdate = (nextQueue: LX.Player.PlayQueueItem[]) => { setQueue(nextQueue) }
    global.app_event.on('playQueueUpdate', handleUpdate)
    return () => { global.app_event.off('playQueueUpdate', handleUpdate) }
  }, [])

  const isIndexVisible = useCallback((index: number) => {
    const top = index * ITEM_HEIGHT
    const bottom = top + ITEM_HEIGHT
    const viewTop = scrollOffsetRef.current
    return top >= viewTop && bottom <= viewTop + listHeightRef.current
  }, [])

  useEffect(() => {
    if (!visible) return
    const index = playInfo.playerPlayIndex
    if (index < 0 || index >= getPlayQueue().length) return
    // 已经完整露出就别再滚。用户点的就是眼前这一行，再滚一次只会「跳一下」；
    // 打开面板时当前曲目本来就在可视区内，同样不必动。
    if (isIndexVisible(index)) return
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index, viewPosition: SCROLL_VIEW_POSITION, animated: false })
    })
  }, [visible, playInfo.playerPlayIndex, isIndexVisible])

  if (!visible) return null

  return (
    <Popup ref={popupRef} title={global.i18n.t('player_playlist')} onHide={() => { setVisible(false) }} position="bottom">
      <View style={styles.toolbar}>
        <Text size={12} color={theme['c-font-label']}>{queue.length}</Text>
        <TouchableOpacity style={styles.clearButton} onPress={() => { void clearQueue() }}>
          <Text size={12} color={theme['c-primary-font']}>{global.i18n.t('player_playlist_clear')}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        ref={listRef}
        data={queue}
        keyExtractor={item => item.queueId}
        getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        onLayout={e => { listHeightRef.current = e.nativeEvent.layout.height }}
        onScroll={e => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y }}
        scrollEventThrottle={16}
        onScrollToIndexFailed={({ index }) => {
          setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: SCROLL_VIEW_POSITION, animated: false }), 100)
        }}
        renderItem={({ item, index }) => (
          <QueueRow
            item={item}
            index={index}
            active={index == playInfo.playerPlayIndex}
            onMove={(from, to) => { void moveQueueMusic(from, to) }}
            onRemove={() => { void removeQueueMusic(index) }}
            onPlay={() => { void playList(LIST_IDS.PLAY_QUEUE, index) }}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{global.i18n.t('player_playlist_empty')}</Text>}
      />
    </Popup>
  )
})

const styles = createStyle({
  toolbar: { height: 36, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clearButton: { minWidth: 48, height: 36, alignItems: 'center', justifyContent: 'center' },
  item: { height: ITEM_HEIGHT, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingLeft: 12 },
  playArea: { flex: 1, height: ITEM_HEIGHT, flexDirection: 'row', alignItems: 'center' },
  // textAlign 给序号文字用，alignItems 给当前曲的喇叭图标用（View 里靠它居中）
  index: { width: 32, textAlign: 'center', alignItems: 'center' },
  info: { flex: 1, paddingLeft: 8 },
  iconButton: { width: 42, height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 32 },
})
