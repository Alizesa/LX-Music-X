import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, TouchableOpacity, View, type FlatListProps } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
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
// hasMore 一起缓存：从缓存里拿回来的那份也得知道还有没有下一页，光靠 list 和 page 推不出来
interface CacheEntry { list: SingerItem[], page: number, hasMore: boolean }

// 行的比例照 WalnutBai 那套歌手列表来的：头像 70、行高 100、左右留 15、名字 16、副标题 12。
// 比项目里搜索页那份（48 头像 + padding 10）显眼
const AVATAR_SIZE = scaleSizeW(70)
const ROW_HEIGHT = 100
// tx 的歌手搜索每页最多只能要 20 条左右，要多了服务端会返回空列表（不是限流，见 SDK 里的注释）
const PAGE_LIMIT = 20
// 拆歌手名的分隔符。跟 utils/musicSdk/index.js 里 findMusic 那套约定一致，但没有共用：
// 那边拆完还要排序、空值处理也不同，为了一个正则去改找歌曲的匹配逻辑不划算
const SINGER_SPLIT_RXP = /、|&|;|；|\/|,|，|\|/

// 歌手名 -> 已经拿到的结果。来回翻歌、翻页都能省掉重复请求，
// 而这一页的用法就是「同一首歌的歌手来回翻」，命中率很高
// （这个分支有意压低对音源的请求量）。上限很小，够装下最近听过的那几位
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

// musicSdk 那边是 JS，类型得自己补：歌手搜索返回 { list, total }
const searchSinger = async(name: string, page: number) =>
  musicSdk.tx.musicSearch.searchSinger(name, page, PAGE_LIMIT) as Promise<{ list: SingerItem[], total: number }>

/**
 * 封面页前面那一页：按当前歌曲的歌手搜人，点一位就进歌手详情。
 *
 * 没有搜索框，也没有歌手标签：进来就是这一位歌手的搜索结果。多歌手（「周杰伦、费玉清」）
 * 取第一位去搜——整串拿去搜是搜不到人的。
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
  const [list, setList] = useState<SingerItem[]>([])
  const [status, setStatus] = useState<Status>('idle')
  // 已经拿到第几页。请求回来时要用它算下一页，走 state 的话回调里拿到的会是闭包里那份旧的
  const pageRef = useRef(0)
  // 列表的镜像：追加下一页时要按现有内容去重，而回调里同样拿不到最新的 state
  const listRef = useRef<SingerItem[]>([])
  // 每次请求发一个号，回来时号对不上，说明歌换了，这次结果作废。
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

  // 拿去找人的词：这首歌的第一位歌手
  const keyword = singers[0] ?? ''

  // 把一份结果摆到界面上（无论它是刚请求回来的还是缓存里的）
  const showEntry = useCallback((entry: CacheEntry) => {
    listRef.current = entry.list
    pageRef.current = entry.page
    setList(entry.list)
    setStatus(entry.hasMore ? 'idle' : 'end')
  }, [])

  const load = useCallback(async(text: string, page: number) => {
    const seq = ++seqRef.current
    setStatus('loading')
    try {
      const result = await searchSinger(text, page)
      if (!mountedRef.current || seq != seqRef.current) return
      let next = result.list
      if (page > 1) {
        // 翻页时榜单可能在动，前后页会重人；按 mid 去重，FlatList 的 key 才不会撞
        const prev = listRef.current
        next = [...prev, ...result.list.filter(item => !prev.some(old => old.mid == item.mid))]
      }
      // 拿到的条数已经够总数了，就没有下一页了
      const entry = { list: next, page, hasMore: next.length < result.total }
      writeCache(text, entry)
      showEntry(entry)
    } catch (err) {
      console.log(err)
      if (!mountedRef.current || seq != seqRef.current) return
      // 出错不写缓存，否则下次翻回来直接命中缓存，重试都救不回来
      setStatus('error')
    }
  }, [showEntry])

  // 只有真翻到这一页、而且歌确实换了才请求。PagerView 会把三页都挂上，挂载就发请求等于
  // 每次打开播放详情页都白打一次接口（这个分支有意压低对音源的请求量）
  useEffect(() => {
    if (!active) return
    if (!keyword) {
      listRef.current = []
      pageRef.current = 0
      setList([])
      setStatus('idle')
      return
    }
    const cached = cache.get(keyword)
    if (cached) {
      showEntry(cached)
      return
    }
    void load(keyword, 1)
  }, [active, keyword, load, showEntry])

  const handleLoadMore = useCallback(() => {
    // 只有 idle 表示「可能还有下一页」：loading 是在等上一页，end 是到底了，error 得先重试
    if (status != 'idle' || !keyword) return
    void load(keyword, pageRef.current + 1)
  }, [status, keyword, load])

  const handleRetry = useCallback(() => {
    if (!keyword) return
    if (pageRef.current > 0) void load(keyword, pageRef.current + 1)
    else void load(keyword, 1)
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
        <Text size={16} numberOfLines={1}>{item.name}</Text>
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
      <FlatList
        data={list}
        style={styles.list}
        keyExtractor={item => item.mid}
        renderItem={renderItem}
        onEndReachedThreshold={0.6}
        onEndReached={handleLoadMore}
        ListEmptyComponent={
          keyword && (status == 'end' || status == 'idle')
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
  list: {
    flex: 1,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    // 用 minHeight 而不是固定 height：小屏上 scaleSizeW 可能把头像放大到超过 100，
    // 固定行高会把头像切掉
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 15,
    paddingVertical: 15,
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
    marginLeft: 15,
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
