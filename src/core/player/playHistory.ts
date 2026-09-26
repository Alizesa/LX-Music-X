import { getPlayHistory, savePlayHistory } from '@/utils/data'
import settingState from '@/store/setting/state'

let writeQueue = Promise.resolve()

export const addPlayHistory = async(musicInfo: LX.Player.PlayMusic) => {
  writeQueue = writeQueue.catch(() => {}).then(async() => {
    const history = await getPlayHistory()
    const nextHistory = history.filter(item => item.musicInfo.id !== musicInfo.id)
    nextHistory.unshift({ musicInfo, playedAt: Date.now() })
    const maxCount = settingState.setting['player.playHistoryMaxCount']
    const savedHistory = maxCount > 0 ? nextHistory.slice(0, maxCount) : nextHistory
    await savePlayHistory(savedHistory)
    global.app_event.playHistoryUpdate(savedHistory)
  })
  await writeQueue
}

export const trimPlayHistory = async(maxCount: number) => {
  writeQueue = writeQueue.catch(() => {}).then(async() => {
    const history = await getPlayHistory()
    if (maxCount > 0 && history.length > maxCount) {
      const savedHistory = history.slice(0, maxCount)
      await savePlayHistory(savedHistory)
      global.app_event.playHistoryUpdate(savedHistory)
    }
  })
  await writeQueue
}
