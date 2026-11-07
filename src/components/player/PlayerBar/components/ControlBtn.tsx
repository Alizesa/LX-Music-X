import { StyleSheet, TouchableOpacity } from 'react-native'
import { useRef } from 'react'
import { Icon } from '@/components/common/Icon'
import { useIsPlay } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { playNext, playPrev, togglePlay } from '@/core/player/player'
import { createStyle } from '@/utils/tools'
import { useHorizontalMode } from '@/utils/hooks'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist'

const BTN_SIZE = 24
const COMPACT_ICON_SIZE = 22 * global.lx.fontSize
interface ButtonProps { compact: boolean }
const handlePlayPrev = () => {
  void playPrev()
}
const handlePlayNext = () => {
  void playNext()
}

const PlayPrevBtn = ({ compact }: ButtonProps) => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={[styles.cotrolBtn, compact && tabletStyles.button]} activeOpacity={0.5} onPress={handlePlayPrev}>
      <Icon name='prevMusic' color={theme['c-button-font']} size={BTN_SIZE} rawSize={compact ? COMPACT_ICON_SIZE : undefined} />
    </TouchableOpacity>
  )
}

const PlayNextBtn = ({ compact }: ButtonProps) => {
  const theme = useTheme()

  return (
    <TouchableOpacity style={[styles.cotrolBtn, compact && tabletStyles.button]} activeOpacity={0.5} onPress={handlePlayNext}>
      <Icon name='nextMusic' color={theme['c-button-font']} size={BTN_SIZE} rawSize={compact ? COMPACT_ICON_SIZE : undefined} />
    </TouchableOpacity>
  )
}

const TogglePlayBtn = ({ compact }: ButtonProps) => {
  const isPlay = useIsPlay()
  const theme = useTheme()

  return (
    <TouchableOpacity style={[styles.cotrolBtn, compact && tabletStyles.button]} activeOpacity={0.5} onPress={togglePlay}>
      <Icon name={isPlay ? 'pause' : 'play'} color={theme['c-button-font']} size={BTN_SIZE} rawSize={compact ? COMPACT_ICON_SIZE : undefined} />
    </TouchableOpacity>
  )
}

const PlaylistBtn = ({ compact }: ButtonProps) => {
  const theme = useTheme()
  const playlistRef = useRef<PlayerPlaylistType>(null)
  return (
    <>
      <TouchableOpacity style={[styles.cotrolBtn, compact && tabletStyles.button]} activeOpacity={0.5} onPress={() => playlistRef.current?.show()}>
        <Icon name="list-order" color={theme['c-button-font']} size={BTN_SIZE} rawSize={compact ? COMPACT_ICON_SIZE : undefined} />
      </TouchableOpacity>
      <PlayerPlaylist ref={playlistRef} />
    </>
  )
}

export default ({ compact = false }: { compact?: boolean }) => {
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
      { isHorizontalMode ? <PlayPrevBtn compact={compact} /> : null }
      <TogglePlayBtn compact={compact} />
      <PlayNextBtn compact={compact} />
      <PlaylistBtn compact={compact} />
    </>
  )
}

const tabletStyles = StyleSheet.create({
  button: {
    width: 38 * global.lx.fontSize,
    height: 44 * global.lx.fontSize,
  },
})


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
