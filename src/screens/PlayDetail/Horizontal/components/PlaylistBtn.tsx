import { useRef } from 'react'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist'
import { useTheme } from '@/store/theme/hook'
import { strongIconShadow } from '../../components/iconStyle'
import Btn from './Btn'


// 「当前播放列表」入口：打开的就是播放条上那个列表按钮的同一个面板
export default () => {
  const theme = useTheme()
  const playlistRef = useRef<PlayerPlaylistType>(null)

  return (
    <>
      <Btn icon="list-order" color={theme['c-font']} iconStyle={strongIconShadow} onPress={() => playlistRef.current?.show()} />
      <PlayerPlaylist ref={playlistRef} />
    </>
  )
}
