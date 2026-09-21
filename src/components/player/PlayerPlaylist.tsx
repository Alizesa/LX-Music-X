import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
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
//
// 注意：这个值只能写在内联 style 里（和其它列表一样），绝不能放进 createStyle。
// createStyle 会按属性名再缩放一次（height 走 scaleSizeH），ITEM_HEIGHT 已经是
// 缩放后的值，再缩一次就比 getItemLayout 声明的行高多/少几个 dp：
//   1080x2400 @2.75 -> 声明 56、实际 58；1080x1920 @3 -> 声明 51、实际 48；
//   1440x3200 @3.5 -> 声明 47、实际 41；字号调大还会按倍数放大这个差。
// 虚拟列表滚动时会把视口外的单元格换成 spacer，spacer 用的是 getItemLayout 的值，
// 而渲染出来的单元格用的是真实高度，两者每差 1dp，换一批单元格（默认每 50ms 10 个）
// 内容就会整体平移一批——看起来就是「一顿一顿地移动」，序号越大、要补的单元格越多越明显。
const ITEM_HEIGHT = scaleSizeH(LIST_ITEM_HEIGHT)

// 必须 memo：队列动辄几百首，虚拟列表一次就会补进来一批单元格，
// 父组件每次渲染都重渲所有行的话这批渲染就很贵（卡顿）。
// 配合下面把回调都做成稳定引用，PanResponder 也只会建一次而不再每帧重建。
const QueueRow = memo(({ item, index, active, onMove, onRemove, onPlay }: {
  item: LX.Player.PlayQueueItem
  index: number
  active: boolean
  onMove: (index: number, to: number) => void
  onRemove: (index: number) => void
  onPlay: (index: number) => void
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
    // height 都是内联的 ITEM_HEIGHT，别挪进 createStyle（会被二次缩放，见文件顶部说明）
    <Animated.View style={{ ...styles.item, height: ITEM_HEIGHT, borderBottomColor: theme['c-border-background'], backgroundColor: active ? theme['c-primary-background-hover'] : 'rgba(0,0,0,0)', transform: [{ translateY }], zIndex: 1 }}>
      <TouchableOpacity style={{ ...styles.playArea, height: ITEM_HEIGHT }} onPress={() => { onPlay(index) }}>
        {/* 当前播放的行用喇叭图标替掉序号，配合整行底色，比只改文字颜色好认得多 */}
        {active
          ? <View style={styles.index}><Icon name="volume-higt" size={14} color={theme['c-primary-font']} /></View>
          : <Text style={styles.index} color={theme['c-font-label']}>{index + 1}</Text>}
        <View style={styles.info}>
          <Text numberOfLines={1} color={active ? theme['c-primary-font'] : theme['c-font']}>{musicInfo.name}</Text>
          <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{musicInfo.singer}</Text>
        </View>
      </TouchableOpacity>
      <View style={{ ...styles.iconButton, height: ITEM_HEIGHT }} {...responder.panHandlers}><Icon name="menu" size={17} color={theme['c-font-label']} /></View>
      <TouchableOpacity style={{ ...styles.iconButton, height: ITEM_HEIGHT }} onPress={() => { onRemove(index) }}><Icon name="remove" size={15} color={theme['c-font-label']} /></TouchableOpacity>
    </Animated.View>
  )
}, (prev, next) => prev.item === next.item && prev.index === next.index && prev.active === next.active)

