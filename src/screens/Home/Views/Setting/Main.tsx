import { forwardRef, useImperativeHandle, useMemo, useState } from 'react'

import Basic from './settings/Basic'
import Player from './settings/Player'
import LyricDesktop from './settings/LyricDesktop'
import Search from './settings/Search'
import List from './settings/List'
import Download from './settings/Download'
import Sync from './settings/Sync'
import Backup from './settings/Backup'
import Other from './settings/Other'
import Version from './settings/Version'
import About from './settings/About'

/**
 * 分区的唯一注册点。
 *
 * 竖屏与横屏两套布局各自要渲染分区，早先它们各有一份 switch，新增分区时
 * 只改了其中一份，结果分区在竖屏下静默不显示（switch 没有 default 分支，
 * 漏掉的 id 返回 undefined，既不渲染也不报错）。
 *
 * 现在分区 id、导航顺序、两套布局渲染的组件都从这一张表派生：id 就是这张表的键，
 * 所以不存在「加了分区却没给组件」或「两套布局不同步」的可能，新增分区只改这里。
 */
export const SETTING_COMPONENTS = {
  basic: Basic,
  player: Player,
  lyric_desktop: LyricDesktop,
  search: Search,
  list: List,
  download: Download,
  sync: Sync,
  backup: Backup,
  other: Other,
  version: Version,
  about: About,
} as const

export type SettingScreenIds = keyof typeof SETTING_COMPONENTS

export const SETTING_SCREENS = Object.keys(SETTING_COMPONENTS) as SettingScreenIds[]

export const SETTING_GROUPS = {
  basic: ['basic'],
  player: ['player', 'lyric_desktop'],
  search: ['search', 'list'],
  download: ['download'],
  data: ['sync', 'backup'],
  other: ['other', 'version', 'about'],
} as const satisfies Record<string, SettingScreenIds[]>
export type SettingGroupIds = keyof typeof SETTING_GROUPS

export interface MainType {
  setActiveId: (id: SettingScreenIds) => void
}

const Main = forwardRef<MainType, {}>((props, ref) => {
  const [id, setId] = useState(global.lx.settingActiveId)

  useImperativeHandle(ref, () => ({
    setActiveId(id) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setId(id)
        })
      })
    },
  }))

  const component = useMemo(() => {
    const SectionComponent = SETTING_COMPONENTS[id]
    return <SectionComponent />
  }, [id])

  return component
})


export default Main
