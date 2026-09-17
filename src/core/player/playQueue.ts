import { getPlayQueue as getSavedPlayQueue, savePlayQueue } from '@/utils/data'

const queue: LX.Player.PlayQueueItem[] = []
let initialized = false

const commit = async() => {
  await savePlayQueue(queue)
  global.app_event.playQueueUpdate([...queue])
}

export const initPlayQueue = async() => {
  if (initialized) return
  initialized = true
  queue.splice(0, queue.length, ...(await getSavedPlayQueue()))
}

export const getPlayQueue = () => queue
export const getPlayQueueMusic = () => queue.map(item => item.musicInfo)

export const replacePlayQueue = async(sourceListId: string, list: LX.Player.PlayMusic[]) => {
  const seed = Date.now().toString(36)
  queue.splice(0, queue.length, ...list.map((musicInfo, index) => ({
    queueId: `${seed}_${index}_${musicInfo.id}`,
    sourceListId,
    musicInfo,
  })))
  await commit()
}

/**
 * 往播放队列尾部追加歌曲，用于「每日推荐」这类需要持续续播的列表。
 * 追加而不是替换，所以当前播放位置与已播记录都不受影响。
 */
export const appendPlayQueue = async(sourceListId: string, list: LX.Player.PlayMusic[]) => {
  if (!list.length) return
  const seed = Date.now().toString(36)
  const start = queue.length
  list.forEach((musicInfo, offset) => {
    queue.push({
      queueId: `${seed}_${start + offset}_${musicInfo.id}`,
      sourceListId,
      musicInfo,
    })
  })
  await commit()
}

export const removePlayQueueItem = async(index: number) => {
  if (index < 0 || index >= queue.length) return
  queue.splice(index, 1)
  await commit()
}

export const movePlayQueueItem = async(from: number, to: number) => {
  if (from == to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return
  const [item] = queue.splice(from, 1)
  queue.splice(to, 0, item)
  await commit()
}

export const clearPlayQueue = async() => {
  queue.splice(0, queue.length)
  await commit()
}
