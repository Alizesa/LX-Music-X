import { View } from 'react-native'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'

// 首页推荐流的占位。真正的内容（方形每日推荐卡 + 猜你喜欢 + 相似推荐 + 推荐歌单）
// 在下一期实现，这里先保证底部导航骨架能跑通。
export default () => {
  const t = useI18n()

  return (
    <View style={styles.container}>
      <Text style={styles.hint} size={13}>{t('home_recommend_wip')}</Text>
    </View>
  )
}

const styles = createStyle({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  hint: {
    textAlign: 'center',
  },
})
