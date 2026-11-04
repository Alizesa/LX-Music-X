import state, { type InitState } from './state'


export default {
  setUserLists(userList: LX.List.UserListInfo[]) {
    state.userList = userList
    state.allList = [state.localList, ...state.userList]

    global.state_event.mylistUpdated(state.allList)
  },
  setTempListMeta(meta: InitState['tempListMeta']) {
    state.tempListMeta = meta
  },
}
