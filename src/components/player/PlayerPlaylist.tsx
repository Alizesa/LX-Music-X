import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, FlatList, PanResponder, TouchableOpacity, View } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { usePlayInfo, usePlayMusicInfo } from '@/store/player/hook'
import playerState from '@/store/player/state'
import { clearQueue, moveQueueMusic, playList, playTempPlayMusic, removeQueueMusic } from '@/core/player/player'
import { removeTempPlayList } from '@/core/player/tempPlayList'
import { getPlayQueue } from '@/core/player/playQueue'
import { LIST_IDS, LIST_ITEM_HEIGHT } from '@/config/constant'
import { scaleSizeH } from '@/utils/pixelRatio'
import { createStyle } from '@/utils/tools'

export interface PlayerPlaylistType {
  show: () => void
}

// 面板把「稍后播放」和播放队列合成一份列表，行顺序就是接下来的播放顺序：
// playNext 先取临时列表、取空后才回到播放队列，所以临时歌曲插在当前曲目后面，
// 正好是它们实际播放的位置（也是打开面板时一眼能看到的位置——面板默认停在当前曲目）。
// index 是该行在自己那份列表里的位置：队列行是队列下标，临时行是临时列表下标。
// 播到的歌曲会被移出临时列表，于是它自然从面板上消失。
type PlaylistRow =
  | { kind: 'temp', key: string, index: number, item: LX.Player.PlayMusicInfo }
  | { kind: 'queue', key: string, index: number, item: LX.Player.PlayQueueItem }

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

// 初始渲染段给多少行，同时决定「要不要把渲染窗口钉在当前项上」（见 show() 里的 pinWindow）：
// 给了 initialScrollIndex（且 > 0）时，渲染窗口会被 pendingScrollUpdateCount 钉在
// [index, index + 它) 这一段上、并跳过初始那段，所以它得够一屏才不会在可视区里留下空行；
// 反过来，队列长度不超过它时整条队列本来就都在初始段里，钉了反而会留白。
// 面板最高占屏幕 78%，按屏幕高度折算行数再多留两行。
const INITIAL_ROWS = Math.ceil(Dimensions.get('screen').height / ITEM_HEIGHT) + 2

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

// 「稍后播放」的行：序号位置换成醒目的标记，并且不能拖动——临时列表在 core 里
// 只支持追加/移除，没有顺序调整，给个拖动手柄会误导。
const TempRow = memo(({ item, index, onPlay, onRemove }: {
  item: LX.Player.PlayMusicInfo
  index: number
  onPlay: (index: number) => void
  onRemove: (index: number) => void
}) => {
  const theme = useTheme()
  const musicInfo = 'progress' in item.musicInfo ? item.musicInfo.metadata.musicInfo : item.musicInfo
  return (
    <View style={{ ...styles.item, height: ITEM_HEIGHT, borderBottomColor: theme['c-border-background'] }}>
      <TouchableOpacity style={{ ...styles.playArea, height: ITEM_HEIGHT }} onPress={() => { onPlay(index) }}>
        <Text style={styles.tempTag} size={11} numberOfLines={1} color={theme['c-primary-font']}>{global.i18n.t('player_playlist_temp')}</Text>
        <View style={styles.info}>
          <Text numberOfLines={1} color={theme['c-primary-font']}>{musicInfo.name}</Text>
          <Text numberOfLines={1} size={12} color={theme['c-font-label']}>{musicInfo.singer}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={{ ...styles.iconButton, height: ITEM_HEIGHT }} onPress={() => { onRemove(index) }}><Icon name="remove" size={15} color={theme['c-font-label']} /></TouchableOpacity>
    </View>
  )
})

