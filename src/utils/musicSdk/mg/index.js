import { withRequestSignal } from '@/utils/musicSdk/requestScope'
import songList from './songList'
import musicSearch from './musicSearch'
import pic from './pic'
import lyric from './lyric'
import hotSearch from './hotSearch'
import comment from './comment'

const mg = {
  songList,
  musicSearch,
  hotSearch,
  comment,
  getLyric(songInfo) {
    return withRequestSignal(lyric, this.requestSignal).getLyric(songInfo)
  },
  getPic(songInfo) {
    return withRequestSignal(pic, this.requestSignal).getPic(songInfo)
  },
  getMusicDetailPageUrl(songInfo) {
    return `http://music.migu.cn/v3/music/song/${songInfo.copyrightId}`
  },
}

export default mg
