import { useRef } from 'react'
import PlayerPlaylist, { type PlayerPlaylistType } from '@/components/player/PlayerPlaylist'
import Btn from './Btn'


// 「当前播放列表」入口：打开的就是播放条上那个列表按钮的同一个面板
export default () => {
  const playlistRef = useRef<PlayerPlaylistType>(null)

  return (
    <>
      <Btn icon="list-order" onPress={() => playlistRef.current?.show()} />
      <PlayerPlaylist ref={playlistRef} />
    </>
  )
}
