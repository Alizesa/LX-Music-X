import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useKeyboard } from '@/utils/hooks'
import { useI18n } from '@/lang'
import { createQQMusicPlaylist, renameQQMusicPlaylist } from '@/core/qqMusicFavorite'
import { createStyle, toast } from '@/utils/tools'

type EditMode = 'create' | 'rename'

interface ShowOptions {
  mode: EditMode
  playlist?: Pick<LX.QQMusic.PlaylistInfo, 'id' | 'name'>
  /** 写入成功后通知页面（核心层已经更新缓存并广播，一般不需要再重拉） */
  onDone?: () => void
}

export interface QQPlaylistEditModalType {
  show: (options: ShowOptions) => void
}

export default forwardRef<QQPlaylistEditModalType>((_, ref) => {
  const modalRef = useRef<ModalType>(null)
  const optionsRef = useRef<ShowOptions | null>(null)
  const t = useI18n()
  const theme = useTheme()
  const { keyboardShown, keyboardHeight } = useKeyboard()
  const [mode, setMode] = useState<EditMode>('create')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useImperativeHandle(ref, () => ({
    show(options) {
      optionsRef.current = options
      setMode(options.mode)
      setName(options.mode == 'rename' ? options.playlist?.name ?? '' : '')
      setBusy(false)
      modalRef.current?.setVisible(true)
    },
  }))

  const close = () => {
    if (!busy) modalRef.current?.setVisible(false)
  }

  const submit = async() => {
    const options = optionsRef.current
    if (!options || busy) return
    const title = name.trim()
    if (!title) {
      toast(t('qq_playlist_name_required'))
      return
    }
    setBusy(true)
    try {
      if (options.mode == 'create') {
        await createQQMusicPlaylist(title)
      } else {
        if (!options.playlist) return
        await renameQQMusicPlaylist(options.playlist, title)
      }
      toast(t(options.mode == 'create' ? 'qq_playlist_create_success' : 'qq_playlist_rename_success'))
      modalRef.current?.setVisible(false)
      options.onDone?.()
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('qq_playlist_edit_failed'), 'long')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal ref={modalRef} bgColor="rgba(0,0,0,.35)" bgHide={false} keyHide={!busy}>
      <View style={{ ...styles.centered, paddingBottom: keyboardShown ? keyboardHeight : 0 }}>
        <View style={{ ...styles.dialog, backgroundColor: theme['c-content-background'] }}>
          <Text size={16} style={styles.title}>{t(mode == 'create' ? 'qq_playlist_create' : 'qq_playlist_rename')}</Text>
          <Input
            value={name}
            onChangeText={setName}
            placeholder={t('qq_playlist_name_placeholder')}
            maxLength={40}
            autoFocus
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={() => { void submit() }}
            style={{ ...styles.input, borderColor: theme['c-border-background'] }}
          />
          <View style={styles.actions}>
            <Button style={styles.button} disabled={busy} onPress={close}><Text>{t('cancel')}</Text></Button>
            <Button style={styles.button} disabled={busy || !name.trim()} onPress={() => { void submit() }}>
              <Text color={theme['c-primary-font']}>{t('confirm')}</Text>
            </Button>
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
  input: { height: 40, borderWidth: 1, borderRadius: 4, paddingHorizontal: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  button: { minWidth: 72, height: 38, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
})
