import Btn from './Btn'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'
import { useTheme } from '@/store/theme/hook'
import { strongIconShadow } from '@/screens/PlayDetail/components/iconStyle'


export default () => {
  const theme = useTheme()
  const handleShowCommentScreen = () => {
    navigations.pushCommentScreen(commonState.componentIds.playDetail!)
  }

  return <Btn icon="comment" color={theme['c-font']} iconStyle={strongIconShadow} onPress={handleShowCommentScreen} />
}
