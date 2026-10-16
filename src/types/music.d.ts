declare namespace LX {
  namespace Music {
    interface MusicQualityType { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
    }
    interface MusicQualityTypeKg { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
      hash: string
    }
    type _MusicQualityType = Partial<Record<Quality, {
      size: string | null
    }>>
    type _MusicQualityTypeKg = Partial<Record<Quality, {
      size: string | null
      hash: string
    }>>


    interface MusicInfoMetaBase {
      songId: string | number // 歌曲ID，mg源为copyrightId，local为文件路径
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片链接
      toggleMusicInfo?: MusicInfoOnline | null
    }

    interface MusicInfoMeta_online extends MusicInfoMetaBase {
      qualitys: MusicQualityType[]
      _qualitys: _MusicQualityType
      albumId?: string | number // 歌曲专辑ID
    }

    interface MusicInfoMeta_local extends MusicInfoMetaBase {
      filePath: string
      ext: string
    }


    interface MusicInfoBase<S = LX.Source> {
      id: string
      name: string // 歌曲名
      singer: string // 艺术家名
      source: S // 源
      interval: string | null // 格式化后的歌曲时长，例：03:55
      meta: MusicInfoMetaBase
    }

    interface MusicInfoLocal extends MusicInfoBase<'local'> {
      meta: MusicInfoMeta_local
    }

    interface MusicInfo_online_common extends MusicInfoBase<'kw' | 'wy'> {
      meta: MusicInfoMeta_online
    }

    interface MusicInfoMeta_kg extends MusicInfoMeta_online {
      qualitys: MusicQualityTypeKg[]
      _qualitys: _MusicQualityTypeKg
      hash: string // 歌曲hash
    }
    interface MusicInfo_kg extends MusicInfoBase<'kg'> {
      meta: MusicInfoMeta_kg
    }

    interface MusicInfoMeta_tx extends MusicInfoMeta_online {
      strMediaMid: string // 歌曲strMediaMid
      id?: number // 歌曲songId
      albumMid?: string // 歌曲albumMid
      /** 歌曲类型：1 普通歌曲 / 2 长音频 / 6 视频直播。写接口（红心、歌单）要用 */
      songType?: number
    }
    interface MusicInfo_tx extends MusicInfoBase<'tx'> {
      meta: MusicInfoMeta_tx
    }

    interface MusicInfoMeta_mg extends MusicInfoMeta_online {
      copyrightId: string // 歌曲copyrightId
      lrcUrl?: string // 歌曲lrcUrl
      mrcUrl?: string // 歌曲mrcUrl
      trcUrl?: string // 歌曲trcUrl
    }
    interface MusicInfo_mg extends MusicInfoBase<'mg'> {
      meta: MusicInfoMeta_mg
    }

    type MusicInfoOnline = MusicInfo_online_common | MusicInfo_kg | MusicInfo_tx | MusicInfo_mg
    type MusicInfo = MusicInfoOnline | MusicInfoLocal

    /**
     * 取链时两条链的先后（见 core/music/utils.ts 的 handleGetOnlineMusicUrl）：
     * accountFirst 账号优先 → 音源兜底；sourceFirst 音源优先 → 账号兜底；
     * sourceOnly 只走音源（下载选了「音源」时用）。
     */
    type UrlSourceOrder = 'accountFirst' | 'sourceFirst' | 'sourceOnly'

    interface LyricInfo {
      // 歌曲歌词
      lyric: string
      // 翻译歌词
      tlyric?: string | null
      // 罗马音歌词
      rlyric?: string | null
      // 逐字歌词
      lxlyric?: string | null
    }

    interface LyricInfoSave {
      id: string
      lyrics: LyricInfo
    }

    interface MusicUrlInfo {
      id: string
      url: string
    }

    interface MusicInfoOtherSourceSave {
      id: string
      list: MusicInfoOnline[]
    }

  }
}
