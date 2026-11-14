import { arrPush, arrUnshift, formatPlayTime2 } from '@/utils'
import state from './state'

type PlayerMusicInfoKeys = keyof LX.Player.MusicInfo
const musicInfoKeys: PlayerMusicInfoKeys[] = Object.keys(state.musicInfo) as PlayerMusicInfoKeys[]

export default {
  updatePlayIndex(playIndex: number, playerPlayIndex: number) {
    state.playInfo.playIndex = playIndex
    state.playInfo.playerPlayIndex = playerPlayIndex

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayListId(playerListId: string | null) {
    state.playInfo.playerListId = playerListId

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayMusicInfo(listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean = false) {
    state.playMusicInfo = { listId, musicInfo, isTempPlay }

    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  },
  setMusicInfo(_musicInfo: Partial<LX.Player.MusicInfo>) {
    for (const key of musicInfoKeys) {
      const val = _musicInfo[key]
      if (val !== undefined) {
        // @ts-expect-error
        state.musicInfo[key] = val
      }
    }

    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  },
  setIsPlay(isPlay: boolean) {
    state.isPlay = isPlay

    global.state_event.playStateChanged(isPlay)
  },
  setStatusText(statusText: string) {
    state.statusText = statusText
    global.state_event.playStateTextChanged(statusText)
  },
  setNowPlayTime(time: number) {
    state.progress.nowPlayTime = time
    state.progress.nowPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = state.progress.maxPlayTime ? time / state.progress.maxPlayTime : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setMaxplayTime(time: number) {
    state.progress.maxPlayTime = time
    state.progress.maxPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = time ? state.progress.nowPlayTime / time : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setProgress(currentTime: number, totalTime: number) {
    state.progress.nowPlayTime = currentTime
    state.progress.nowPlayTimeStr = formatPlayTime2(currentTime)
    state.progress.maxPlayTime = totalTime
    state.progress.maxPlayTimeStr = formatPlayTime2(totalTime)
    state.progress.progress = totalTime ? state.progress.nowPlayTime / currentTime : 0

    global.state_event.playProgressChanged({ ...state.progress })
  },
  addPlayedList(info: LX.Player.PlayMusicInfo) {
    if (state.playedList.some(m => m.musicInfo.id == info.musicInfo.id)) return
    state.playedList.push(info)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  removePlayedList(index: number) {
    state.playedList.splice(index, 1)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  prunePlayedList(listId: string, queue: readonly LX.Player.PlayQueueItem[]) {
    if (!state.playedList.length) return
    const songs = new Map(queue.map(item => [item.musicInfo.id, item.musicInfo]))
    let changed = false
    const next: LX.Player.PlayMusicInfo[] = []
    for (const played of state.playedList) {
      if (played.listId !== listId) { next.push(played); continue }
      const musicInfo = songs.get(played.musicInfo.id)
      if (!musicInfo) { changed = true; continue }
      if (played.musicInfo === musicInfo) next.push(played)
      else {
        // 同一 ID 的新队列可能带来更新的元数据，不再钉住旧歌曲对象。
        next.push({ ...played, musicInfo })
        changed = true
      }
    }
    if (!changed) return
    state.playedList = next
    global.state_event.playPlayedListChanged([...next])
  },
  clearPlayedList() {
    state.playedList = []

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  addTempPlayList(list: LX.Player.TempPlayListItem[]) {
    const topList: Array<{ listId: string | null, musicInfo: LX.Music.MusicInfo | LX.Download.ListItem }> = []
    const bottomList = list.filter(({ isTop, ...musicInfo }) => {
      if (isTop) {
        topList.push(musicInfo)
        return false
      }
      return true
    })
    if (topList.length) arrUnshift(state.tempPlayList, topList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })))
    if (bottomList.length) arrPush(state.tempPlayList, bottomList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })))

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  removeTempPlayList(index: number) {
    state.tempPlayList.splice(index, 1)

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  clearTempPlayeList() {
    state.tempPlayList = []

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  setLoadErrorPicUrl(url: string) {
    state.loadErrorPicUrl = url
  },
  setLastLyric(lrc?: string) {
    state.lastLyric = lrc
  },
}
