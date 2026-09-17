import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Animated, FlatList, PanResponder, TouchableOpacity, View } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { usePlayInfo } from '@/store/player/hook'
import { clearQueue, moveQueueMusic, playList, removeQueueMusic } from '@/core/player/player'
import { getPlayQueue } from '@/core/player/playQueue'
import { LIST_IDS } from '@/config/constant'
import { createStyle } from '@/utils/tools'

export interface PlayerPlaylistType {
  show: () => void
}

const ITEM_HEIGHT = 56

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
    <Animated.View style={{ ...styles.item, borderBottomColor: theme['c-border-background'], transform: [{ translateY }], zIndex: 1 }}>
      <TouchableOpacity style={styles.playArea} onPress={onPlay}>
        <Text style={styles.index} color={active ? theme['c-primary-font'] : theme['c-font-label']}>{index + 1}</Text>
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
  const [visible, setVisible] = useState(false)
  const [queue, setQueue] = useState<LX.Player.PlayQueueItem[]>([...getPlayQueue()])
  const playInfo = usePlayInfo()
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    show() {
      setQueue([...getPlayQueue()])
      setVisible(true)
      requestAnimationFrame(() => popupRef.current?.setVisible(true))
    },
  }))

  useEffect(() => {
    const handleUpdate = (nextQueue: LX.Player.PlayQueueItem[]) => { setQueue(nextQueue) }
    global.app_event.on('playQueueUpdate', handleUpdate)
    return () => { global.app_event.off('playQueueUpdate', handleUpdate) }
  }, [])

  const scrollToCurrent = useCallback(() => {
    if (playInfo.playerPlayIndex < 0 || playInfo.playerPlayIndex >= queue.length) return
    listRef.current?.scrollToIndex({ index: playInfo.playerPlayIndex, viewPosition: 0.35, animated: false })
  }, [playInfo.playerPlayIndex, queue.length])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(scrollToCurrent)
  }, [visible, scrollToCurrent])

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
        onScrollToIndexFailed={({ index }) => {
          setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.35, animated: false }), 100)
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
  index: { width: 32, textAlign: 'center' },
  info: { flex: 1, paddingLeft: 8 },
  iconButton: { width: 42, height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 32 },
})
