import { withRequestSignal } from '@/utils/musicSdk/requestScope'
import tipSearch from './tipSearch'
import musicSearch from './musicSearch'
import lyric from './lyric'
import pic from './pic'
import songList from './songList'
import hotSearch from './hotSearch'
import comment from './comment'

const kw = {
  tipSearch,
  musicSearch,
  songList,
  hotSearch,
  comment,
  getLyric(songInfo, isGetLyricx) {
    return withRequestSignal(lyric, this.requestSignal).getLyric(songInfo, isGetLyricx)
  },

  getPic(songInfo) {
    return withRequestSignal(pic, this.requestSignal).getPic(songInfo)
  },

  getMusicDetailPageUrl(songInfo) {
    return `http://www.kuwo.cn/play_detail/${songInfo.songmid}`
  },
}

export default kw
