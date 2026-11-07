/**
 * 平板布局的断点与尺寸。
 *
 * 参考 QQ 音乐 HD：横屏大屏（平板）用左侧竖向导航条替换底部 tab，
 * 内容区按可用宽度排多列；手机（含手机横屏）保持原来的底部 tab 与单列/双列。
 *
 * 判断用 dp（windowSizeTools 已经把 px 除过 scale），不是物理像素。
 * 900 是平板横屏的常用下限；加宽高比条件是为了避免折叠屏展开、分屏等
 * 「宽但不高的窗口」误套平板布局。
 */
export const TABLET_RAIL_WIDTH = 88

// 悬浮播放条和当前播放列表共用尺寸，始终相对整个窗口居中。
export const TABLET_PLAYER_WIDTH = '60%'
export const TABLET_PLAYER_MAX_WIDTH = 640
export const TABLET_PLAYER_BOTTOM_GAP = 10

export const TABLET_SETTINGS_MAX_WIDTH = 420
export const TABLET_CONFIRM_MAX_WIDTH = 480

export const isWideLayout = (width: number, height: number): boolean => {
  return width >= 900 && width / height > 1.2
}
