import { appendPlayQueue, getPlayQueue } from '@/core/player/playQueue'
import { getQQMusicDailyRecommendations, getQQMusicSession } from '@/core/qqMusic'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS } from '@/config/constant'

type CurrentPlayMusicInfo = typeof playerState['playMusicInfo']

// 只有「每日推荐」写入的这个 meta.id 需要续播，其它临时列表（试听、导入歌单等）不受影响。
// 首页和 QQ 音乐页播的是同一批推荐，必须共用这个 id，否则首页点播的歌认不出来，播完不补歌。
export const RECOMMEND_TEMP_LIST_ID = 'qq_daily_recommend'
// 剩余未播少于这个数量就提前拉下一批，给网络往返留出时间
const REFRESH_THRESHOLD = 5
// 上游若改成固定池，续播会一直拿不到新歌。连续这么多次落空后就不再重试，
// 免得每次切歌都白跑一个请求。
const MAX_CONSECUTIVE_EMPTY = 3

let initialized = false
let refreshing = false
let emptyRounds = 0
// 队列首项的 queueId。队列被 replace 后会变，用来判断是否换了一次播放会话
let sessionKey = ''

const currentIndexInQueue = (musicInfoId: string) => getPlayQueue()
  .findIndex(item => item.musicInfo.id === musicInfoId)

const shouldRefresh = (playMusicInfo: CurrentPlayMusicInfo) => {
  const musicInfo = playMusicInfo.musicInfo
  if (!musicInfo || playMusicInfo.isTempPlay) return false
  if (listState.tempListMeta.id !== RECOMMEND_TEMP_LIST_ID) return false
  if (playerState.playInfo.playerListId !== LIST_IDS.PLAY_QUEUE) return false
  const queue = getPlayQueue()
  const index = currentIndexInQueue(musicInfo.id)
  if (index < 0) return false
  // setTempList 写入的 meta 在切到别的音乐后可能残留，再确认当前队列确实来自临时列表
  if (queue[index].sourceListId !== LIST_IDS.TEMP) return false
  return queue.length - 1 - index < REFRESH_THRESHOLD
}

const refresh = async() => {
  if (refreshing) return
  refreshing = true
  try {
    const { cookie } = await getQQMusicSession()
    if (!cookie) return
    const songs = await getQQMusicDailyRecommendations(cookie)
    // 推荐接口会重复给已经在列的歌曲，按整个队列去重，避免同一首歌反复入列
    const existing = new Set(getPlayQueue().map(item => item.musicInfo.id))
    const toAppend = songs.filter(song => !existing.has(song.id))
    if (!toAppend.length) {
      emptyRounds++
      return
    }
    emptyRounds = 0
    await appendPlayQueue(LIST_IDS.TEMP, toAppend)
  } catch (error) {
    // 续播是后台行为，失败就安静放弃，等下次切歌再试
    console.warn('[QQMusic] auto refresh failed:', error instanceof Error ? error.message : error)
  } finally {
    // refreshing 在第一个 await 之前就已置位，单线程下不会被并发改写
    // eslint-disable-next-line require-atomic-updates
    refreshing = false
  }
}

const handlePlayMusicInfoChanged = (playMusicInfo: CurrentPlayMusicInfo) => {
  const queue = getPlayQueue()
  const nextSessionKey = queue[0]?.queueId ?? ''
  // 换了一次播放会话就重置落空计数，重新给它机会
  if (nextSessionKey !== sessionKey) {
    sessionKey = nextSessionKey
    emptyRounds = 0
  }
  if (emptyRounds >= MAX_CONSECUTIVE_EMPTY) return
  if (!shouldRefresh(playMusicInfo)) return
  void refresh()
}

/**
 * 让「每日推荐」在接近播完时自动续下一批，播完不再只是循环那 20 首。
 * 幂等，可重复调用。
 */
export const initQQMusicRecommendAutoRefresh = () => {
  if (initialized) return
  initialized = true
  global.state_event.on('playMusicInfoChanged', handlePlayMusicInfoChanged)
}

// 首页/「我的」这类展示页只需要保证进页面时数据不是空的，没必要每次挂载都回源。
// 切 Tab、从旧功能页返回都会重新挂载页面，用进程内的时间戳做闸门把请求压到最低：
// 同一次启动内只在第一次进页面（或超过间隔后）取一次，其余时候读缓存。
// 失败时不记时间，下次进页面还能重试；下拉刷新不受闸门限制。
const VIEW_REFRESH_INTERVAL = 30 * 60 * 1000
const viewRefreshedAt: Record<string, number> = {}

export const shouldRefreshQQMusicViewData = (key: string) =>
  Date.now() - (viewRefreshedAt[key] ?? 0) >= VIEW_REFRESH_INTERVAL

export const markQQMusicViewDataRefreshed = (key: string) => {
  viewRefreshedAt[key] = Date.now()
}
