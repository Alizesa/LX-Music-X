import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { saveQQMusicSession } from '@/core/qqMusic'
import { createStyle, toast } from '@/utils/tools'

export interface QQMusicCookieModalType {
  show: () => void
}

export default forwardRef<QQMusicCookieModalType, { onLoggedIn: (user: LX.QQMusic.UserInfo) => void }>(({ onLoggedIn }, ref) => {
  const modalRef = useRef<ModalType>(null)
  const [cookie, setCookie] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    show() {
      setCookie('')
      modalRef.current?.setVisible(true)
    },
  }))

  const submit = async() => {
    if (submitting) return
    setSubmitting(true)
    try {
      const user = await saveQQMusicSession(cookie)
      global.app_event.qqMusicAccountUpdated(user)
      onLoggedIn(user)
      toast(global.i18n.t('qq_login_success'))
      modalRef.current?.setVisible(false)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : global.i18n.t('qq_login_failed'), 'long')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal ref={modalRef} bgColor="rgba(0,0,0,.35)">
      <View style={styles.centered}>
        <View style={{ ...styles.dialog, backgroundColor: theme['c-content-background'] }}>
          <Text size={16} style={styles.title}>{global.i18n.t('qq_cookie_login')}</Text>
          <View style={{ ...styles.input, borderColor: theme['c-border-background'] }}>
            <Input
              value={cookie}
              onChangeText={setCookie}
              multiline
              autoCorrect={false}
              placeholder={global.i18n.t('qq_cookie_placeholder')}
              style={styles.textInput}
            />
          </View>
          <View style={styles.actions}>
            <Button style={styles.button} onPress={() => modalRef.current?.setVisible(false)}><Text>{global.i18n.t('cancel')}</Text></Button>
            <Button style={styles.button} disabled={!cookie.trim() || submitting} onPress={() => { void submit() }}><Text color={theme['c-primary-font']}>{global.i18n.t('confirm')}</Text></Button>
          </View>
        </View>
      </View>
    </Modal>
  )
})

const styles = createStyle({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  dialog: { width: '100%', maxWidth: 520, borderRadius: 6, padding: 16 },
  title: { marginBottom: 12 },
  input: { minHeight: 120, borderWidth: 1, borderRadius: 4, padding: 8 },
  textInput: { minHeight: 100, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  button: { minWidth: 72, height: 38, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
})
