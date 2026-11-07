/**
 * 通用控件以 dp 为单位，只按应用字号缩放。
 *
 * createStyle 和列表行高大量在模块加载时求值，不能把启动窗口的宽高或密度
 * 算进这些尺寸，否则横屏启动后切到小窗会一直保留放大的控件。
 * 内容的列数、封面可用空间等由各页面根据当前窗口/布局单独计算。
 */
import { PixelRatio } from 'react-native'

/** 抵消原生 Text 的系统字号缩放，使文字由应用字号统一控制。 */
export function getTextSize(size: number) {
  return size / PixelRatio.getFontScale()
}

export function setSpText(size: number) {
  return getTextSize(size) * global.lx.fontSize
}

/** 输入与输出都是 dp，只应用一次应用字号。 */
export function scaleSizeH(size: number) {
  return size * global.lx.fontSize
}

export function scaleSizeW(size: number) {
  return size * global.lx.fontSize
}

export const scaleSizeWR = (size: number) => {
  return size * 2 - scaleSizeW(size)
}

export const scaleSizeAbsHR = (size: number) => {
  // 背景模糊等效果不跟随字号，也不受窗口尺寸影响。
  return size
}
