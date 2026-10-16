import { getQQMusicDailyPosition, removeQQMusicDailyPosition, saveQQMusicDailyPosition } from '@/utils/data'
import { getListMusics, setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { isPlayQueueFromList } from '@/core/player/playQueue'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS } from '@/config/constant'

/** 每日推荐那批歌存进临时列表时用的 id（见 Home/Views/Recommend） */
export const QQ_DAILY_PLAYLIST_ID = 'qq_daily_playlist'

/**
 * 记「每日推荐播到哪了」。
 *
 * 只记当前这首歌的 id，**不记下标**：下次打开时列表内容可能已经换了（每日推荐本身每天
 * 就换一批），存下标会指到别的歌上；按 id 找就没这个问题，找不到自然退回开头。
 *
 * 认的是「当前这条播放队列是每日推荐建出来的」，光看临时列表标记不够：那个标记只在
 * setTempList 时才变，而点「猜你喜欢」时若走的是接手存档那条分支（
 * qqMusicRecommend.continueRecommendQueue 返回 true），playGuess 直接 return，
 * 根本不调 setTempList —— 标记还停在每日推荐上，猜你喜欢的歌就被记进这份位置里了。
 * 回头再点每日推荐，那首歌不在 30 首里，只能退回第一首。
 * 队列自己的来源标记没这个问题，它跟着队列一起被 replace 掉（同 qqMusicRecommendSession）。
 */
export const initQQMusicDailyPosition = () => {
  global.state_event.on('playerMusicInfoChanged', () => {
    // 每日推荐整表播放走的是临时列表（Recommend 里的 playDaily）。
    // 猜你喜欢用自己的队列标记，单曲播放和试听列表则会把队列换成别的来源，都不该记。
    if (!isPlayQueueFromList(LIST_IDS.TEMP)) return
    if (listState.tempListMeta.id != QQ_DAILY_PLAYLIST_ID) return
    // 插进来的「稍后播放」不属于这条列表
    if (playerState.playMusicInfo.isTempPlay) return
    const raw = playerState.playMusicInfo.musicInfo
    if (!raw) return
    const musicInfo = 'progress' in raw ? raw.metadata.musicInfo : raw
    // 上面三道还不够：单曲播放是往队列尾部追加（见 OnlineList 的 handlePlay），
    // 新歌会继承队列首项的 temp 标记，而首项可能正是每日推荐那批 —— 队列来源和
    // 临时列表标记都没变，于是别的歌也能混进来被记成「每日推荐播到哪了」。
    // 所以再确认这首确实在那批歌里：每日推荐整表播放就是把那批灌进临时列表的。
    // 读用异步那份：重启后临时列表还没载入内存，同步读会读到空
    void getListMusics(LIST_IDS.TEMP).then(songs => {
      if (!songs.some(song => song.id == musicInfo.id)) return
      void saveQQMusicDailyPosition({ songId: musicInfo.id, savedAt: Date.now() })
    })
  })
}

/** 跨天的存档作废：每日推荐每天都换一批，昨天记的位置只对昨天那批有意义 */
const isSameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

// 存档是尽力而为的：读写失败只记一条日志。
// 读这一侧在点「每日推荐」的关键路径上（resolveQQMusicDailyIndex 的返回值决定起播位置），
// 不该因为一次存储抖动就让整个起播失败。同 qqMusicRecommendSession 的 onStorageError。
const onStorageError = (error: unknown): null => {
  console.warn('[QQMusic] daily position io failed:', error instanceof Error ? error.message : error)
  return null
}

/**
 * 上次播到的那首歌在当前列表里的位置；找不到就从头放（0）。
 * 今天换了新的一批、或那首歌被下掉了，都会落到 0。
 *
 * 跨天也作废：昨天那首哪怕今天还在列表里，也从头开始放
 * （与 qqMusicRecommendSession 的存档同一个规矩）。
 */
export const resolveQQMusicDailyIndex = async(songs: LX.Music.MusicInfoOnline[]) => {
  const saved = await getQQMusicDailyPosition().catch(onStorageError)
  if (!saved) return 0
  if (!isSameDay(saved.savedAt, Date.now())) {
    // 作废掉的那份留着没意义，顺手清掉，免得下次再判一遍；清失败不影响这次起播
    void removeQQMusicDailyPosition().catch(onStorageError)
    return 0
  }
  return Math.max(songs.findIndex(song => song.id == saved.songId), 0)
}

/**
 * 从记下的位置开始播一批每日推荐：先定位，再把这批灌进临时列表（顺带打上来源标记，
 * 位置记忆靠它认队列），最后起播。
 *
 * 首页卡片上的播放钮和每日推荐页里的「播放」都走这里，两处行为不会走散。
 */
export const playQQMusicDailyPlaylist = async(songs: LX.Music.MusicInfoOnline[]) => {
  if (!songs.length) return
  const startIndex = await resolveQQMusicDailyIndex(songs)
  await setTempList(QQ_DAILY_PLAYLIST_ID, [...songs])
  void playList(LIST_IDS.TEMP, startIndex)
}
