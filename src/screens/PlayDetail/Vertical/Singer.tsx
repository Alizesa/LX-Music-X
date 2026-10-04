import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, ScrollView, TouchableOpacity, View, type FlatListProps } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import Input from '@/components/common/Input'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { formatPlayCount } from '@/utils'
import { navigations } from '@/navigation'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { type SingerItem } from '@/store/search/singer/state'
import musicSdk from '@/utils/musicSdk'

type Status = 'loading' | 'end' | 'error' | 'idle'
interface CacheEntry { list: SingerItem[], total: number, page: number }

const AVATAR_SIZE = scaleSizeW(48)
// tx 的歌手搜索每页最多只能要 20 条左右，要多了服务端会返回空列表（不是限流，见 SDK 里的注释）
const PAGE_LIMIT = 20
// 拆歌手名的分隔符。跟 utils/musicSdk/index.js 里 findMusic 那套约定一致，但没有共用：
// 那边拆完还要排序、空值处理也不同，为了一个正则去改找歌曲的匹配逻辑不划算
const SINGER_SPLIT_RXP = /、|&|;|；|\/|,|，|\|/
// 输入停顿多久才去搜。一个字一个请求太费，而且中间那几次的结果根本没人看
const SEARCH_DEBOUNCE = 400

// 关键词 -> 已经拿到的结果。这一页的用法就是「同一首歌的歌手来回翻」，缓存能省掉绝大部分重复请求
// （这个分支有意压低对音源的请求量）。上限很小，够装下同一首歌的几位歌手、外加手动改过的几个词
const CACHE_MAX = 20
const cache = new Map<string, CacheEntry>()
const writeCache = (key: string, entry: CacheEntry) => {
  // 先删再塞，让最近用过的排到 Map 末尾（Map 保持插入顺序），淘汰时丢的就是最旧的
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
}

/**
 * 封面页前面那一页：按当前歌曲的歌手快速搜人，点一位就进歌手详情。
 *
 * 没有复用搜索页的 SingerList：它读写的 core/search/singer.ts 走的是全局的
 * searchSingerState，和搜索页的歌手 tab 共用一份 listInfo——从这边搜一次，搜索页那边的
 * 列表就被顶掉了（回到搜索页会看到搜索框是自己的词、列表却是这边的人）。所以这里自己
 * 拿 musicSdk 请求、自己管缓存。
 */
