import { appendPlayQueue, getPlayQueue, getPlayQueueMusic, getPlayQueueSessionId, getPlayQueueSourceFirstMusicId, getPlayQueueSourceBatchKey, replacePlayQueue, restampPlayQueue } from '@/core/player/playQueue'
import { getQQMusicDailyRecommendations, getQQMusicSession } from '@/core/qqMusic'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS, QQ_DAILY_RECOMMEND_ID, QQ_DAILY_RECOMMEND_QUEUE_SOURCE } from '@/config/constant'
import { dropRecommendSession, getRecommendSession, isRecommendQueue } from '@/core/qqMusicRecommendSession'
import { createPlaySelection, play, playList } from '@/core/player/player'
import { clearPlayedList } from '@/core/player/playedList'

type CurrentPlayMusicInfo = typeof playerState['playMusicInfo']

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
// 建队列时的标识；裁剪历史不会被误认成新会话，也不会重置失败退避
let sessionKey = ''

const currentIndexInQueue = (musicInfoId: string) => getPlayQueue()
  .findIndex(item => item.musicInfo.id === musicInfoId)

const shouldRefresh = (playMusicInfo: CurrentPlayMusicInfo) => {
  const musicInfo = playMusicInfo.musicInfo
  if (!musicInfo || playMusicInfo.isTempPlay) return false
  if (playerState.playInfo.playerListId !== LIST_IDS.PLAY_QUEUE) return false
  // 认队列自己的来源标记，不认临时列表的 meta：那个标记切到别的列表时就被改掉了
  if (!isRecommendQueue()) return false
  const index = currentIndexInQueue(musicInfo.id)
  if (index < 0) return false
  return getPlayQueue().length - 1 - index < REFRESH_THRESHOLD
}

/** 记一次落空或失败，连续多次就退避一段时间再试 */
const failRound = () => {
  failedRounds++
  if (failedRounds >= MAX_CONSECUTIVE_FAILED) nextTryAt = Date.now() + RETRY_COOLDOWN
}

