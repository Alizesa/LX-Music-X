import { useCallback, useEffect, useRef } from 'react'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import OnlineList, { type OnlineListType, type OnlineListProps } from '@/components/OnlineList'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS, LIST_IDS } from '@/config/constant'
import { setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { getQQMusicPlaylistSongs, getQQMusicSession } from '@/core/qqMusic'
import { toast } from '@/utils/tools'
import { useI18n } from '@/lang'

interface Props {
  componentId: string
  info: { id: string, name: string, liked?: boolean }
}

// QQ 歌单页。不复用多源的 SonglistDetail：那条链路取歌走 core/songlist，
// 而「我喜欢」是 dirid=201 的虚拟歌单，只有 getQQMusicPlaylistSongs 这条
// CgiGetDiss 优先的通道认得。
export default ({ componentId, info }: Props) => {
  const t = useI18n()
  const listRef = useRef<OnlineListType>(null)
  const songsRef = useRef<LX.Music.MusicInfoOnline[]>([])
  const loadedRef = useRef(false)

  const load = useCallback(async() => {
    listRef.current?.setStatus('refreshing')
    try {
      const { cookie } = await getQQMusicSession()
      if (!cookie) throw new Error(t('qq_not_logged_in'))
      const songs = await getQQMusicPlaylistSongs(cookie, info.id)
      songsRef.current = songs
      listRef.current?.setList(songs)
      // 取歌是一次拿全的，没有分页，所以直接标记到底
      listRef.current?.setStatus('end')
    } catch (error: unknown) {
      listRef.current?.setStatus('error')
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    }
  }, [info.id, t])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.qqPlaylist, componentId)
    // 守卫要同步置位：依赖变化重跑时，上一次的请求可能还没回来
    if (loadedRef.current) return
    loadedRef.current = true
    void load()
  }, [componentId, load])

  const handlePlayList: OnlineListProps['onPlayList'] = (index) => {
    const songs = songsRef.current
    if (!songs.length) return
    void setTempList(`qq__${info.id}`, [...songs]).then(() => {
      void playList(LIST_IDS.TEMP, index)
    })
  }

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader componentId={componentId} title={info.name} />
      <OnlineList
        ref={listRef}
        onPlayList={handlePlayList}
        onRefresh={load}
        onLoadMore={() => { listRef.current?.setStatus('end') }}
      />
      <PlayerBar />
    </PageContent>
  )
}
