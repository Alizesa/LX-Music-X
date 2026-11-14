import { setTempList } from '@/core/list'
import { createPlaySelection, playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'

const getListId = (mid: string) => `album__tx__${mid}`

export const handlePlay = async(mid: string, list: LX.Music.MusicInfoOnline[], index = 0) => {
  if (!list.length) return
  const selection = createPlaySelection()
  await setTempList(getListId(mid), [...list])
  if (selection()) await playList(LIST_IDS.TEMP, index, selection)
}