const refresh = async() => {
  if (refreshing) return
  refreshing = true
  // 两次网络往返期间用户可能切走队列。记下发起时的建队标识：
  // 回来发现已经不是同一条推荐队列，就不能再往新队列里追加推荐歌
  const sessionId = getPlayQueueSessionId()
  const isStillRecommendQueue = () => sessionId === getPlayQueueSessionId() && isRecommendQueue()
  try {
    const { cookie } = await getQQMusicSession()
    if (!isStillRecommendQueue()) return
    if (!cookie) {
      // 没登录或登录态失效：先退避，等用户重新登录后自然会续上
      failRound()
      return
    }
    const songs = await getQQMusicDailyRecommendations(cookie)
    if (!isStillRecommendQueue()) return
    // 推荐接口会重复给已经在列的歌曲，按整个队列去重，避免同一首歌反复入列
    const existing = new Set(getPlayQueue().map(item => item.musicInfo.id))
    const toAppend = songs.filter(song => !existing.has(song.id))
    if (!toAppend.length) {
      failRound()
      return
    }
    failedRounds = 0
    nextTryAt = 0
    // 标记要和建队列时一致，否则续播/存档会静默认不出这条队列
    await appendPlayQueue(QQ_DAILY_RECOMMEND_QUEUE_SOURCE, toAppend)
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
  const nextSessionKey = getPlayQueueSessionId()
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

const getBatchKey = (songs: LX.Player.PlayMusic[]) => JSON.stringify(songs.map(song => song.id))

const matchesBatch = (batchKey: string | undefined, firstId: string | undefined, songs: LX.Player.PlayMusic[], currentSongs: LX.Player.PlayMusic[]) => {
  if (!currentSongs.length) return true
  if (batchKey !== undefined) return batchKey === getBatchKey(currentSongs)
  // 旧数据没有原始批次长度；只有整份队列与卡片一致时才可迁移，
  // 不能把较短的新卡片当作旧长队列的原始批次。
  return firstId === currentSongs[0].id && songs.length === currentSongs.length &&
    currentSongs.every((song, index) => song.id === songs[index].id)
}

const replaceRecommendQueue = async(songs: LX.Player.PlayMusic[], index: number, sourceFirstMusicId: string | undefined, isCurrent: () => boolean, batchKey: string | undefined) => {
  if (!songs.length || !isCurrent()) return false
  // 随机模式下 playNext 会先走已播列表，而那份记录不区分列表（队列播放的 listId 都是
  // play_queue），换一批新队列后可能先蹦出一首上一个列表的歌。重启恢复时它本来就是空的，
  // 这里也清掉，两条路径保持一致。
  clearPlayedList()
  const saved = replacePlayQueue(QQ_DAILY_RECOMMEND_QUEUE_SOURCE, songs, sourceFirstMusicId, batchKey)
  // replace 同步更新内存队列；与普通点播一样先确认播放选择，再等待落盘。
  // 不能在保存结束后用旧下标对届时的新队列再次发起点播。
  await Promise.all([saved, playList(LIST_IDS.PLAY_QUEUE, Math.max(0, Math.min(index, songs.length - 1)), isCurrent)])
  return true
}

/** 新推荐记录整批歌曲的身份；恢复存档时必须保留原始标识，不能按扩展后的队列重算。 */
export const startRecommendQueue = async(songs: LX.Player.PlayMusic[], index = 0, sourceFirstMusicId = songs[0]?.id, isCurrent: () => boolean = createPlaySelection()) => {
  return replaceRecommendQueue(songs, index, sourceFirstMusicId, isCurrent, getBatchKey(songs))
}

/**
 * 点「猜你喜欢」时先试着接手，返回是否已经处理完。三种情况：
 * 1. 队列本来就是推荐队列，且和当前这份推荐是同一批 → 接着播，不重建
 *    （重建会把自动续上的批次丢回那 20 首，这正是「又从第一首开始」的原因）；
 * 2. 切走时留下的当天存档还在，且对应当前这批推荐 → 还原队列和位置；
 * 3. 都没有 → false，调用方按原来的「读缓存/联网 + 从头播」走。
 * 读取期间选择已失效 → null，调用方结束本次操作，不再创建推荐队列。
 * @param currentSongs 当前这份推荐（页面上缓存的那批），用来判断队列是不是同一批
 */
export const continueRecommendQueue = async(currentSongs: LX.Player.PlayMusic[], isCurrent: () => boolean = createPlaySelection()): Promise<boolean | null> => {
  if (!isCurrent()) return null
  if (isRecommendQueue()) {
    const batchKey = getPlayQueueSourceBatchKey()
    if (!matchesBatch(batchKey, getPlayQueueSourceFirstMusicId(), getPlayQueueMusic(), currentSongs)) return false
    if (batchKey === undefined && currentSongs.length) {
      await restampPlayQueue(QQ_DAILY_RECOMMEND_QUEUE_SOURCE, getBatchKey(currentSongs))
      if (!isCurrent()) return null
    }
    if (!playerState.isPlay) {
      // 暂停着就接着放；已经停掉（playMusicInfo 被清了）就按上次的位置重新起播
      if (playerState.playMusicInfo.musicInfo) play()
      else await playList(LIST_IDS.PLAY_QUEUE, Math.max(0, playerState.playInfo.playerPlayIndex), isCurrent)
    }
    return true
  }
  const session = await getRecommendSession()
  if (!isCurrent()) return null
  if (!session) return false
  // 卡片刷新后，尚未切走的旧队列仍可能被再次存档。
  // savedAt 只反映切走时间；和当前队列一样，恢复存档也要核对原始批次。
  if (!matchesBatch(session.sourceBatchKey, session.sourceFirstMusicId, session.songs, currentSongs)) {
    await dropRecommendSession(session)
    return isCurrent() ? false : null
  }
  const batchKey = session.sourceBatchKey ?? (currentSongs.length ? getBatchKey(currentSongs) : undefined)
  if (!await replaceRecommendQueue(session.songs, session.index, session.sourceFirstMusicId, isCurrent, batchKey)) return null
  // 已经恢复成播放队列，存档的内存/磁盘副本可以放掉
  await dropRecommendSession(session)
  return true
}

/**
 * 老版本落盘的推荐队列没有专属来源标记（那时记的是临时列表 temp），启动时补一次。
 * 之后所有判断只看队列自己的标记 —— 临时列表标记会被下一个列表的 setTempList 立刻改写，
 * 在离开队列的那一刻已经不可靠了。
 */
export const migrateRecommendPlayQueue = async() => {
  if (listState.tempListMeta.id !== QQ_DAILY_RECOMMEND_ID) return
  const queue = getPlayQueue()
  if (!queue.length) return
  // 整条队列都来自临时列表才敢认：混进别的来源就说明这不是推荐队列
  if (queue.some(item => item.sourceListId !== LIST_IDS.TEMP)) return
  await restampPlayQueue(QQ_DAILY_RECOMMEND_QUEUE_SOURCE)
}
