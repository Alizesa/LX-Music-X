import { withRequestSignal } from '@/utils/musicSdk/requestScope'
import songList from './songList'
import musicSearch from './musicSearch'
import pic from './pic'
import lyric from './lyric'
import hotSearch from './hotSearch'
import comment from './comment'

const kg = {
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
    return `https://www.kugou.com/song/#hash=${songInfo.hash}&album_id=${songInfo.albumId}`
  },
}

export default kg
