import {
  getQQMusicDailyPosition,
  getQQMusicHeartRadarPosition,
  removeQQMusicDailyPosition,
  removeQQMusicHeartRadarPosition,
  saveQQMusicDailyPosition,
  saveQQMusicHeartRadarPosition,
} from '@/utils/data'
import { getListMusics, setTempList } from '@/core/list'
import { createPlaySelection, playList } from '@/core/player/player'
import { isPlayQueueFromList } from '@/core/player/playQueue'
import listState from '@/store/list/state'
import playerState from '@/store/player/state'
import { LIST_IDS, QQ_HEART_RADAR_PLAYLIST_ID } from '@/config/constant'

/** 每日推荐那批歌存进临时列表时用的 id（见 Home/Views/Recommend） */
export const QQ_DAILY_PLAYLIST_ID = 'qq_daily_playlist'

interface Position {
  songId: string
  savedAt: number
}
interface PositionStore {
  get: () => Promise<Position | null>
  save: (position: Position) => Promise<void>
  remove: () => Promise<void>
}

/** 跨天的存档作废：这类列表每天都换一批，昨天记的位置只对昨天那批有意义 */
const isSameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

const createPlaylistPosition = (listId: string, store: PositionStore, logLabel: string) => {
  // 存档是尽力而为的：读写失败只记一条日志。
  // 读这一侧在起播的关键路径上（返回值决定起播位置），不该因为一次存储抖动就让整个起播失败。
  const onStorageError = (error: unknown): null => {
    console.warn(`[QQMusic] ${logLabel} position io failed:`, error instanceof Error ? error.message : error)
    return null
  }

  /**
   * 记「这个列表播到哪了」。
   *
   * 只记当前这首歌的 id，**不记下标**：下次打开时列表内容可能已经换了，存下标会指到
   * 别的歌上；按 id 找就没这个问题，找不到自然退回开头。
   *
   * 认的是「当前这条播放队列是这个列表建出来的」，光看临时列表标记不够：那个标记只在
   * setTempList 时才变，别的入口（比如猜你喜欢接手存档）可能直接起播、不改标记。
   * 所以还要确认这首歌确实在那批歌里（读异步那份：重启后临时列表还没载入内存）。
   */
  const init = () => {
    global.state_event.on('playerMusicInfoChanged', () => {
      if (!isPlayQueueFromList(LIST_IDS.TEMP)) return
      if (listState.tempListMeta.id != listId) return
      // 插进来的「稍后播放」不属于这条列表
      if (playerState.playMusicInfo.isTempPlay) return
      const raw = playerState.playMusicInfo.musicInfo
      if (!raw) return
      const musicInfo = 'progress' in raw ? raw.metadata.musicInfo : raw
      void getListMusics(LIST_IDS.TEMP).then(songs => {
        if (!songs.some(song => song.id == musicInfo.id)) return
        void store.save({ songId: musicInfo.id, savedAt: Date.now() })
      })
    })
  }

  /**
   * 上次播到的那首歌在当前列表里的位置；找不到就从头放（0）。
   * 今天换了新的一批、或那首歌被下掉了，都会落到 0。
   */
  const resolveIndex = async(songs: LX.Music.MusicInfoOnline[]) => {
    const saved = await store.get().catch(onStorageError)
    if (!saved) return 0
    if (!isSameDay(saved.savedAt, Date.now())) {
      // 作废掉的那份留着没意义，顺手清掉，免得下次再判一遍；清失败不影响这次起播
      void store.remove().catch(onStorageError)
      return 0
    }
    return Math.max(songs.findIndex(song => song.id == saved.songId), 0)
  }

  /**
   * 从记下的位置开始播一批歌：先定位，再把这批灌进临时列表（顺带打上来源标记，
   * 位置记忆靠它认队列），最后起播。首页播放钮和歌单页的「播放」都走这里。
   */
  const play = async(songs: LX.Music.MusicInfoOnline[], isCurrent: () => boolean = createPlaySelection()) => {
    if (!songs.length || !isCurrent()) return
    const startIndex = await resolveIndex(songs)
    if (!isCurrent()) return
    await setTempList(listId, [...songs])
    if (!isCurrent()) return
    await playList(LIST_IDS.TEMP, startIndex, isCurrent)
  }

  return { init, resolveIndex, play }
}

const dailyPosition = createPlaylistPosition(QQ_DAILY_PLAYLIST_ID, {
  get: getQQMusicDailyPosition,
  save: saveQQMusicDailyPosition,
  remove: removeQQMusicDailyPosition,
}, 'daily')
const heartRadarPosition = createPlaylistPosition(QQ_HEART_RADAR_PLAYLIST_ID, {
  get: getQQMusicHeartRadarPosition,
  save: saveQQMusicHeartRadarPosition,
  remove: removeQQMusicHeartRadarPosition,
}, 'heart radar')

export const initQQMusicDailyPosition = dailyPosition.init
export const playQQMusicDailyPlaylist = dailyPosition.play

/** 红心雷达和每日推荐一样有播放位置记忆（同样按天作废） */
export const initQQMusicHeartRadarPosition = heartRadarPosition.init
export const playQQMusicHeartRadarPlaylist = heartRadarPosition.play
