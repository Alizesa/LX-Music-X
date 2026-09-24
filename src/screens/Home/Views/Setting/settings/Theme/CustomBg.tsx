import { memo, useCallback, useState } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import SettingButton from '../../components/Button'
import Slider, { type SliderProps } from '../../components/Slider'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { updateSetting } from '@/core/common'
import { mkdir, privateStorageDirectoryPath, selectFile, unlink } from '@/utils/fs'

// 选中的图片会被拷进应用私有目录：这样不依赖 SAF 的临时授权，重启后照样能读到
const BG_DIR = `${privateStorageDirectoryPath}/bg_images`

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const customBgImage = useSettingValue('theme.customBgImage')
  const bgOpacity = useSettingValue('theme.bgOpacity')
  const [picking, setPicking] = useState(false)

  const handlePick = useCallback(() => {
    if (picking) return
    setPicking(true)
    void (async() => {
      try {
        await mkdir(BG_DIR)
        // toPath 是目录，原生侧会把文件拷成 toPath/原文件名，完整路径在返回值的 data 里
        const file = await selectFile({ mimeTypes: ['image/*'], toPath: BG_DIR })
        // 用户取消时原生 resolve(null)
        if (!file?.data) return
        updateSetting({ 'theme.customBgImage': file.data })
        // 换图后删掉上一张，免得私有目录越堆越多（只删我们自己目录里的）
        if (customBgImage && customBgImage != file.data && customBgImage.startsWith(BG_DIR)) {
          void unlink(customBgImage).catch(() => {})
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'long')
      } finally {
        setPicking(false)
      }
    })()
  }, [customBgImage, picking])

  const handleClear = useCallback(() => {
    if (!customBgImage) return
    updateSetting({ 'theme.customBgImage': '' })
    if (customBgImage.startsWith(BG_DIR)) void unlink(customBgImage).catch(() => {})
  }, [customBgImage])

  // 实时写设置：只有松手才生效的话，调的时候看不到背景变化，全靠猜。
  // 设置本身是内存更新 + 节流落盘，拖动过程中的多次调用不会有性能负担。
  const handleValueChange = useCallback<NonNullable<SliderProps['onValueChange']>>(value => {
    updateSetting({ 'theme.bgOpacity': value })
  }, [])

  return (
    <>
      <SubTitle title={t('setting_basic_theme_custom_bg')}>
        <View style={styles.content}>
          {customBgImage ? <Image url={customBgImage} style={styles.preview} /> : null}
          <View style={styles.buttons}>
            <SettingButton onPress={handlePick} disabled={picking}>
              {t(customBgImage ? 'setting_basic_theme_custom_bg_change' : 'setting_basic_theme_custom_bg_pick')}
            </SettingButton>
            {customBgImage ? <SettingButton onPress={handleClear}>{t('setting_basic_theme_custom_bg_clear')}</SettingButton> : null}
          </View>
        </View>
      </SubTitle>
      <SubTitle title={t('setting_basic_theme_bg_opacity')}>
        <View style={styles.content}>
          <Text style={{ color: theme['c-primary-font'] }}>{Math.round(bgOpacity * 100)}%</Text>
          <Slider
            minimumValue={0.2}
            maximumValue={1}
            onValueChange={handleValueChange}
            step={0.05}
            value={bgOpacity}
          />
        </View>
      </SubTitle>
    </>
  )
})

const styles = createStyle({
  content: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  preview: {
    width: 72,
    height: 72,
    marginRight: 12,
    borderRadius: 6,
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
})
