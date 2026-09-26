import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'
import { BorderWidths } from '@/theme'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { scaleSizeW } from '@/utils/pixelRatio'
import { pop } from '@/navigation'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { useStatusbarHeight } from '@/store/common/hook'
import commonState from '@/store/common/state'
import singerState, { type AlbumDetailParams } from '@/store/singer/state'
import { handlePlay } from './listAction'

const COVER_SIZE = scaleSizeW(76)

export default memo(({ params }: { params: AlbumDetailParams }) => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()

  const back = () => {
    void pop(commonState.componentIds.albumDetail!)
  }
  const handlePlayAll = () => {
    const info = singerState.albumSongs[params.mid]
    if (!info) return
    void handlePlay(params.mid, info.list)
  }

  return (
    <View style={{ ...styles.container, paddingTop: statusBarHeight, borderBottomColor: theme['c-border-background'] }}>
      <TouchableOpacity style={styles.back} onPress={back}>
        <Icon name="chevron-left" size={26} color={theme['c-font']} />
      </TouchableOpacity>
      <View style={styles.infoRow}>
        <Image
          nativeID={`${NAV_SHEAR_NATIVE_IDS.albumDetail_pic}_to_${params.id}`}
          url={params.img}
          style={{ ...styles.cover, width: COVER_SIZE, height: COVER_SIZE }}
        />
        <View style={styles.info}>
          <Text size={16} numberOfLines={2}>{params.name}</Text>
          <Text size={12} color={theme['c-font-label']} style={styles.subText} numberOfLines={1}>{params.author}</Text>
          { params.publishDate ? <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{t('album_publish_date', { date: params.publishDate })}</Text> : null }
        </View>
      </View>
      <Button onPress={handlePlayAll} style={{ ...styles.playAll, backgroundColor: theme['c-primary-background'] }}>
        <Text style={styles.playAllText} color={theme['c-button-font']}>{t('play_all')}</Text>
      </Button>
    </View>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'column',
    borderBottomWidth: BorderWidths.normal,
  },
  back: {
    height: 40,
    justifyContent: 'center',
    paddingLeft: 10,
    paddingRight: 10,
  },
  infoRow: {
    flexDirection: 'row',
    padding: 10,
  },
  cover: {
    flexGrow: 0,
    flexShrink: 0,
    borderRadius: 4,
    overflow: 'hidden',
  },
  info: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 10,
  },
  subText: {
    paddingTop: 3,
    paddingBottom: 3,
  },
  playAll: {
    margin: 10,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 4,
  },
  playAllText: {
    fontSize: 13,
    textAlign: 'center',
  },
})
