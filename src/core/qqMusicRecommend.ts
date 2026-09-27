import { appendPlayQueue, getPlayQueue } from '@/core/player/playQueue'
import { getQQMusicDailyRecommendations, getQQMusicSession } from '@/core/qqMusic'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS } from '@/config/constant'

type CurrentPlayMusicInfo = typeof playerState['playMusicInfo']

// 只有「每日推荐」写入的这个 meta.id 需要续播，其它临时列表（试听、导入歌单等）不受影响
const RECOMMEND_TEMP_LIST_ID = 'qq_daily_recommend'
// 剩余未播少于这个数量就提前拉下一批，给网络往返留出时间
const REFRESH_THRESHOLD = 5
// 连续落空（上游给回来全是队列里已有的歌）或连续失败这么多次后，不再每次切歌都试一次
const MAX_CONSECUTIVE_FAILED = 3
// 上面的次数到了之后先等这么久再试。
// 不能像以前那样直接永久停掉：上游同一时段反复给同一批歌是正常的，
// 停掉之后这批播完就只能一直循环这 20 首，而且这一整场播放都不会再续上。
const RETRY_COOLDOWN = 3 * 60 * 1000

let initialized = false
let refreshing = false
let failedRounds = 0
// 退避到什么时候为止，0 表示不限制
let nextTryAt = 0
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

/** 记一次落空或失败，连续多次就退避一段时间再试 */
const failRound = () => {
  failedRounds++
  if (failedRounds >= MAX_CONSECUTIVE_FAILED) nextTryAt = Date.now() + RETRY_COOLDOWN
}

const refresh = async() => {
  if (refreshing) return
  refreshing = true
  try {
    const { cookie } = await getQQMusicSession()
    if (!cookie) {
      // 没登录或登录态失效：先退避，等用户重新登录后自然会续上
      failRound()
      return
    }
    const songs = await getQQMusicDailyRecommendations(cookie)
    // 推荐接口会重复给已经在列的歌曲，按整个队列去重，避免同一首歌反复入列
    const existing = new Set(getPlayQueue().map(item => item.musicInfo.id))
    const toAppend = songs.filter(song => !existing.has(song.id))
    if (!toAppend.length) {
      failRound()
      return
    }
    failedRounds = 0
    nextTryAt = 0
    await appendPlayQueue(LIST_IDS.TEMP, toAppend)
  } catch (error) {
    // 续播是后台行为，失败就安静退避，别每次切歌都白跑一个请求；
    // 但过一会儿还要再试，否则这批播完就没得续了
    failRound()
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
  // 换了一次播放会话就重置计数，重新给它机会
  if (nextSessionKey !== sessionKey) {
    sessionKey = nextSessionKey
    failedRounds = 0
    nextTryAt = 0
  }
  if (Date.now() < nextTryAt) return
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
