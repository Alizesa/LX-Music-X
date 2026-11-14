import { useState } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Image from '@/components/common/Image'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { scaleSizeH } from '@/utils/pixelRatio'
import { BorderWidths } from '@/theme'
import { useTheme } from '@/store/theme/hook'

const MAX_IMAGE_HEIGHT = scaleSizeH(260)


export default ({ url, maxWidth }: { url: string, maxWidth: number }) => {
  const [shownUrl, setShownUrl] = useState<string | null>(null)
  const width = Math.min(maxWidth, MAX_IMAGE_HEIGHT)
  const height = width * 0.75
  const theme = useTheme()

  return (
    width > 0 ? (
      <View style={{ height, width }}>
        {
          shownUrl === url ? (<Image
            url={url}
            resizeMode="contain"
            resizeMethod="resize"
            style={{ height, width, borderWidth: BorderWidths.normal, borderColor: theme['c-border-background'] }}
          />) : (
            <TouchableOpacity style={{ ...styles.defaultPic, borderColor: theme['c-border-background'], backgroundColor: theme['c-primary-light-200-alpha-900'] }} onPress={() => { setShownUrl(url) }}>
              <Text size={13} color={theme['c-primary-font-hover']}>{global.i18n.t('comment_show_image')}</Text>
            </TouchableOpacity>
          )
        }
      </View>
    ) : null
  )
}

const styles = createStyle({
  defaultPic: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: BorderWidths.normal,
    borderStyle: 'dashed',
  },
})