export default memo(({ componentId, active }: { componentId: string, active: boolean }) => {
  const theme = useTheme()
  const t = useI18n()
  const musicInfo = usePlayerMusicInfo()
  // 输入框的字和真正拿去搜的词分开：前者跟着手指走，后者要等停顿一下（见下面的防抖）
  const [inputText, setInputText] = useState('')
  const [keyword, setKeyword] = useState('')
  const [list, setList] = useState<SingerItem[]>([])
  const [status, setStatus] = useState<Status>('idle')
  // 已经拿到第几页、一共多少条。请求回来时要用它们算「还有没有下一页」，
  // 走 state 的话回调里拿到的会是闭包里那份旧的
  const pageRef = useRef(0)
  const totalRef = useRef(0)
  // 列表的镜像：追加下一页时要按现有内容去重，而回调里同样拿不到最新的 state
  const listRef = useRef<SingerItem[]>([])
  // 每次请求发一个号，回来时号对不上，说明关键词已经换了，这次结果作废。
  // 接口没有取消能力，只能回来之后把它丢掉，别写在界面上
  const seqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 这首歌的歌手，按分隔符拆开。「周杰伦、费玉清」这种整串拿去搜是搜不到人的
  const singers = useMemo(
    () => (musicInfo.singer || '').split(SINGER_SPLIT_RXP).map(name => name.trim()).filter(Boolean),
    [musicInfo.singer],
  )

  // 换歌就换回这首歌的歌手：这一页的定位就是「当前这首歌的歌手」，
  // 留着上一首的词只会搜出不相干的人
  useEffect(() => {
    const first = singers[0] ?? ''
    setInputText(first)
    setKeyword(first)
  }, [singers])

  // 防抖：输入框的字先落到 inputText，停一下才变成 keyword 去搜
  useEffect(() => {
    if (inputText == keyword) return
    const timer = setTimeout(() => { setKeyword(inputText.trim()) }, SEARCH_DEBOUNCE)
    return () => { clearTimeout(timer) }
  }, [inputText, keyword])

  // 把一份结果摆到界面上（无论它是刚请求回来的还是缓存里的）
  const showEntry = useCallback((entry: CacheEntry) => {
    listRef.current = entry.list
    pageRef.current = entry.page
    totalRef.current = entry.total
    setList(entry.list)
    // 拿到的条数已经够总数了，就没有下一页了
    setStatus(entry.list.length >= entry.total ? 'end' : 'idle')
  }, [])

  const load = useCallback(async(text: string, page: number) => {
    const seq = ++seqRef.current
    setStatus('loading')
    try {
      const result = await musicSdk.tx.musicSearch.searchSinger(text, page, PAGE_LIMIT) as { list: SingerItem[], total: number }
      if (!mountedRef.current || seq != seqRef.current) return
      let next = result.list
      if (page > 1) {
        // 翻页时榜单可能在动，前后页会重人；按 mid 去重，FlatList 的 key 才不会撞
        const prev = listRef.current
        next = [...prev, ...result.list.filter(item => !prev.some(old => old.mid == item.mid))]
      }
      const entry = { list: next, total: result.total, page }
      writeCache(text, entry)
      showEntry(entry)
    } catch (err) {
      console.log(err)
      if (!mountedRef.current || seq != seqRef.current) return
      // 出错不写缓存，否则下次翻回来直接命中缓存，重试都救不回来
      setStatus('error')
    }
  }, [showEntry])

  // 只有真翻到这一页才请求。PagerView 会把三页都挂上，挂载就发请求等于每次打开播放详情页
  // 都白打一次接口（这个分支有意压低对音源的请求量）
  useEffect(() => {
    if (!active) return
    const text = keyword.trim()
    if (!text) {
      listRef.current = []
      pageRef.current = 0
      setList([])
      setStatus('idle')
      return
    }
    const cached = cache.get(text)
    if (cached) {
      showEntry(cached)
      return
    }
    void load(text, 1)
  }, [active, keyword, load, showEntry])

  // 翻到这一页、又换了歌、或者手点了歌手标签，都走这里换词；标签是即点即搜，不用等防抖
  const handlePickSinger = useCallback((name: string) => {
    setInputText(name)
    setKeyword(name)
  }, [])

  const handleLoadMore = useCallback(() => {
    // 只有 idle 表示「可能还有下一页」：loading 是在等上一页，end 是到底了，error 得先重试
    if (status != 'idle') return
    void load(keyword.trim(), pageRef.current + 1)
  }, [status, keyword, load])

  const handleRetry = useCallback(() => {
    const text = keyword.trim()
    if (!text) return
    if (pageRef.current > 0) void load(text, pageRef.current + 1)
    else void load(text, 1)
  }, [keyword, load])

  const handleOpenDetail = useCallback((item: SingerItem) => {
    // id 用 mid：歌手详情的缓存按 mid 存，共享元素动画的两个 nativeID 也是拿它拼的
    navigations.pushSingerDetailScreen(componentId, {
      id: item.mid,
      mid: item.mid,
      name: item.name,
      picUrl: item.picUrl,
    })
  }, [componentId])

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

  return (
    <View style={styles.container}>
      <View style={{ ...styles.searchBar, borderBottomColor: theme['c-border-background'] }}>
        <Input
          value={inputText}
          onChangeText={setInputText}
          clearBtn
          placeholder={t('search_singer_placeholder')}
          returnKeyType="search"
          // 回车立即搜，不等防抖
          onSubmitEditing={() => { setKeyword(inputText.trim()) }}
        />
      </View>
      {/* 一首歌好几位歌手时，给一排标签一点就到；只有一位就不占地方了 */}
      {singers.length > 1
        ? (
            <ScrollView style={styles.singers} contentContainerStyle={styles.singersContent} horizontal keyboardShouldPersistTaps="always">
              {singers.map(name => (
                <TouchableOpacity
                  key={name}
                  style={{
                    ...styles.singerTag,
                    backgroundColor: name == keyword ? theme['c-primary-background-hover'] : theme['c-primary-light-900-alpha-200'],
                  }}
                  onPress={() => { handlePickSinger(name) }}
                >
                  <Text size={12} numberOfLines={1} color={name == keyword ? theme['c-primary-font'] : theme['c-font']}>{name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )
        : null}
      <FlatList
        data={list}
        style={styles.list}
        keyExtractor={item => item.mid}
        renderItem={renderItem}
        onEndReachedThreshold={0.6}
        onEndReached={handleLoadMore}
        // 键盘弹着时也能一下点到行（否则第一次点击只会收键盘）
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          keyword.trim() && (status == 'end' || status == 'idle')
            ? <Text style={styles.empty} color={theme['c-font-label']}>{t('no_item')}</Text>
            : null
        }
        ListFooterComponent={<Footer status={status} onRetry={handleRetry} />}
      />
    </View>
  )
})

const Footer = ({ status, onRetry }: { status: Status, onRetry: () => void }) => {
  const theme = useTheme()
  const t = useI18n()
  let label: 'list_loading' | 'list_end' | 'list_error' | null
  switch (status) {
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
      onPress={() => { if (label == 'list_error') onRetry() }}
      style={styles.footer}
      color={theme['c-font-label']}
    >{t(label)}</Text>
  )
}

const styles = createStyle({
  container: {
    flex: 1,
  },
  searchBar: {
    flexGrow: 0,
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  singers: {
    flexGrow: 0,
    flexShrink: 0,
  },
  singersContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  singerTag: {
    flexGrow: 0,
    flexShrink: 0,
    height: 26,
    justifyContent: 'center',
    paddingHorizontal: 10,
    marginRight: 8,
    borderRadius: 13,
  },
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
