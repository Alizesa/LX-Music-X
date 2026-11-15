/* eslint-disable @typescript-eslint/no-var-requires */
import { type ImageSourcePropType } from 'react-native'

// 29dp 预览使用最长边 128px 的独立素材。
export const BG_IMAGE_PREVIEWS = {
  'china_ink.jpg': require('./images/previews/china_ink.png') as ImageSourcePropType,
  'jqbg.jpg': require('./images/previews/jqbg.png') as ImageSourcePropType,
  'landingMoon.png': require('./images/previews/landingMoon2.png') as ImageSourcePropType,
  'myzcbg.jpg': require('./images/previews/myzcbg.png') as ImageSourcePropType,
  'xnkl.png': require('./images/previews/xnkl.png') as ImageSourcePropType,
} as const
