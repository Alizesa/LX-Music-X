import { getPlayQueueMusic, isPlayQueueFromList } from '@/core/player/playQueue'
import playerState from '@/store/player/state'
import { getQQMusicRecommendSession, removeQQMusicRecommendSession, saveQQMusicRecommendSession } from '@/utils/data'
import { QQ_DAILY_RECOMMEND_QUEUE_SOURCE } from '@/config/constant'

/**
 * 「每日推荐」的播放存档。
 *
 * 播放队列只有一个槽位，切到别的歌单时 playList 会把整条队列替换掉，
 * 推荐队列连同播放过程中自动续上的那几批就都没了，再点「每日推荐」只能
 * 从缓存那 20 首的第一首重来。所以离开前把队列和播放位置存下来，回来时接着放。
 *
 * 本模块只管存档的存取（队列 + store + 存储），不 import player.ts：
 * 一来 player.ts 要在这里挂「换队列前先存档」的钩子，二来起播得由 player.ts 做。
 */

// 内存里的那份存档。切走这一瞬间要立刻记下来，不能等读盘
let session: LX.QQMusic.RecommendSession | null = null
// 是否已经从磁盘读过一次（读不到也算读过，不然每次都要白读一遍盘）
let loaded = false
// 正在读盘的那次。同一次启动里连着点几下只读一次
let loading: Promise<LX.QQMusic.RecommendSession | null> | null = null

const isSameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
// 跨天的存档作废：推荐内容本来就该换新的一批
const isExpired = (s: LX.QQMusic.RecommendSession) => !isSameDay(s.savedAt, Date.now())

/**
 * 存档是尽力而为的：读写失败都只记一条日志。
 * parkRecommendQueue 在切歌的关键路径上（playList 换了队列就晚了），
 * 读存档则在点「每日推荐」时 —— 都不该因为一次存储抖动让切歌/起播整个失败，
 * 内存里那份存档也还在。
 */
const onStorageError = (error: unknown): null => {
  console.warn('[QQMusic] recommend session io failed:', error instanceof Error ? error.message : error)
  return null
}

/**
 * 当前队列是不是「每日推荐」建的那条。
 * 看队列自己的来源标记，不看临时列表的标记：排行榜/歌单/歌手都往临时列表里放，
 * 而且调用方在 playList 之前就已经 setTempList 把那个标记改成新列表了。
 */
export const isRecommendQueue = () => isPlayQueueFromList(QQ_DAILY_RECOMMEND_QUEUE_SOURCE)

/**
 * 离开推荐队列前把整条队列和播放位置存下来。
 * 必须在换队列之前调用：replacePlayQueue 是就地改写同一个数组的，晚了就只剩新队列了。
 */
export const parkRecommendQueue = async() => {
  if (!isRecommendQueue()) return
  const songs = getPlayQueueMusic()
  if (!songs.length) return
  session = {
    songs,
    index: Math.max(0, playerState.playInfo.playerPlayIndex),
    savedAt: Date.now(),
  }
  loaded = true
  await saveQQMusicRecommendSession(session).catch(onStorageError)
}

const readSession = async(): Promise<LX.QQMusic.RecommendSession | null> => {
  const saved = await getQQMusicRecommendSession().catch(onStorageError)
  loaded = true
  // 读盘期间又切走了一次推荐队列（park 写了更新的一份），以内存里那份为准
  if (session) return session
  if (!saved?.songs.length) return null
  if (isExpired(saved)) {
    await removeQQMusicRecommendSession().catch(onStorageError)
    return null
  }
  session = saved
  return session
}

/** 取当天存下的存档。跨天的直接作废，等在内存里放过了零点也一样 */
export const getRecommendSession = async(): Promise<LX.QQMusic.RecommendSession | null> => {
  if (session) {
    if (!isExpired(session)) return session
    await dropRecommendSession()
    return null
  }
  if (loaded) return null
  loading ??= readSession()
  return loading
}

/** 丢掉存档。手动点「刷新」拿到新一批推荐时用，跨天由 getRecommendSession 自己处理 */
export const dropRecommendSession = async() => {
  session = null
  loaded = true
  loading = null
  await removeQQMusicRecommendSession().catch(onStorageError)
}
