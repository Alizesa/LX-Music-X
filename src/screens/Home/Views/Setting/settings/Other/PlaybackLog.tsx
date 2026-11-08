import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import CheckBoxItem from '../../components/CheckBoxItem'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { clipboardWriteText, toast } from '@/utils/tools'
import { writeFile } from '@/utils/fs'
import { debounce } from '@/utils/common'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
import { clearPlaybackLogs, exportPlaybackLogs, getPlaybackLogSnapshot, onPlaybackLogUpdate, readPlaybackLogs } from '@/utils/playbackLog'

const statusKeys = {
  disabled: 'playback_log_reason_disabled',
  native_unavailable: 'playback_log_reason_native',
  cache_disabled: 'playback_log_reason_cache',
  stopping: 'playback_log_reason_stopping',
  playback_not_ready: 'playback_log_reason_ready',
  not_playing: 'playback_log_reason_playing',
  no_next: 'playback_log_reason_next',
  same_track: 'playback_log_reason_same',
  retry_exhausted: 'playback_log_reason_retries',
  task_exists: 'playback_log_reason_exists',
  stable_playback: 'playback_log_reason_stable',
  cooldown: 'playback_log_reason_cooldown',
  selecting: 'playback_log_reason_selecting',
  buffer_query: 'playback_log_reason_query',
  duration_query: 'playback_log_reason_query',
  invalid_buffer: 'playback_log_reason_invalid',
  preparing: 'playback_log_reason_resolving',
  resolving: 'playback_log_reason_resolving',
  head: 'playback_log_reason_head',
  filling: 'playback_log_reason_filling',
  ready: 'playback_log_reason_prepared',
  cache_unavailable: 'playback_log_reason_unavailable',
  paused: 'playback_log_reason_paused',
  claimed: 'playback_log_reason_claimed',
} as const

export default memo(() => {
  const t = useI18n()
  const enabled = useSettingValue('player.debugLog')
  const screenVisible = useScreenVisible()
  const alertRef = useRef<ConfirmAlertType>(null)
  const chooseRef = useRef<ChoosePathType>(null)
  const frameRef = useRef<number | null>(null)
  const mounted = useRef(true)
  const shown = useRef(false)
  const revision = useRef(0)
  const [visible, setVisible] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [snapshot, setSnapshot] = useState<ReturnType<typeof getPlaybackLogSnapshot>>({})

  const refresh = useCallback(async() => {
    const current = ++revision.current
    const value = await readPlaybackLogs(true)
    if (!mounted.current || !shown.current || current !== revision.current) return
    setSnapshot(getPlaybackLogSnapshot())
    setText(value)
  }, [])
  const failed = useCallback((error: unknown) => {
    if (mounted.current) toast(t('playback_log_failed', { message: error instanceof Error ? error.message : String(error) }), 'long')
  }, [t])
  const hide = useCallback(() => {
    shown.current = false
    revision.current++
    setVisible(false)
    setText('')
    setSnapshot({})
  }, [])
  useEffect(() => {
    if (screenVisible) return
    alertRef.current?.setVisible(false)
    setChoosing(false)
    hide()
  }, [screenVisible, hide])
  const unmount = useCallback(() => {
    mounted.current = false
    shown.current = false
    revision.current++
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
  }, [])
  useEffect(() => {
    mounted.current = true
    return unmount
  }, [unmount])
  useEffect(() => {
    if (!visible || !screenVisible) return
    const update = debounce(() => { void refresh().catch(failed) }, 400)
    const remove = onPlaybackLogUpdate(update)
    void refresh().catch(failed)
    return () => { remove(); update.cancel() }
  }, [visible, screenVisible, refresh, failed])

  const run = async(action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await action() } catch (error) { failed(error) } finally { if (mounted.current) setBusy(false) }
  }
  const open = () => {
    shown.current = true
    setSnapshot(getPlaybackLogSnapshot())
    setVisible(true)
    alertRef.current?.setVisible(true)
  }
  const copy = () => { void run(async() => { clipboardWriteText(await exportPlaybackLogs()); toast(t('playback_log_copied')) }) }
  const clear = () => { void run(async() => { await clearPlaybackLogs(); if (shown.current) await refresh(); toast(t('setting_other_log_tip_clean_success')) }) }
  const chooseExport = () => {
    setChoosing(true)
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      chooseRef.current?.show({ title: t('playback_log_export'), dirOnly: true })
    })
  }
  const exportTo = (path: string) => {
    setChoosing(false)
    void run(async() => {
      const fileName = `lx-playback-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      await writeFile(`${path}/${fileName}`, await exportPlaybackLogs())
      toast(t('playback_log_exported', { fileName }), 'long')
    })
  }
  const status = () => {
    if (!enabled) return t('playback_log_off')
    const scheduler = snapshot.scheduler
    if (!scheduler) return t('playback_log_reason_init')
    const reason = scheduler.reason === 'task_exists' ? String(snapshot.preloadTask?.phase ?? scheduler.reason) : String(scheduler.reason)
    if (reason === 'buffer_low') {
      const seconds = Number(scheduler.bufferSeconds)
      return t('playback_log_reason_buffer', { seconds: Number.isFinite(seconds) ? seconds.toFixed(1) : '?' })
    }
    const key = statusKeys[reason as keyof typeof statusKeys]
    return t(key ?? 'playback_log_reason_waiting')
  }

  return <>
    <SubTitle title={t('playback_log_title')}>
      <View style={{ marginLeft: -25, paddingBottom: 12 }}>
        <CheckBoxItem check={enabled} label={t('playback_log_enable')} helpDesc={t('playback_log_tip')}
          onChange={value => { updateSetting({ 'player.debugLog': value }) }} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button onPress={open}>{t('setting_other_log_btn_show')}</Button>
        <Button disabled={busy} onPress={copy}>{t('playback_log_copy')}</Button>
        <Button disabled={busy} onPress={chooseExport}>{t('playback_log_export')}</Button>
        <Button disabled={busy} onPress={clear}>{t('setting_other_log_btn_clean')}</Button>
      </View>
    </SubTitle>
    <ConfirmAlert ref={alertRef} title={t('playback_log_title')} onHide={hide} showConfirm={false} cancelText={t('setting_other_log_btn_hide')}>
      <View onStartShouldSetResponder={() => true}>
        <Text size={14}>{t('playback_log_status', { status: status() })}</Text>
        {enabled && snapshot.environment?.nativeDetails === false ? <Text size={12}>{t('playback_log_native_tip')}</Text> : null}
        {snapshot.log?.writeError ? <Text size={12}>{t('playback_log_failed', { message: String(snapshot.log.writeError) })}</Text> : null}
        <Text size={12} style={{ marginTop: 10 }}>{t('playback_log_preview_tip')}</Text>
        <Text selectable size={12} style={{ marginTop: 10 }}>{text || t('setting_other_log_tip_null')}</Text>
      </View>
    </ConfirmAlert>
    {choosing ? <ChoosePath ref={chooseRef} onConfirm={exportTo} /> : null}
  </>
})
