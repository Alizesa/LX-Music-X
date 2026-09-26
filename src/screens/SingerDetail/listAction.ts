import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'

/** 歌手页的列表按歌手区分，播放全部和单曲播放都往这个临时列表里放 */
const getListId = (mid: string) => `singer__tx__${mid}`

export const handlePlay = async(mid: string, list: LX.Music.MusicInfoOnline[], index = 0) => {
  if (!list.length) return
  await setTempList(getListId(mid), [...list])
  void playList(LIST_IDS.TEMP, index)
}
