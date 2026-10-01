import type { useTheme } from '@/store/theme/hook'

type Theme = ReturnType<typeof useTheme>

export interface LrcColors {
  /** 原文颜色 */
  color: string
  /** 翻译颜色 */
  translationColor: string
  /** 原文不透明度 */
  opacity: number
  /** 翻译不透明度 */
  translationOpacity: number
}

// 翻译行比原文淡一档，保住主次（主题那两档颜色本来也就是同色淡一档）
const TRANSLATION_OPACITY = 0.6

interface Options {
  /** 是不是当前正在播放的那一行 */
  active: boolean
  theme: Theme
  lrcColor: string | null
  lrcActiveColor: string | null
  lrcOpacity: number
}

/**
 * 算一行歌词的四项显示参数。竖屏、横屏两套歌词组件的渲染是各写各的，但颜色规则完全一样，
 * 放这里免得改一处漏一处。
 *
 * - 颜色设置是 null 就完全走主题色，跟加这两个设置之前一模一样
 * - 自定义了颜色就用同一个色，翻译行靠降不透明度保持主次
 * - 「歌词透明度」只作用于未播放的行，当前播放那行始终不透明，不然整块歌词就没主次了
 */
export const resolveLrcColors = ({ active, theme, lrcColor, lrcActiveColor, lrcOpacity }: Options): LrcColors => {
  const opacity = lrcOpacity / 100
  if (active) {
    return lrcActiveColor == null
      ? {
          color: theme['c-primary'],
          translationColor: theme['c-primary-alpha-200'],
          opacity: 1,
          translationOpacity: 1,
        }
      : {
          color: lrcActiveColor,
          translationColor: lrcActiveColor,
          opacity: 1,
          translationOpacity: TRANSLATION_OPACITY,
        }
  }
  return lrcColor == null
    ? {
        color: theme['c-350'],
        translationColor: theme['c-300'],
        opacity,
        translationOpacity: opacity,
      }
    : {
        color: lrcColor,
        translationColor: lrcColor,
        opacity,
        translationOpacity: opacity * TRANSLATION_OPACITY,
      }
}
