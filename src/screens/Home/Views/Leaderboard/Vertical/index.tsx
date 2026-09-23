import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { createStyle } from '@/utils/tools'

import MusicList, { type MusicListType } from '../MusicList'
import { getLeaderboardSetting, saveLeaderboardSetting } from '@/utils/data'
import Popup, { type PopupType } from '@/components/common/Popup'
import HeaderBar, { type HeaderBarType, type HeaderBarProps } from './HeaderBar'
import { useI18n } from '@/lang'
import BoardsList, { type BoardsListType, type BoardsListProps } from '../BoardsList'
import { getBoardsList } from '@/core/leaderboard'
import { handleCollect, handlePlay } from '../listAction'
import boardState from '@/store/leaderboard/state'

export default () => {
  // 榜单清单原来挂在左侧抽屉里，现在换成底部面板（和「更多」面板同一套）
  const popupRef = useRef<PopupType>(null)
  const t = useI18n()
  const musicListRef = useRef<MusicListType>(null)
  const isUnmountedRef = useRef(false)
  const boardsListRef = useRef<BoardsListType>(null)
  const headerBarRef = useRef<HeaderBarType>(null)
  const boundInfo = useRef<{ source: LX.OnlineSource, id: string | null }>({ source: 'kw', id: null })
  // const [width, setWidth] = useState(0)

  const handleBoundChange = (source: LX.OnlineSource, id: string) => {
    musicListRef.current?.loadList(source, id)
    void saveLeaderboardSetting({
      source,
      boardId: id,
    })
  }
  const onBoundChange: BoardsListProps['onBoundChange'] = (id) => {
    boundInfo.current.id = id
    void getBoardsList(boundInfo.current.source).then(list => {
      requestAnimationFrame(() => {
        const bound = list.find(l => l.id == id)
        headerBarRef.current?.setBound(boundInfo.current.source, id, bound?.name ?? 'Unknown')
      })
    })
    handleBoundChange(boundInfo.current.source, id)
    popupRef.current?.setVisible(false)
  }
  const onPlay: BoardsListProps['onPlay'] = (id) => {
    boundInfo.current.id = id
    void handlePlay(id, boardState.listDetailInfo.list)
  }
  const onCollect: BoardsListProps['onCollect'] = (id, name) => {
    boundInfo.current.id = id
    void handleCollect(id, name, boundInfo.current.source)
  }
  const onShowBound = () => {
    popupRef.current?.setVisible(true)
    // 面板隐藏时子树是卸载的（RN 的 Modal 在 visible=false 时不渲染 children），
    // BoardsList 的 ref 那时是空的，榜单数据要在它挂载之后再补一次。
    // 榜单列表在 store 里有缓存，这次调用不会发请求。
    const { source, id } = boundInfo.current
    if (!source || !id) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void getBoardsList(source).then(list => { boardsListRef.current?.setList(list, id) })
      })
    })
  }
  const onSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    boundInfo.current.source = source
    void getBoardsList(source).then(list => {
      const id = list[0].id
      const name = list[0].name
      requestAnimationFrame(() => {
        // 榜单清单这一步拿不到（面板关着时它没挂载），它会在下次打开时按
        // boundInfo 重新取一次，这里只更新标题栏
        headerBarRef.current?.setBound(source, id, name ?? 'Unknown')
        requestAnimationFrame(() => {
          handleBoundChange(source, id)
        })
      })
    })
  }

  const navigationView = () => {
    return (
      <BoardsList
        ref={boardsListRef}
        onBoundChange={onBoundChange}
        onCollect={onCollect}
        onPlay={onPlay}
      />
    )
  }

  // const theme = useTheme()


  useEffect(() => {
    isUnmountedRef.current = false
    void getLeaderboardSetting().then(({ source, boardId }) => {
      boundInfo.current.source = source
      boundInfo.current.id = boardId
      void getBoardsList(source).then(list => {
        const bound = list.find(l => l.id == boardId)
        headerBarRef.current?.setBound(source, boardId, bound?.name ?? 'Unknown')
      })
      musicListRef.current?.loadList(source, boardId)
    })

    return () => {
      isUnmountedRef.current = true
    }
  }, [])


  return (
    <View style={styles.container}>
      <HeaderBar ref={headerBarRef} onShowBound={onShowBound} onSourceChange={onSourceChange} />
      <MusicList ref={musicListRef} />
      <Popup ref={popupRef} title={t('nav_top')} position="bottom">
        {navigationView()}
      </Popup>
    </View>
    // <View style={styles.container}>
    //   <LeftBar
    //     ref={leftBarRef}
    //     onChangeList={handleChangeBound}
    //   />
    //   <MusicList
    //     ref={musicListRef}
    //   />
    // </View>
  )
}

const styles = createStyle({
  container: {
    width: '100%',
    flex: 1,
    flexDirection: 'column',
    // borderTopWidth: BorderWidths.normal,
  },
  // content: {
  //   flex: 1,
  // },
})
