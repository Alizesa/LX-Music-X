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
