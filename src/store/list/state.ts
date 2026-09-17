import { LIST_IDS } from '@/config/constant'


export interface InitState {
  allMusicList: Map<string, LX.Music.MusicInfo[]>
  defaultList: LX.List.MyDefaultListInfo
  loveList: LX.List.MyLoveListInfo
  localList: LX.List.MyLocalListInfo
  tempList: LX.List.MyTempListInfo
  userList: LX.List.UserListInfo[]
  activeListId: string

  allList: LX.List.MyListInfo[]

  tempListMeta: {
    id: string
  }

  fetchingListStatus: Record<string, boolean>
}

const state: InitState = {
  allMusicList: new Map(),
  defaultList: {
    id: LIST_IDS.DEFAULT,
    name: '试听列表',
  },
  loveList: {
    id: LIST_IDS.LOVE,
    name: '我的收藏',
  },
  localList: {
    id: LIST_IDS.LOCAL,
    name: '本地音乐',
  },
  tempList: {
    id: LIST_IDS.TEMP,
    name: '临时列表',
    meta: {},
  },
  userList: [],
  activeListId: '',
  allList: [],
  tempListMeta: {
    id: '',
  },
  fetchingListStatus: {},
}

state.allList = [state.defaultList, state.loveList, state.localList]


export default state
