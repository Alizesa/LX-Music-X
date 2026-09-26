import { View } from 'react-native'

import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'


interface Props {
  title: string
  children: React.ReactNode | React.ReactNode[]
  right?: React.ReactNode
  fill?: boolean
}

export default ({ title, children, right, fill }: Props) => {
  const theme = useTheme()

  return (
    <View style={fill ? { ...styles.container, flex: 1 } : styles.container}>
      <View style={styles.header}>
        <Text style={{ ...styles.title, borderLeftColor: theme['c-primary'] }} size={16} >{title}</Text>
        {right}
      </View>
      <View style={fill ? styles.content : undefined}>
        {children}
      </View>
    </View>
  )
}


const styles = createStyle({
  container: {
    // paddingLeft: 10,
    // backgroundColor: 'rgba(0,0,0,0.2)',
  },
  title: {
    borderLeftWidth: 5,
    paddingLeft: 12,
    marginBottom: 10,
    // lineHeight: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  content: { flex: 1 },
})
