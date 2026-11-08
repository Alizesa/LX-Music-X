import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import AddToPlaylistIcon from '@/components/common/AddToPlaylistIcon'
import MenuRow from '@/components/common/MenuRow'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, shareMusic, toast } from '@/utils/tools'
import { clearMusicUrlByMusic, hasMusicUrlByMusic } from '@/utils/data'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { addTasks } from '@/core/download'
import { changeQQMusicPlaylistMembership, loadWritableQQMusicPlaylists } from '@/core/qqMusicFavorite'

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
 * 歌曲操作沿用列表菜单的下载、分享和链接缓存逻辑。
 * 添加 / 移出 QQ 歌单时，在同一个 popup 里切换到歌单列表。
 */
export default forwardRef<MoreMenuType>((_, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const popupRef = useRef<PopupType>(null)
  const session = useRef(0)
  const [musicInfo, setMusicInfo] = useState<LX.Music.MusicInfo | null>(null)
  const [mode, setMode] = useState<Mode>('actions')
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [busy, setBusy] = useState(false)
  const [hasCache, setHasCache] = useState(false)

  const handleHide = useCallback(() => {
    session.current++
    setMusicInfo(null)
    setPlaylists([])
    setBusy(false)
    setHasCache(false)
  }, [])

  useEffect(() => () => {
    session.current++
  }, [])

  useImperativeHandle(ref, () => ({
    show() {
      const current = currentMusicInfo()
      if (!current) return
      const version = ++session.current
      // 打开后固定操作对象，自动切歌不会改变这个菜单对应的歌曲。
      setMusicInfo(current)
      setMode('actions')
      setPlaylists([])
      setBusy(false)
      setHasCache(false)
      popupRef.current?.setVisible(true)
      if (current.source != 'local') {
        void hasMusicUrlByMusic(current).then(hasCache => {
          if (version === session.current) setHasCache(hasCache)
        }).catch(() => {})
      }
    },
  }))

  const openPlaylistPicker = async(nextMode: 'add' | 'remove') => {
    if (!musicInfo || busy) return
    const version = session.current
    setBusy(true)
    try {
      // 只有选择歌单操作才加载候选，下载、分享和清理缓存无需读取 QQ 歌单。
      const list = await loadWritableQQMusicPlaylists()
      if (version !== session.current) return
      setPlaylists(list)
      setMode(nextMode)
    } catch (error: unknown) {
      if (version === session.current) toast(error instanceof Error ? error.message : String(error), 'long')
    } finally {
      if (version === session.current) setBusy(false)
    }
  }

  const change = useCallback(async(playlist: Playlist) => {
    if (!musicInfo || busy) return
    const version = session.current
    const add = mode == 'add'
    setBusy(true)
    try {
      // 提示和缓存作废都在里面做掉了
      if (await changeQQMusicPlaylistMembership(musicInfo, playlist, add) && version === session.current) popupRef.current?.setVisible(false)
    } finally {
      if (version === session.current) setBusy(false)
    }
  }, [busy, mode, musicInfo])

  const handleDownload = () => {
    if (!musicInfo || musicInfo.source == 'local' || busy) return
    popupRef.current?.setVisible(false)
    void addTasks([musicInfo]).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), 'long')
    })
  }

  const handleShare = () => {
    if (!musicInfo || busy) return
    popupRef.current?.setVisible(false)
    shareMusic(settingState.setting['common.shareType'], settingState.setting['download.fileName'], musicInfo)
  }

  const handleClearCache = () => {
    if (!musicInfo || musicInfo.source == 'local' || !hasCache || busy) return
    popupRef.current?.setVisible(false)
    void clearMusicUrlByMusic(musicInfo).then(() => {
      toast(t('list_remove_cache_success_tip'))
    }).catch((error: unknown) => {
      toast(t('list_remove_cache_fail_tip', { msg: error instanceof Error ? error.message : String(error) }))
    })
  }

  const renderBody = () => {
    if (mode == 'actions') {
      return (
        <ScrollView key="actions" style={styles.list} keyboardShouldPersistTaps="handled">
          {/* 跟列表行的三点菜单共用同一套行：图标位、行高、字号都一样 */}
          <MenuRow
            icon={<AddToPlaylistIcon size={18} color={theme['c-font']} />}
            label={t('qq_playlist_add_to')}
            disabled={busy || !musicInfo}
            onPress={() => { void openPlaylistPicker('add') }}
          />
          <MenuRow
            icon={<Icon name="remove" size={18} color={theme['c-font']} />}
            label={t('qq_playlist_remove_from')}
            disabled={busy || !musicInfo}
            onPress={() => { void openPlaylistPicker('remove') }}
          />
          <MenuRow
            icon={<Icon name="download-2" size={18} color={theme['c-font']} />}
            label={t('download')}
            disabled={busy || !musicInfo || musicInfo.source == 'local'}
            onPress={handleDownload}
          />
          <MenuRow
            icon={<Icon name="share" size={18} color={theme['c-font']} />}
            label={t('copy_name')}
            disabled={busy || !musicInfo}
            onPress={handleShare}
          />
          <MenuRow
            icon={<Icon name="eraser" size={18} color={theme['c-font']} />}
            label={t('list_remove_cache')}
            disabled={busy || !hasCache}
            onPress={handleClearCache}
          />
        </ScrollView>
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
              style={{ ...styles.playlistRow, borderBottomColor: theme['c-border-background'], opacity: busy ? 0.5 : 1 }}
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
    <Popup ref={popupRef} onHide={handleHide} title={title} position="bottom">
      {renderBody()}
    </Popup>
  )
})

const styles = createStyle({
  // 歌单那一屏的行：封面 + 名字（跟列表行菜单那边同一套尺寸）
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  list: {
    flexShrink: 1,
    flexGrow: 0,
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
