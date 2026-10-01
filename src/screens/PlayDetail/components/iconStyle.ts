import type { TextStyle } from 'react-native'

/**
 * 压在背景图上的图标用的阴影（上下首那一排、以及下面那四个按钮：桌面歌词/加歌/播放模式/评论）。
 * 图标颜色统一用主题的正文色 theme['c-font']，再叠这层黑阴影，
 * 深色和浅色背景图上都能看清轮廓（原来用的是主题里的次要色 c-font-label，压在图上会糊掉）。
 */
export const strongIconShadow: TextStyle = {
  textShadowColor: 'rgba(0, 0, 0, 0.75)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
}
