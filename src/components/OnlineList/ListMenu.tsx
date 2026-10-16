import { useRef, useImperativeHandle, forwardRef, useState, type ComponentProps, type ReactNode } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useI18n } from '@/lang'
import { type Position } from '@/components/common/Menu'
import Popup, { type PopupType } from '@/components/common/Popup'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import AddToPlaylistIcon from '@/components/common/AddToPlaylistIcon'
import LikedHeart from '@/components/common/LikedHeart'
import { useTheme } from '@/store/theme/hook'
import { hasDislike } from '@/core/dislikeList'
import { hasMusicUrlByMusic } from '@/utils/data'
import { setMusicCollected } from '@/core/player/player'
import { changeQQMusicPlaylistMembership, loadWritableQQMusicPlaylists, useQQMusicLiked } from '@/core/qqMusicFavorite'
import { createStyle } from '@/utils/tools'

export interface SelectInfo {
  musicInfo: LX.Music.MusicInfoOnline
  selectedList: LX.Music.MusicInfoOnline[]
  index: number
  single: boolean
}
const initSelectInfo = {}

const hasUrlCache = async(musicInfo: LX.Music.MusicInfo) => {
  return hasMusicUrlByMusic(musicInfo)
}

type IconName = ComponentProps<typeof Icon>['name']
type Mode = 'actions' | 'add' | 'remove'

/**
 * 面板里的一行。`icon` 是字体里那个图标；「收藏」和「添加到歌单」用的是自绘图标
 * （见 renderRowIcon），所以这两行的 icon 留空。
 */
interface Row {
  action: string
  label: string
  icon?: IconName
  disabled?: boolean
}

/** 图标 + 文案 */
const MenuRow = ({ icon, label, disabled, onPress }: {
  icon?: ReactNode
  label: string
  disabled?: boolean
  onPress: () => void
}) => {
  const theme = useTheme()
  return (
    <TouchableOpacity
      style={{ ...styles.row, borderBottomColor: theme['c-border-background'], opacity: disabled ? 0.4 : 1 }}
      activeOpacity={0.7}
      disabled={disabled}
      onPress={onPress}
    >
      {/* 图标位宽度固定：没有图标的行（「不喜欢」）也留着，各行文案才对得齐 */}
      <View style={styles.iconWrap}>{icon}</View>
      <Text size={15} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  )
}

export interface ListMenuProps {
  onPlay: (selectInfo: SelectInfo) => void
  onPlayLater: (selectInfo: SelectInfo) => void
  onAddToPlayQueue: (selectInfo: SelectInfo) => void
  onCopyName: (selectInfo: SelectInfo) => void
  onRemoveCache: (selectInfo: SelectInfo) => void
  onDislikeMusic: (selectInfo: SelectInfo) => void
  onDownload: (selectInfo: SelectInfo) => void
}
export interface ListMenuType {
  /** position 现在已经用不上了（改成从下方弹出），留着只是不想动 List 那边的调用签名 */
  show: (selectInfo: SelectInfo, position: Position) => void
}

export type {
  Position,
}