export default forwardRef<PlayerPlaylistType, {}>((props, ref) => {
  const popupRef = useRef<PopupType>(null)
  const listRef = useRef<FlatList<PlaylistRow>>(null)
  const scrollOffsetRef = useRef(0)
  const listHeightRef = useRef(0)
  // 打开后还要不要补一次定位、以及补的那次有没有真的滚起来（见 onContentSizeChange）
  const pendingInitialScrollRef = useRef(false)
  const initialScrollDoneRef = useRef(false)
  const [visible, setVisible] = useState(false)
  const [queue, setQueue] = useState<LX.Player.PlayQueueItem[]>([...getPlayQueue()])
  const [tempList, setTempList] = useState<LX.Player.PlayMusicInfo[]>([...playerState.tempPlayList])
  const playInfo = usePlayInfo()
  const playMusicInfo = usePlayMusicInfo()
  const theme = useTheme()

  // 临时歌曲插在当前曲目之后（没有在播的歌曲、或当前曲目已不在队列里时插到最前面）。
  // 这样当前曲目的行号仍然等于它在队列里的下标，面板定位那套计算不受影响。
  const insertAt = playInfo.playerPlayIndex >= 0 && playInfo.playerPlayIndex < queue.length ? playInfo.playerPlayIndex + 1 : 0
  const rows = useMemo<PlaylistRow[]>(() => [
    ...queue.slice(0, insertAt).map((item, index): PlaylistRow => ({ kind: 'queue', key: item.queueId, index, item })),
    ...tempList.map((item, index): PlaylistRow => ({ kind: 'temp', key: `temp_${index}_${item.musicInfo.id}`, index, item })),
    ...queue.slice(insertAt).map((item, index): PlaylistRow => ({ kind: 'queue', key: item.queueId, index: insertAt + index, item })),
  ], [tempList, queue, insertAt])

  // 挂载时的目标位置，靠 contentOffset 给：原生属性，挂载当帧就位，看不到滚动过程。
  // RN 的 VirtualizedList 在 _onContentSizeChange 里那次自我修正（scrollToIndex）
  // 也要求提供了 contentOffset 才跳过，少了它，那次滚动会发生在内容尺寸确定之后
  // （面板已出现），表现为可见的移动。
  //
  // initialScrollIndex 让虚拟列表从当前这一项开始渲染，否则单元格会一个个冒出来，
  // 看起来就是「一顿一顿地移动过去」（索引越大越明显）；但它的值 > 0 时，窗口会被
  // pendingScrollUpdateCount 钉在 [index, index + initialNumToRender) 上，要等一次
  // 原生滚动事件才会挪窝（见 onContentSizeChange 里那次补滚）。所以它只在队列长到
  // 初始渲染段装不下时才给（pinWindow），并且 initialNumToRender 要按「一屏放得下的
  // 行数」给足，就算那次补滚没生效，可视区里也不会缺行。
  //
  // 这两个「挂载」语义只在挂载时有效，所以值必须在 show() 里定死、打开期间不再变：
  // contentOffset 是原生属性，值一变原生就会 scrollTo。之前它直接取
  // playInfo.playerPlayIndex，于是每换一首歌（尤其是用户自己点的那一首）原生都会
  // 把列表拽到那一行——用户明明是在列表里找到并点的，列表却「跳一下」。
  // 面板关闭时整棵子树返回 null，下次打开是重新挂载，所以冻结在 state 里正合适。
  const [initialIndex, setInitialIndex] = useState(0)
  // 钉不钉渲染窗口。跟 initialIndex 分开是有意的：定位（contentOffset）和钉窗口
  // （initialScrollIndex）是两件事，队列不长时只是不该钉，该定的位还是要定。
  const [pinWindow, setPinWindow] = useState(false)

  useImperativeHandle(ref, () => ({
    show() {
      const list = getPlayQueue()
      // 队列长到初始渲染段（[0, INITIAL_ROWS)）装不下，才值得让虚拟列表「从当前项起渲染」；
      // 装得下时钉了只有坏处：窗口被钉在 [index, index + INITIAL_ROWS) 上、初始那段又不渲染，
      // 当前曲目以上那几行就成了空白；而内容短到滚不动时，连一次能解开这个钉死的滚动事件
      // 都产生不出来（拖也没用，原生根本没有可滚的余量），空白就一直挂在那里。不钉的话
      // 初始那段本来就盖住整条队列，一行都不会缺。
      setPinWindow(list.length > INITIAL_ROWS)
      const index = playInfo.playerPlayIndex > 0 && playInfo.playerPlayIndex < list.length ? playInfo.playerPlayIndex : 0
      setQueue([...list])
      setTempList([...playerState.tempPlayList])
      setInitialIndex(index)
      // 列表挂载时就由 contentOffset 停在 index 处，所以缓存值要按它来设，
      // 否则「是否已可见」会以为还在顶部，首次跟随时会多滚一次
      scrollOffsetRef.current = index * ITEM_HEIGHT
      listHeightRef.current = 0
      pendingInitialScrollRef.current = index > 0
      initialScrollDoneRef.current = false
      setVisible(true)
      requestAnimationFrame(() => popupRef.current?.setVisible(true))
    },
  }))

  useEffect(() => {
    const handleUpdate = (nextQueue: LX.Player.PlayQueueItem[]) => { setQueue(nextQueue) }
    global.app_event.on('playQueueUpdate', handleUpdate)
    return () => { global.app_event.off('playQueueUpdate', handleUpdate) }
  }, [])

  useEffect(() => {
    // 面板打开期间临时列表也会变：一首稍后播放的歌曲播完（或用户点了它）就会被移出列表。
    // 事件参数是 {...array} 这样的普通对象，拿不到数组本身，所以直接从 state 里取快照。
    const handleUpdate = () => { setTempList([...playerState.tempPlayList]) }
    global.state_event.on('playTempPlayListChanged', handleUpdate)
    return () => { global.state_event.off('playTempPlayListChanged', handleUpdate) }
  }, [])

  // 传的是队列下标：临时歌曲插在当前曲目之后，所以当前曲目的行号仍等于它，
  // 下面这套定位计算不用为临时歌曲做任何偏移
  const isIndexVisible = useCallback((index: number) => {
    const top = index * ITEM_HEIGHT
    const bottom = top + ITEM_HEIGHT
    const viewTop = scrollOffsetRef.current
    return top >= viewTop && bottom <= viewTop + listHeightRef.current
  }, [])

  const scrollToCurrent = useCallback(() => {
    const index = playInfo.playerPlayIndex
    if (index < 0 || index >= getPlayQueue().length) return
    // 已经完整露出就别再滚
    if (isIndexVisible(index)) return
    // 偏移就用 index*行高，让当前曲目停在可视区第一行。两个约束决定了这么算：
    // 1) 不能用 viewPosition 居中——它算的是 index*行高 - 比例*列表高度，
    //    靠前的歌曲会得到负偏移，内容整体错位、前几首被顶出可视区；
    // 2) 不能用列表高度去算居中——高度要等 onLayout 才有，而等到那时面板
    //    已经出现，滚动就发生在众目睽睽之下（"抖一下"）。这里只依赖行高，
    //    挂载当帧就能算出来，赶在面板出现之前滚好。
    listRef.current?.scrollToOffset({ offset: index * ITEM_HEIGHT, animated: false })
  }, [playInfo.playerPlayIndex, isIndexVisible])

  // 打开面板时不滚动：列表靠 contentOffset（长队列再加 initialScrollIndex）挂载时就位。
  // 只在面板打开期间曲目发生变化时跟随。
  const followedIndexRef = useRef<number | null>(null)
  // 用户点过的那一行。点播说明它就在眼前，跟随逻辑不该再把它滚到第一行。
  const tappedIndexRef = useRef<number | null>(null)

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
    const tapped = tappedIndexRef.current
    tappedIndexRef.current = null
    // 这一次变化来自用户点的那一行：什么都不做（别的曲目照常跟随）
    if (tapped === index) return
    requestAnimationFrame(scrollToCurrent)
  }, [visible, playInfo.playerPlayIndex, scrollToCurrent])

  // 打开期间行集会变：队列被重建（queueId 全换，单元格整批重挂）、稍后播放的歌播完
  // 被移出。行少了以后原生滚动位置不会自己收回来——上面借着 contentOffset 关掉了
  // RN 那次自我修正（_onContentSizeChange 里那个 scrollToIndex），偏移就停在内容
  // 末尾之外，原位置留下一块空白。这里在行集变化后把偏移夹回合法范围：
  // 位置本身合法时什么都不做，不影响用户自己滚动的位置。
  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      const maxOffset = Math.max(0, rows.length * ITEM_HEIGHT - listHeightRef.current)
      if (scrollOffsetRef.current <= maxOffset) return
      listRef.current?.scrollToOffset({ offset: maxOffset, animated: false })
      scrollOffsetRef.current = maxOffset
    })
    return () => { cancelAnimationFrame(raf) }
  }, [visible, rows])

  // 稳定引用，配合 QueueRow 的 memo：否则每渲染一次都会让所有行的
  // PanResponder 重建，长队列下开销很大
  const handleMove = useCallback((from: number, to: number) => { void moveQueueMusic(from, to) }, [])
  const handleRemoveQueue = useCallback((index: number) => { void removeQueueMusic(index) }, [])
  const handlePlayQueue = useCallback((index: number) => {
    // 记下用户点的行，跟随逻辑据此跳过这一次（见上面的 effect）
    tappedIndexRef.current = index
    void playList(LIST_IDS.PLAY_QUEUE, index)
  }, [])
  // 临时列表的行只按自己的位置处理，与队列无关
  const handleRemoveTemp = useCallback((index: number) => { removeTempPlayList(index) }, [])
  const handlePlayTemp = useCallback((index: number) => { void playTempPlayMusic(index) }, [])

  if (!visible) return null

  return (
    <Popup ref={popupRef} title={global.i18n.t('player_playlist')} onHide={() => { setVisible(false) }} position="bottom">
      <View style={styles.toolbar}>
        <Text size={12} color={theme['c-font-label']}>{rows.length}</Text>
        <TouchableOpacity style={styles.clearButton} onPress={() => { void clearQueue() }}>
          <Text size={12} color={theme['c-primary-font']}>{global.i18n.t('player_playlist_clear')}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={row => row.key}
        // 安卓上 ScrollView 默认开着 removeClippedSubviews：行集变化时被「剪掉」
        // 的单元格会连着还在可视区里的位置一起空着（就是那块空白）。面板生命周期
        // 很短，取消裁剪的代价可以接受，换来的是行增减后渲染结果一定是全的
        removeClippedSubviews={false}
        // 必须给列表高度约束。ScrollView 默认 flexShrink:0，高度由内容决定，
        // 队列一长就会远超面板的 maxHeight，和父容器的收缩约束互相打架，
        // 布局稳定下来之前面板会跳一下。同 Popup 的另一个调用方（同步历史）
        // 也是用 flexShrink:1 + flexGrow:0 这个组合。
        style={styles.list}
        getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        // 钉窗口那段的范围（见上面的说明），给足一屏
        initialNumToRender={INITIAL_ROWS}
        // 队列不长时不给 initialScrollIndex（只定位，不钉窗口，见 show()）
        initialScrollIndex={pinWindow && initialIndex > 0 ? initialIndex : undefined}
        contentOffset={{ x: 0, y: initialIndex * ITEM_HEIGHT }}
        onLayout={e => { listHeightRef.current = e.nativeEvent.layout.height }}
        // 补一次打开时的定位。contentOffset 是原生属性，面板挂载时内容往往还没量好，
        // 这次定位会被当成「超出可滚范围」丢掉，列表就停在顶部；而 initialScrollIndex>0
        // 时渲染窗口要等一次原生滚动事件（_onScroll 里那个 pendingScrollUpdateCount）
        // 才会离开初始那段，当前曲目以上那批行就一直是空白——行数不变、重开重装也一样，
        // 因为每次打开都是重新挂载。不钉窗口时（队列不长）这一步就只剩「补回定位」，
        // 内容短到滚不动时它会空转一次，反正那种队列本来就整条都看得见。
        //
        // 必须挂在 onContentSizeChange 上而不是 onLayout：位置真的对得上要求内容已经
        // 量好，早了的话原生那次 scrollTo 会被夹回原处、偏移没变，onScrollChanged 不
        // 触发，等于白滚。这里内容尺寸已经确定，滚过去一定生效，顺带用那次 onScroll
        // 把渲染窗口带回正轨（scrollToOffset 本身不改 JS 侧的 scrollMetrics）。
        // 位置本来就对时它是空操作；真滚过之后（onScroll 里置位）就不再补。
        onContentSizeChange={() => {
          if (!pendingInitialScrollRef.current || initialScrollDoneRef.current) return
          const offset = initialIndex * ITEM_HEIGHT
          if (offset <= 0) return
          requestAnimationFrame(() => {
            if (initialScrollDoneRef.current) return
            listRef.current?.scrollToOffset({ offset, animated: false })
          })
        }}
        onScroll={e => {
          scrollOffsetRef.current = e.nativeEvent.contentOffset.y
          // 滚过就说明那次补定位生效了（或用户自己滚了），别再补
          if (pendingInitialScrollRef.current) initialScrollDoneRef.current = true
        }}
        scrollEventThrottle={16}
        renderItem={({ item: row }) => (
          row.kind === 'temp'
            ? <TempRow item={row.item} index={row.index} onPlay={handlePlayTemp} onRemove={handleRemoveTemp} />
            : <QueueRow
              item={row.item}
              index={row.index}
              // 正在播“稍后播放”的歌曲时，playerPlayIndex 仍指向上一次播到的队列位置，
              // 那一行并没有在播（临时播放不改动它），所以这时不给任何队列行标高亮
              active={!playMusicInfo.isTempPlay && row.index == playInfo.playerPlayIndex}
              onMove={handleMove}
              onRemove={handleRemoveQueue}
              onPlay={handlePlayQueue}
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
  // 与序号同宽，两种行左边缘才对得齐
  tempTag: { width: 32, textAlign: 'center' },
  info: { flex: 1, paddingLeft: 8 },
  iconButton: { width: 42, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 32 },
})
