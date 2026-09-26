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
import { formatPlayCount } from '@/utils'
import { pop } from '@/navigation'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { useStatusbarHeight } from '@/store/common/hook'
import commonState from '@/store/common/state'
import singerState, { type SingerDetailParams, type SingerInfo } from '@/store/singer/state'
import { handlePlay } from './listAction'

const AVATAR_SIZE = scaleSizeW(76)

/** 歌手头像地址，与搜索结果里用的是同一个，共享元素动画才不会跳 */
export const getSingerPicUrl = (mid: string) => `https://y.gtimg.cn/music/photo_new/T001R500x500M000${mid}.jpg`

export default memo(({ params, info }: {
  params: SingerDetailParams
  /** 还没请求回来时为 null，先用列表页带过来的名字顶着 */
  info: SingerInfo | null
}) => {
  const theme = useTheme()
  const t = useI18n()
  const statusBarHeight = useStatusbarHeight()

  const name = info?.name ?? params.name
  // 接口没给简介时占位；一条都没拿到信息时先不显示，免得闪一下占位文案
  const briefText = info == null ? '' : (info.brief === '' ? t('singer_no_brief') : info.brief)
  const stats = info
    ? [
        t('singer_song_count', { num: formatPlayCount(info.totalSong) }),
        t('singer_album_count', { num: formatPlayCount(info.totalAlbum) }),
        t('singer_fans_count', { num: formatPlayCount(info.fans) }),
      ].join('  ·  ')
    : ''

  const back = () => {
    void pop(commonState.componentIds.singerDetail!)
  }
  const handlePlayAll = () => {
    const record = singerState.singers[params.mid]
    if (!record) return
    void handlePlay(params.mid, record.songs.list)
  }

  return (
    <View style={{ ...styles.container, paddingTop: statusBarHeight, borderBottomColor: theme['c-border-background'] }}>
      <TouchableOpacity style={styles.back} onPress={back}>
        <Icon name="chevron-left" size={26} color={theme['c-font']} />
      </TouchableOpacity>
      <View style={styles.infoRow}>
        <Image
          nativeID={`${NAV_SHEAR_NATIVE_IDS.singerDetail_pic}_to_${params.id}`}
          url={params.picUrl ? params.picUrl : getSingerPicUrl(params.mid)}
          style={{ ...styles.avatar, width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2 }}
        />
        <View style={styles.info}>
          <Text size={16} numberOfLines={1}>{name}</Text>
          {stats ? <Text size={12} color={theme['c-font-label']} style={styles.stats} numberOfLines={1}>{stats}</Text> : null}
          <Text size={12} color={theme['c-font-label']} numberOfLines={4}>{briefText}</Text>
        </View>
      </View>
      <Button onPress={handlePlayAll} disabled={!info} style={{ ...styles.playAll, backgroundColor: theme['c-primary-background'] }}>
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
  avatar: {
    flexGrow: 0,
    flexShrink: 0,
    overflow: 'hidden',
  },
  info: {
    flexGrow: 1,
    flexShrink: 1,
    paddingLeft: 10,
  },
  stats: {
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
