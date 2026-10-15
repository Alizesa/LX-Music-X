import { useRef } from 'react'
import Btn from './Btn'
import MoreMenu, { type MoreMenuType } from '@/screens/PlayDetail/components/MoreMenu'

// 三点：点开从下方弹出功能页（内容见 PlayDetail/components/MoreMenu）
export default () => {
  const moreMenuRef = useRef<MoreMenuType>(null)

  return (
    <>
      <Btn icon="dots-vertical" onPress={() => { moreMenuRef.current?.show() }} />
      <MoreMenu ref={moreMenuRef} />
    </>
  )
}
