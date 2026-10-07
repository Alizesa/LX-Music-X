import { getPlayQueue as getSavedPlayQueue, savePlayQueue } from '@/utils/data'
import { LIST_IDS } from '@/config/constant'

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

/**
 * 当前队列是不是由某个列表建出来的。
 * 只看首项：整条队列来自一次 replace，来源是同一批；
 * 用 every 反而会被「旧队列 + 新追加」的混合队列判成 false。
 */
export const isPlayQueueFromList = (sourceListId: string) => queue[0]?.sourceListId === sourceListId

/** 就地改写整条队列的来源标记。歌曲、顺序、queueId 都不动，只给老数据补标记用 */
export const restampPlayQueue = async(sourceListId: string) => {
  let changed = false
  for (const item of queue) {
    if (item.sourceListId === sourceListId) continue
    item.sourceListId = sourceListId
    changed = true
  }
  if (changed) await commit()
}

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

/**
 * 往播放队列中间插入歌曲，用于「添加到播放列表」。
 * 插进去的歌曲跟着这条队列的来源标记走：队列的来源只认首项（isPlayQueueFromList），
 * 乱打标记会让「每日推荐」那套续播逻辑认不出自己的队列。
 * 队列空的时候（清空过队列、或刚装好还没播过）没得继承，标成播放队列自己 —— 不能用
 * LIST_IDS.TEMP：整条队列都是 temp 是「这原来是每日推荐的老队列」的判据（migrateRecommendPlayQueue），
 * 拿它兜底会把用户手攒的队列在下次启动时认成推荐队列，接着自动往里灌推荐歌
 */
export const insertPlayQueue = async(index: number, list: LX.Player.PlayMusic[]) => {
  if (!list.length) return
  const sourceListId = queue[0]?.sourceListId ?? LIST_IDS.PLAY_QUEUE
  const start = Math.min(Math.max(index, 0), queue.length)
  const seed = Date.now().toString(36)
  queue.splice(start, 0, ...list.map((musicInfo, offset) => ({
    queueId: `${seed}_${start + offset}_${musicInfo.id}`,
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
