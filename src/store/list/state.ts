import { LIST_IDS } from '@/config/constant'


export interface InitState {
  allMusicList: Map<string, LX.Music.MusicInfo[]>
  localList: LX.List.MyLocalListInfo
  tempList: LX.List.MyTempListInfo
  userList: LX.List.UserListInfo[]

  allList: LX.List.MyListInfo[]

  tempListMeta: {
    id: string
  }

  fetchingListStatus: Record<string, boolean>
}

const state: InitState = {
  allMusicList: new Map(),
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
  allList: [],
  tempListMeta: {
    id: '',
  },
  fetchingListStatus: {},
}

state.allList = [state.localList]


export default state
