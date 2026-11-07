import { useSyncExternalStore } from 'react'
import { windowSizeTools } from '@/utils/windowSizeTools'

const subscribe = (onChange: () => void) => windowSizeTools.onSizeChanged(onChange)
const getSnapshot = () => windowSizeTools.getSize()

// 分屏可能发生在首次渲染与订阅之间；React 会在订阅后重新检查快照。
export default () => useSyncExternalStore(subscribe, getSnapshot)
