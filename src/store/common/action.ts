import state, { type InitState } from './state'
import { type COMPONENT_IDS } from '@/config/constant'

// 一种页面名底下活着的实例 id，按挂载顺序排（最后挂上的在末尾）。见 setComponentId 的说明
const liveIds: Partial<Record<COMPONENT_IDS, string[]>> = {}


export default {
  setFontSize(size: number) {
    state.fontSize = size
    global.state_event.fontSizeUpdated(size)
  },
  setStatusbarHeight(size: number) {
    if (state.statusbarHeight == size) return
    state.statusbarHeight = size
    global.state_event.statusbarHeightUpdated(size)
  },
  /**
   * 同一种页面在栈里可能同时有好几个实例：从播放条能把播放详情页再推一层
   * （首页 -> 播放详情 -> 歌手详情 -> 播放详情 -> 歌手详情）。
   *
   * componentIds 一种名字只存得下一个 id，光留「最后挂上的那个」不够用：栈顶那个一弹走，
   * 这个槽要么被删掉、要么还指着已经销毁的实例，底下那个活着的实例就废了：
   *   - 它的返回键 pop(componentIds.xxx) 弹不动（拿不到 id，或弹的是一张不存在的页）；
   *   - 「只剩 home 一个键」这类判断（首页的返回键拦截、抽屉的宽度修正、播放条的进度条）
   *     会以为已经回到首页，在别的页还压着的时候就把抽屉的尺寸改了 —— 那样抽屉会只剩一层
   *     点不掉的遮罩（见 DrawerLayoutFixed）。
   * 所以每个名字另外记一份活着的 id（按挂载顺序），槽里永远放最后挂上的那个，
   * 弹出时从这份记录里摘掉、槽回退到前一个实例，记录空了才删键。
   */
  setComponentId(name: COMPONENT_IDS, id: string) {
    const list = liveIds[name] ?? (liveIds[name] = [])
    // 同一个 id 只记一次：重挂载同一张页时别留两份，不然弹一次还剩一份
    const idx = list.indexOf(id)
    if (idx != -1) list.splice(idx, 1)
    list.push(id)
    state.componentIds[name] = id
    global.state_event.componentIdsUpdated({ ...state.componentIds })
  },
  removeComponentId(id: string) {
    const name = (Object.entries(liveIds) as Array<[COMPONENT_IDS, string[]]>)
      .find(([, ids]) => ids.includes(id))?.[0]
    if (!name) return
    const list = liveIds[name]!
    const idx = list.indexOf(id)
    if (idx != -1) list.splice(idx, 1)
    if (list.length) {
      state.componentIds[name] = list[list.length - 1]
    } else {
      delete liveIds[name]
      delete state.componentIds[name]
    }
    global.state_event.componentIdsUpdated({ ...state.componentIds })
  },
  setNavActiveId(id: InitState['navActiveId']) {
    state.navActiveId = id
    if (id != 'nav_setting') state.lastNavActiveId = id
    global.state_event.navActiveIdUpdated(id)
  },
  setLastNavActiveId(id: InitState['navActiveId']) {
    state.lastNavActiveId = id
  },
  setBgPic(pic: string | null) {
    state.bgPic = pic
    global.state_event.bgPicUpdated(pic)
  },
  setSourceNames(names: InitState['sourceNames']) {
    state.sourceNames = names
    global.state_event.sourceNamesUpdated(names)
  },
}