export default forwardRef<ListMenuType, ListMenuProps>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const popupRef = useRef<PopupType>(null)
  const selectInfoRef = useRef<SelectInfo>(initSelectInfo as SelectInfo)
  // 选中项放 state：面板里点完收藏要立刻反映到那一行（图标高亮 + 勾 + 文案变「取消收藏」）。
  // 收藏状态由 useQQMusicLiked 订阅，它会跟着账号数据变
  const [current, setCurrent] = useState<SelectInfo | null>(null)
  const liked = useQQMusicLiked(current?.musicInfo.id)
  const [mode, setMode] = useState<Mode>('actions')
  const [rows, setRows] = useState<Row[]>([])
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [busy, setBusy] = useState(false)

  const close = () => { popupRef.current?.setVisible(false) }

  const buildRows = (musicInfo: LX.Music.MusicInfoOnline): Row[] => {
    const next: Row[] = [{ action: 'play', label: t('play'), icon: 'play' }]
    // 收藏和歌单都得落到 QQ 账号上（本地列表早就不维护了），别的源不摆这几个入口
    if (musicInfo.source == 'tx') {
      next.push(
        // 这两行的图标是自绘的（见 renderRowIcon），文案也按状态拼，所以这里都留空
        { action: 'like', label: '' },
        { action: 'addToPlaylist', label: t('qq_playlist_add_to') },
        { action: 'removeFromPlaylist', label: t('qq_playlist_remove_from'), icon: 'remove' },
      )
    }
    next.push(
      { action: 'addToQueue', label: t('add_to_play_queue'), icon: 'nextMusic' },
      { action: 'playLater', label: t('play_later'), icon: 'music_time' },
      { action: 'download', label: t('download'), icon: 'download-2' },
      { action: 'copyName', label: t('copy_name'), icon: 'share' },
      // 「歌曲详情页」这项去掉了：它跳的是 QQ 网页版详情，手机上体验不好
      { action: 'removeCache', label: t('list_remove_cache'), icon: 'eraser', disabled: true },
      { action: 'dislike', label: t('dislike'), disabled: hasDislike(musicInfo) },
    )
    return next
  }

  useImperativeHandle(ref, () => ({
    show(selectInfo) {
      selectInfoRef.current = selectInfo
      setCurrent(selectInfo)
      setMode('actions')
      const next = buildRows(selectInfo.musicInfo)
      setRows(next)
      popupRef.current?.setVisible(true)
      // 有没有缓存是异步问的，回来后补一次禁用态
      void hasUrlCache(selectInfo.musicInfo).then(hasCache => {
        const index = next.findIndex(row => row.action == 'removeCache')
        if (index < 0) return
        next[index] = { ...next[index], disabled: !hasCache }
        setRows([...next])
      })
    },
  }))

  const toggleLike = async() => {
    const musicInfo = current?.musicInfo
    if (!musicInfo || busy) return
    setBusy(true)
    try {
      // 提示、失败兜底、本地列表那套分流都在里面
      await setMusicCollected(musicInfo, !liked)
    } finally {
      setBusy(false)
    }
  }

  const openPlaylistPicker = async(nextMode: Mode) => {
    if (busy) return
    setBusy(true)
    try {
      // 候选（自己创建的歌单）和「缓存里缺 dirId 就自己重拉一次」都在 core 里，
      // 播放详情页那个面板用的是同一份。列表拿到手再切，免得先闪一下「还没有自建歌单」
      const list = await loadWritableQQMusicPlaylists()
      setPlaylists(list)
      setMode(nextMode)
    } finally {
      setBusy(false)
    }
  }

  const changeMembership = async(playlist: LX.QQMusic.PlaylistInfo) => {
    const musicInfo = current?.musicInfo
    if (!musicInfo || busy) return
    setBusy(true)
    try {
      // 成功与否的提示和缓存作废都在里面做掉了
      if (await changeQQMusicPlaylistMembership(musicInfo, playlist, mode == 'add')) close()
    } finally {
      setBusy(false)
    }
  }

  const handleMenuPress = (action: string) => {
    const selectInfo = selectInfoRef.current
    switch (action) {
      case 'play':
        props.onPlay(selectInfo)
        close()
        break
      case 'like':
        // 不关面板：让用户直接看到它变成「取消收藏」+ 打勾
        void toggleLike()
        break
      case 'addToPlaylist':
        void openPlaylistPicker('add')
        break
      case 'removeFromPlaylist':
        void openPlaylistPicker('remove')
        break
      case 'addToQueue':
        props.onAddToPlayQueue(selectInfo)
        close()
        break
      case 'playLater':
        props.onPlayLater(selectInfo)
        close()
        break
      case 'download':
        props.onDownload(selectInfo)
        close()
        break
      case 'copyName':
        props.onCopyName(selectInfo)
        close()
        break
      case 'removeCache':
        props.onRemoveCache(selectInfo)
        close()
        break
      case 'dislike':
        props.onDislikeMusic(selectInfo)
        close()
        break
      default:
        break
    }
  }

  /** 每行左边的图标。收藏和歌单那两行是自绘的，其余走字体图标 */
  const renderRowIcon = (row: Row) => {
    if (row.action == 'like') return <LikedHeart liked={liked} size={18} />
    if (row.action == 'addToPlaylist') return <AddToPlaylistIcon size={18} color={theme['c-font']} />
    return row.icon ? <Icon name={row.icon} size={18} color={theme['c-font']} /> : null
  }

  const renderActions = () => (
    <ScrollView style={styles.list}>
      {
        rows.map(row => (
          <MenuRow
            key={row.action}
            icon={renderRowIcon(row)}
            label={row.action == 'like' ? (liked ? t('uncollect') : t('collect')) : row.label}
            disabled={row.disabled}
            onPress={() => { handleMenuPress(row.action) }}
          />
        ))
      }
    </ScrollView>
  )

  const renderPlaylists = () => {
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
              onPress={() => { void changeMembership(item) }}
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
      {mode == 'actions' ? renderActions() : renderPlaylists()}
    </Popup>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  playlistRow: {
    paddingVertical: 10,
  },
  iconWrap: {
    width: 26,
    height: 20,
    justifyContent: 'center',
  },
  list: {
    maxHeight: 380,
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