export default forwardRef<PlayerPlaylistType, {}>((props, ref) => {
  const popupRef = useRef<PopupType>(null)
  const listRef = useRef<FlatList<LX.Player.PlayQueueItem>>(null)
  const scrollOffsetRef = useRef(0)
  const listHeightRef = useRef(0)
  const [visible, setVisible] = useState(false)
  const [queue, setQueue] = useState<LX.Player.PlayQueueItem[]>([...getPlayQueue()])
  const playInfo = usePlayInfo()
  const theme = useTheme()

  // 挂载时的目标位置。两个属性必须同时给，缺一不可：
  // - initialScrollIndex 让虚拟列表从这一项开始渲染，否则单元格会逐个冒出来，
  //   看起来就是「一顿一顿地移动过去」（索引越大越明显）
  // - contentOffset 让原生视图一开始就停在这个位置。RN 的 VirtualizedList
  //   在 _onContentSizeChange 里会判断：提供了 contentOffset 就跳过它自己那次
  //   scrollToIndex。少了它，那次滚动会发生在内容尺寸确定之后（面板已出现），
  //   同样表现为可见的移动。
  const initialIndex = playInfo.playerPlayIndex > 0 && playInfo.playerPlayIndex < queue.length ? playInfo.playerPlayIndex : 0

  useImperativeHandle(ref, () => ({
    show() {
      setQueue([...getPlayQueue()])
      // 列表挂载时就由 contentOffset 停在 initialIndex 处，所以缓存值要按它来设，
      // 否则「是否已可见」会以为还在顶部，首次跟随时会多滚一次
      scrollOffsetRef.current = initialIndex * ITEM_HEIGHT
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

  const scrollToCurrent = useCallback(() => {
    const index = playInfo.playerPlayIndex
    if (index < 0 || index >= getPlayQueue().length) return
    // 已经完整露出就别再滚。用户点的就是眼前这一行，再滚一次只会「跳一下」。
    if (isIndexVisible(index)) return
    // 偏移就用 index*行高，让当前曲目停在可视区第一行。两个约束决定了这么算：
    // 1) 不能用 viewPosition 居中——它算的是 index*行高 - 比例*列表高度，
    //    靠前的歌曲会得到负偏移，内容整体错位、前几首被顶出可视区；
    // 2) 不能用列表高度去算居中——高度要等 onLayout 才有，而等到那时面板
    //    已经出现，滚动就发生在众目睽睽之下（"抖一下"）。这里只依赖行高，
    //    挂载当帧就能算出来，赶在面板出现之前滚好。
    listRef.current?.scrollToOffset({ offset: index * ITEM_HEIGHT, animated: false })
  }, [playInfo.playerPlayIndex, isIndexVisible])

  // 打开面板时不滚动：列表靠 initialScrollIndex + contentOffset 挂载时就位。
  // 只在面板打开期间曲目发生变化时跟随。
  const followedIndexRef = useRef<number | null>(null)

  useEffect(() => {
    if (!visible) {
      followedIndexRef.current = null
      return
    }
    const index = playInfo.playerPlayIndex
    // 刚打开：只记下当前曲目，不动
    if (followedIndexRef.current === null || followedIndexRef.current === index) {
      followedIndexRef.current = index
      return
    }
    followedIndexRef.current = index
    requestAnimationFrame(scrollToCurrent)
  }, [visible, playInfo.playerPlayIndex, scrollToCurrent])

  // 稳定引用，配合 QueueRow 的 memo：否则每渲染一次都会让所有行的
  // PanResponder 重建，长队列下开销很大
  const handleMove = useCallback((from: number, to: number) => { void moveQueueMusic(from, to) }, [])
  const handleRemove = useCallback((index: number) => { void removeQueueMusic(index) }, [])
  const handlePlay = useCallback((index: number) => { void playList(LIST_IDS.PLAY_QUEUE, index) }, [])

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
        // 必须给列表高度约束。ScrollView 默认 flexShrink:0，高度由内容决定，
        // 队列一长就会远超面板的 maxHeight，和父容器的收缩约束互相打架，
        // 布局稳定下来之前面板会跳一下。同 Popup 的另一个调用方（同步历史）
        // 也是用 flexShrink:1 + flexGrow:0 这个组合。
        style={styles.list}
        getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        initialScrollIndex={initialIndex > 0 ? initialIndex : undefined}
        contentOffset={{ x: 0, y: initialIndex * ITEM_HEIGHT }}
        onLayout={e => { listHeightRef.current = e.nativeEvent.layout.height }}
        onScroll={e => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y }}
        scrollEventThrottle={16}
        renderItem={({ item, index }) => (
          <QueueRow
            item={item}
            index={index}
            active={index == playInfo.playerPlayIndex}
            onMove={handleMove}
            onRemove={handleRemove}
            onPlay={handlePlay}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{global.i18n.t('player_playlist_empty')}</Text>}
      />
    </Popup>
  )
})

const styles = createStyle({
  list: { flexShrink: 1, flexGrow: 0 },
  toolbar: { height: 36, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clearButton: { minWidth: 48, height: 36, alignItems: 'center', justifyContent: 'center' },
  // 行高不在这里写：createStyle 会把 height 再缩放一次，和 getItemLayout 对不上，
  // 改由渲染处内联 ITEM_HEIGHT（见文件顶部说明）
  item: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingLeft: 12 },
  playArea: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  // textAlign 给序号文字用，alignItems 给当前曲的喇叭图标用（View 里靠它居中）
  index: { width: 32, textAlign: 'center', alignItems: 'center' },
  info: { flex: 1, paddingLeft: 8 },
  iconButton: { width: 42, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 32 },
})
