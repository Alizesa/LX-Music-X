import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import playerState from '@/store/player/state'
import { filterVisiblePlaylists } from '@/core/qqMusic'
import { setQQMusicTrackInPlaylist } from '@/core/qqMusicFavorite'
import { dropCachedPlaylistSongs } from '@/core/qqMusicPlaylistSongsCache'
import { getQQMusicPlaylistsCache } from '@/utils/data'

type Mode = 'actions' | 'add' | 'remove'
type Playlist = LX.QQMusic.PlaylistInfo

export interface MoreMenuType {
  show: () => void
}

/** 当前播放的歌。播放详情页的 musicInfo 可能是「下载条目」那种旧结构，拆一层。 */
const currentMusicInfo = (): LX.Music.MusicInfo | null => {
  const raw = playerState.playMusicInfo.musicInfo
  if (!raw) return null
  return 'progress' in raw ? raw.metadata.musicInfo : raw
}

/**
 * 播放详情页三点弹出的功能页。
 *
 * 目前只有两项：把当前歌曲加进 / 移出自己创建的 QQ 歌单。
 * 两者都要挑歌单，所以先列动作、选中后再换成歌单列表（同一个 popup 里换内容，
 * 不再叠一层弹窗）。
 */
export default forwardRef<MoreMenuType>((_, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const popupRef = useRef<PopupType>(null)
  const [mode, setMode] = useState<Mode>('actions')
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [busy, setBusy] = useState(false)

  useImperativeHandle(ref, () => ({
    show() {
      setMode('actions')
      popupRef.current?.setVisible(true)
      void getQQMusicPlaylistsCache().then(cached => {
        // 只有自己创建的歌单能写：收藏来的没有目录编号，写接口用不了
        setPlaylists(filterVisiblePlaylists(cached).filter(item => !item.subscribed && !item.liked && !!item.dirId))
      })
    },
  }))

  const change = useCallback(async(playlist: Playlist) => {
    if (busy) return
    const musicInfo = currentMusicInfo()
    if (!musicInfo) return
    const add = mode == 'add'
    setBusy(true)
    try {
      const result = await setQQMusicTrackInPlaylist(musicInfo, playlist, add)
      if (result == 'ok') {
        toast(t(add ? 'qq_playlist_added' : 'qq_playlist_removed', { name: playlist.name }))
        // 歌单内容变了，缓存作废，下次进歌单页会重新取
        void dropCachedPlaylistSongs(playlist.id)
        popupRef.current?.setVisible(false)
        return
      }
      if (result == 'failed') {
        toast(t('qq_playlist_write_failed'), 'long')
        return
      }
      toast(t('qq_playlist_write_unsupported'), 'long')
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_playlist_write_failed'), 'long')
    } finally {
      setBusy(false)
    }
  }, [busy, mode, t])

  const renderBody = () => {
    if (mode == 'actions') {
      return (
        <>
          <TouchableOpacity style={{ ...styles.row, borderBottomColor: theme['c-border-background'] }} onPress={() => { setMode('add') }}>
            <Text>{t('qq_playlist_add_to')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ ...styles.row, borderBottomColor: theme['c-border-background'] }} onPress={() => { setMode('remove') }}>
            <Text>{t('qq_playlist_remove_from')}</Text>
          </TouchableOpacity>
        </>
      )
    }
    if (!playlists.length) {
      return <Text style={styles.empty} color={theme['c-font-label']}>{t('qq_playlist_write_empty')}</Text>
    }
    return (
      <ScrollView style={styles.list}>
        {
          playlists.map(item => (
            <TouchableOpacity
              key={item.id}
              style={{ ...styles.row, ...styles.playlistRow, borderBottomColor: theme['c-border-background'], opacity: busy ? 0.5 : 1 }}
              disabled={busy}
              onPress={() => { void change(item) }}
            >
              {item.cover
                ? <Image url={item.cover} style={styles.cover} />
                : <View style={{ ...styles.cover, backgroundColor: theme['c-primary-background'] }} />}
              <View style={styles.info}>
                <Text numberOfLines={1}>{item.name}</Text>
                <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{t('mine_song_count', { num: item.trackCount ?? 0 })}</Text>
              </View>
            </TouchableOpacity>
          ))
        }
      </ScrollView>
    )
  }

  const title = mode == 'actions'
    ? t('play_detail_more')
    : t(mode == 'add' ? 'qq_playlist_add_to' : 'qq_playlist_remove_from')

  return (
    <Popup ref={popupRef} title={title} position="bottom">
      {renderBody()}
    </Popup>
  )
})

const styles = createStyle({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  list: {
    maxHeight: 320,
  },
  cover: {
    width: 44,
    height: 44,
    borderRadius: 4,
  },
  info: {
    flex: 1,
    paddingLeft: 12,
  },
  empty: {
    textAlign: 'center',
    paddingVertical: 28,
  },
})
