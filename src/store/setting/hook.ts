import { useEffect, useState } from 'react'
import state from './state'

export const useSettingValue = <T extends keyof LX.AppSetting>(key: T): LX.AppSetting[T] => {
  const [value, update] = useState(state.setting[key])

  useEffect(() => {
    const handleUpdate = (keys: Array<keyof LX.AppSetting>) => {
      if (!keys.includes(key)) return
      update(state.setting[key])
    }
    global.state_event.on('configUpdated', handleUpdate)
    return () => {
      global.state_event.off('configUpdated', handleUpdate)
    }
  }, [key])

  return value
}
