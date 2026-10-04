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

// 没有分页：这一页只有「这首歌的几位歌手」这么几行，拿完就完
type Status = 'loading' | 'error' | 'idle'

// 行的比例照 WalnutBai 那套歌手列表来的：头像 70、行高 100、左右留 15、名字 16、副标题 12。
// 比项目里搜索页那份（48 头像 + padding 10）显眼
const AVATAR_SIZE = scaleSizeW(70)
const ROW_HEIGHT = 100
// tx 的歌手搜索每页最多只能要 20 条左右，要多了服务端会返回空列表（不是限流，见 SDK 里的注释）
const PAGE_LIMIT = 20
// 拆歌手名的分隔符。跟 utils/musicSdk/index.js 里 findMusic 那套约定一致，但没有共用：
// 那边拆完还要排序、空值处理也不同，为了一个正则去改找歌曲的匹配逻辑不划算
const SINGER_SPLIT_RXP = /、|&|;|；|\/|,|，|\|/

// 歌手名 -> 查到的那个歌手。null 表示 tx 上搜不到这个名字，也算结论，缓存下来免得反复问。
// 来回翻歌基本都命中（这个分支有意压低对音源的请求量）。上限很小，够装下最近听过的那几位
const CACHE_MAX = 20
const cache = new Map<string, SingerItem | null>()
const writeCache = (key: string, item: SingerItem | null) => {
  // 先删再塞，让最近用过的排到 Map 末尾（Map 保持插入顺序），淘汰时丢的就是最旧的
  cache.delete(key)
  cache.set(key, item)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest != null) cache.delete(oldest)
  }
}

// musicSdk 那边是 JS，类型得自己补：歌手搜索返回 { list, total }
const searchSinger = async(name: string, page: number) =>
  musicSdk.tx.musicSearch.searchSinger(name, page, PAGE_LIMIT) as Promise<{ list: SingerItem[], total: number }>

// 拿名字换歌手：同名的优先（搜「周杰伦」的第一条通常就是他，但不保证），实在没有就取第一条。
// 一条都没有说明这个人 tx 上搜不到，这一行就不显示了
const pickSinger = (list: SingerItem[], name: string) =>
  list.find(item => item.name.trim() == name) ?? list[0] ?? null

/**
 * 封面页前面那一页：列出这首歌的歌手，点一位就进歌手详情。
 *
 * 列表里就是这首歌的歌手本人，不是他的搜索结果：一首歌也就一两位歌手，所以只有一两行。
 * 歌里只存了歌手名字，要进详情得有 tx 的歌手 mid，所以每一行是拿名字去搜一次、取同名的那
 * 一位换来的（「周杰伦、费玉清」这种整串拿去搜是搜不到人的，得拆开一位一位搜）。
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
  // 初值就是 loading：这一页一露头就要去查，中间那一下别闪出「没有数据」
  const [status, setStatus] = useState<Status>('loading')
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

  // 这首歌的歌手，一位一行
  const load = useCallback(async(names: string[]) => {
    const seq = ++seqRef.current
    setStatus('loading')
    try {
      const items = await Promise.all(names.map(async(name) => {
        if (cache.has(name)) return cache.get(name) ?? null
        const result = await searchSinger(name, 1)
        const item = pickSinger(result.list, name)
        writeCache(name, item)
        return item
      }))
      if (!mountedRef.current || seq != seqRef.current) return
      setList(items.filter((item): item is SingerItem => item != null))
      setStatus('idle')
    } catch (err) {
      console.log(err)
      if (!mountedRef.current || seq != seqRef.current) return
      // 出错不写缓存，否则下次翻回来直接命中缓存，重试都救不回来
      setStatus('error')
    }
  }, [])

  // 只有真翻到这一页、而且歌确实换了才请求。PagerView 会把三页都挂上，挂载就发请求等于
  // 每次打开播放详情页都白打一次接口（这个分支有意压低对音源的请求量）
  useEffect(() => {
    if (!active) return
    if (!singers.length) {
      setList([])
      setStatus('idle')
      return
    }
    // 都查过了就直接摆出来，省掉一次「加载中」的闪烁
    if (singers.every(name => cache.has(name))) {
      setList(singers.map(name => cache.get(name)).filter((item): item is SingerItem => item != null))
      setStatus('idle')
      return
    }
    void load(singers)
  }, [active, singers, load])

  const handleRetry = useCallback(() => {
    if (singers.length) void load(singers)
  }, [singers, load])

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
        ListEmptyComponent={
          singers.length > 0 && status == 'idle'
            ? <Text style={styles.empty} color={theme['c-font-label']}>{t('no_item')}</Text>
            : null
        }
        ListFooterComponent={
          status == 'loading'
            ? <Text style={styles.footer} color={theme['c-font-label']}>{t('list_loading')}</Text>
            : status == 'error'
              ? <Text style={styles.footer} onPress={handleRetry} color={theme['c-font-label']}>{t('list_error')}</Text>
              : null
        }
      />
    </View>
  )
})

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
