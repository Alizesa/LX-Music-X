import { TouchableOpacity } from 'react-native'
import { useRef } from 'react'
import { Icon } from '@/components/common/Icon'
import { useIsPlay, usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { collectMusic, playNext, playPrev, togglePlay, uncollectMusic } from '@/core/player/player'
import { useQQMusicLiked } from '@/core/qqMusicFavorite'
import { createStyle } from '@/utils/tools'
import { useHorizontalMode } from '@/utils/hooks'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist'

const BTN_SIZE = 24
const handlePlayPrev = () => {
  void playPrev()
}
const handlePlayNext = () => {
  void playNext()
}

const PlayPrevBtn = () => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={handlePlayPrev}>
      <Icon name='prevMusic' color={theme['c-button-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const PlayNextBtn = () => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={handlePlayNext}>
      <Icon name='nextMusic' color={theme['c-button-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

/**
 * 红心。QQ 的歌且已登录时直接写账号的「我喜欢」，其余情况退到本地收藏列表 ——
 * 具体分流在 core/player/player.ts 的 toggleCollect 里。
 */
const CollectBtn = () => {
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const liked = useQQMusicLiked(musicInfo.id)

  return (
    <TouchableOpacity
      style={styles.cotrolBtn}
      activeOpacity={0.5}
      onPress={() => { if (liked) uncollectMusic(); else collectMusic() }}
    >
      <Icon name="love" color={liked ? theme['c-primary-font'] : theme['c-button-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const TogglePlayBtn = () => {
  const isPlay = useIsPlay()
  const theme = useTheme()

  return (
    <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={togglePlay}>
      <Icon name={isPlay ? 'pause' : 'play'} color={theme['c-button-font']} size={BTN_SIZE} />
    </TouchableOpacity>
  )
}

const PlaylistBtn = () => {
  const theme = useTheme()
  const playlistRef = useRef<PlayerPlaylistType>(null)
  return (
    <>
      <TouchableOpacity style={styles.cotrolBtn} activeOpacity={0.5} onPress={() => playlistRef.current?.show()}>
        <Icon name="list-order" color={theme['c-button-font']} size={BTN_SIZE} />
      </TouchableOpacity>
      <PlayerPlaylist ref={playlistRef} />
    </>
  )
}

export default () => {
  const isHorizontalMode = useHorizontalMode()
  return (
    <>
      {/* <TouchableOpacity activeOpacity={0.5} onPress={toggleNextPlayMode}>
        <Text style={{ ...styles.cotrolBtn }}>
          <Icon name={playModeIcon} style={{ color: theme.secondary10 }} size={18} />
        </Text>
      </TouchableOpacity>
    */}
      {/* {btnPrev} */}
      { isHorizontalMode ? <PlayPrevBtn /> : null }
      <CollectBtn />
      <TogglePlayBtn />
      <PlayNextBtn />
      <PlaylistBtn />
    </>
  )
}


const styles = createStyle({
  cotrolBtn: {
    width: 46,
    height: 46,
    justifyContent: 'center',
    alignItems: 'center',

    // backgroundColor: '#ccc',
    shadowOpacity: 1,
    textShadowRadius: 1,
  },
})
