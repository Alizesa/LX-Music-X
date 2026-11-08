import {
  getQQMusicDailyPlaylist, getQQMusicDailyRecommendations, getQQMusicHeartRadarSongs,
  getQQMusicRecommendedPlaylists, isQQMusicSessionCurrent, QQMusicSessionExpiredError,
  writeQQMusicSessionCache, type QQMusicSession,
} from './qqMusic'
import {
  saveQQMusicDailyPlaylistCache, saveQQMusicDailyRecommendCache, saveQQMusicHeartRadarCache,
  saveQQMusicRecommendPlaylistsCache, saveQQMusicRefreshDay,
} from '@/utils/data'
import { dropRecommendSession } from './qqMusicRecommendSession'

/** 首页各板块共用会话校验和落盘流程；过期响应不再写缓存或「今日已刷新」标记。 */
const refreshHomeCache = async<T>(session: QQMusicSession | null, request: (cookie: string) => Promise<T>, save: (value: T) => Promise<void>): Promise<T> => {
  if (!session?.cookie || !isQQMusicSessionCurrent(session)) throw new QQMusicSessionExpiredError()
  const value = await request(session.cookie)
  if (!await writeQQMusicSessionCache(session, async() => { await save(value) })) throw new QQMusicSessionExpiredError()
  return value
}

export const refreshQQMusicHomeDaily = async(session: QQMusicSession | null) => refreshHomeCache(session, getQQMusicDailyPlaylist, async songs => {
  await saveQQMusicDailyPlaylistCache(songs)
  await saveQQMusicRefreshDay('playlist')
})

export const refreshQQMusicHomeGuess = async(session: QQMusicSession | null) => refreshHomeCache(session, getQQMusicDailyRecommendations, async songs => {
  if (!songs.length) throw new Error(global.i18n.t('qq_load_failed'))
  await saveQQMusicDailyRecommendCache(songs)
  await saveQQMusicRefreshDay('recommend')
  await dropRecommendSession()
})

export const refreshQQMusicHomeRadar = async(session: QQMusicSession | null) => refreshHomeCache(session, getQQMusicHeartRadarSongs, async songs => {
  await saveQQMusicHeartRadarCache(songs)
  await saveQQMusicRefreshDay('radar')
})

export const refreshQQMusicHomePlaylists = async(session: QQMusicSession | null) => refreshHomeCache(session, getQQMusicRecommendedPlaylists, async list => {
  await saveQQMusicRecommendPlaylistsCache({ list, nextFrom: 0 })
})
