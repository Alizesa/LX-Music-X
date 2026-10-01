import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'

import { toast } from '@/utils/tools'

import { useI18n } from '@/lang'
import { checkDesktopLyricOverlayPermission, hideDesktopLyric, openDesktopLyricOverlayPermissionActivity, showDesktopLyric } from '@/core/desktopLyric'
import { updateSetting } from '@/core/common'

export interface DesktopLyricEnableType {
  setEnabled: (enabled: boolean) => void
}

export default forwardRef<DesktopLyricEnableType, {}>((props, ref) => {
  const t = useI18n()
  const [visible, setVisible] = useState(false)
  // 临时诊断用，定位完就删（见 handleShowModal）
  const [errMessage, setErrMessage] = useState('')
  // const setIsShowDesktopLyric = useDispatch('common', 'setIsShowDesktopLyric')
  const confirmAlertRef = useRef<ConfirmAlertType>(null)

  useImperativeHandle(ref, () => ({
    setEnabled(enabled) {
      void handleChangeEnableDesktopLyric(enabled)
    },
  }))

  const handleShowModal = (err?: any) => {
    // 临时诊断：把失败原因一并显示出来。这个弹窗以前不管因为什么都只说「要悬浮窗权限」，
    // 权限明明是开的时候完全看不出到底哪一步炸了
    setErrMessage(err == null ? '' : String(err.message ?? err))
    if (visible) confirmAlertRef.current?.setVisible(true)
    else {
      setVisible(true)
      requestAnimationFrame(() => {
        confirmAlertRef.current?.setVisible(true)
      })
    }
  }
  const handleChangeEnableDesktopLyric = async(isEnable: boolean) => {
    if (isEnable) {
      try {
        await checkDesktopLyricOverlayPermission()
        await showDesktopLyric()
      } catch (err) {
        console.log(err)
        handleShowModal(err)
        // return false
      }
    } else await hideDesktopLyric()
    // return true
    updateSetting({ 'desktopLyric.enable': isEnable })
  }

  const handleTipsCancel = () => {
    updateSetting({ 'desktopLyric.enable': false })
    toast(t('disagree_tip'), 'long')
  }
  const handleTipsConfirm = () => {
    confirmAlertRef.current?.setVisible(false)
    void openDesktopLyricOverlayPermissionActivity()
  }

  return (
    visible
      ? (
          <ConfirmAlert
            ref={confirmAlertRef}
            onCancel={handleTipsCancel}
            onConfirm={handleTipsConfirm}
            bgHide={false}
            closeBtn={false}
            cancelText={t('disagree')}
            confirmText={t('agree_go')}
            text={errMessage ? `${t('setting_lyric_desktop_permission_tip')}\n\n[诊断] ${errMessage}` : t('setting_lyric_desktop_permission_tip')} />
        )
      : null
  )
})
