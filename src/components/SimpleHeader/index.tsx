import { memo, useCallback } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useStatusbarHeight } from '@/store/common/hook'
import { useTheme } from '@/store/theme/hook'
import { pop } from '@/navigation'
import { createStyle } from '@/utils/tools'

// 推入式页面（搜索/设置/下载/播放历史）共用的返回头。
// 顶栏样式跟 QQMusicRecommend 现有的自绘头保持一致。
const HEADER_HEIGHT = 50

export default memo(({ componentId, title, right }: {
  componentId: string
  title: string
  right?: React.ReactNode
}) => {
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()

  const back = useCallback(() => {
    void pop(componentId)
  }, [componentId])

  return (
    <View style={{
      ...styles.container,
      height: HEADER_HEIGHT + statusBarHeight,
      paddingTop: statusBarHeight,
      borderBottomColor: theme['c-border-background'],
    }}>
      <TouchableOpacity onPress={back} style={styles.backButton}>
        <Icon name="chevron-left" size={24} color={theme['c-font']} />
      </TouchableOpacity>
      <Text style={styles.title} size={18} numberOfLines={1}>{title}</Text>
      {right ?? null}
    </View>
  )
})

const styles = createStyle({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  backButton: {
    width: 50,
    alignItems: 'center',
  },
  title: {
    flex: 1,
  },
})
