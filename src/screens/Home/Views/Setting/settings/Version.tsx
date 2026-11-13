import { memo, useState, useEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import Section from '../components/Section'
import SubTitle from '../components/SubTitle'
import Button from '../components/Button'
import { sizeFormate } from '@/utils'

import { useI18n } from '@/lang'
import { useVersionDownloadProgressUpdated, useVersionInfo } from '@/store/version/hook'
import { useSettingValue } from '@/store/setting/hook'
import Text from '@/components/common/Text'
import DorpDownMenu from '@/components/common/DorpDownMenu'
import { IconIonicons } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { scaleSizeW } from '@/utils/pixelRatio'
import CheckBoxItem from '../components/CheckBoxItem'
import { updateSetting } from '@/core/common'
import { checkUpdate, initializeVersion, setUpdateChannel, showModal } from '@/core/version'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const versionInfo = useVersionInfo()
  const channels = useMemo(() => [
    { action: 'stable', label: t('setting_version_channel_stable') },
    { action: 'next', label: t('setting_version_channel_next') },
  ] as const, [t])
  const channelLabel = channels.find(item => item.action === versionInfo.channel)!.label
  const autoCheckUpdate = useSettingValue('version.autoCheckUpdate')
  // const versionStatus = useVrsionUpdateStatus()
  const [title, setTitle] = useState('')
  const [tip, setTip] = useState('')
  const progress = useVersionDownloadProgressUpdated()
  useEffect(() => { void initializeVersion().catch(() => {}) }, [])
  const handleOpenVersionModal = () => {
    showModal()
    if (versionInfo.newVersion == null || versionInfo.isUnknown || versionInfo.isLatest) void checkUpdate(true, false)
  }

  useEffect(() => {
    if (!versionInfo.newVersion && versionInfo.status === 'idle' && !versionInfo.isLatest) {
      setTitle(t('version_title_not_checked'))
      setTip('')
    } else if (versionInfo.isLatest) {
      setTitle(t('version_tip_latest'))
      setTip('')
    } else if (versionInfo.isUnknown) {
      setTitle(t('version_title_unknown'))
      setTip(t('version_tip_unknown') + (versionInfo.checkError ? '\n' + t('version_check_error_details', { message: versionInfo.checkError }) : ''))
    } else {
      switch (versionInfo.status) {
        case 'downloading':
          setTitle(t('version_title_new'))
          setTip(t('version_btn_downloading', {
            total: sizeFormate(progress.total),
            current: sizeFormate(progress.current),
            progress: progress.total ? (progress.current / progress.total * 100).toFixed(2) : '0',
          }))
          break
        case 'downloaded':
          setTitle(t('version_title_update'))
          setTip(versionInfo.installError ? t('version_tip_install_failed') : '')
          break
        case 'checking':
          setTitle(t('version_title_checking'))
          setTip('')
          break
        case 'error':
          setTitle(t('version_title_failed'))
          setTip(t(versionInfo.integrityError ? 'version_tip_integrity_failed' : 'version_tip_failed'))
          break
        // case 'idle':
        //   break
        default:
          setTitle(t('version_title_new'))
          setTip('')
          break
      }
    }
  }, [t, versionInfo, progress])

  return (
    <Section title={t('setting_version')}>
      <SubTitle title={title}>
        <View style={styles.desc}>
          <Text size={14}>{t('version_label_latest_ver')}{versionInfo.newVersion?.version}</Text>
          <Text size={14}>{t('version_label_current_ver')}{versionInfo.version}</Text>
          {
            tip ? <Text selectable size={14}>{tip}</Text> : null
          }
        </View>
        <View style={styles.btn}>
          <Button onPress={handleOpenVersionModal}>{t('setting_version_show_ver_modal')}</Button>
        </View>
      </SubTitle>
      <SubTitle title={t('setting_version_channel')}>
        <View style={styles.btn}>
          <DorpDownMenu
            menus={channels}
            activeId={versionInfo.channel}
            disabled={!versionInfo.initialized}
            accessibilityLabel={`${t('setting_version_channel')}: ${channelLabel}`}
            btnStyle={{ ...styles.channelSelect, backgroundColor: theme['c-button-background'], borderColor: theme['c-border-background'] }}
            onPress={({ action }) => { if (versionInfo.initialized) void setUpdateChannel(action) }}
          >
            <View style={styles.channelValue}>
              <Text size={14} numberOfLines={1} style={styles.channelLabel} color={theme['c-button-font']}>{channelLabel}</Text>
              <IconIonicons name="chevron-down" size={scaleSizeW(16)} color={theme['c-button-font']} />
            </View>
          </DorpDownMenu>
        </View>
        <Text size={13} style={styles.channelTip}>{t('setting_version_channel_tip')}</Text>
      </SubTitle>
      <View style={styles.autoCheck}>
        <CheckBoxItem
          check={autoCheckUpdate}
          label={t('setting_version_auto_check')}
          onChange={(value) => { updateSetting({ 'version.autoCheckUpdate': value }) }}
        />
        <Text size={13} style={styles.autoCheckTip}>{t('setting_version_auto_check_tip')}</Text>
      </View>
    </Section>
  )
})

const styles = StyleSheet.create({
  desc: {
    marginBottom: 8,
  },
  btn: {
    flexDirection: 'row',
  },
  autoCheck: {
    marginTop: 4,
  },
  channelTip: {
    marginTop: 8,
  },
  channelSelect: {
    width: 160,
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
  },
  channelValue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  channelLabel: {
    flexShrink: 1,
    marginRight: 16,
  },
  autoCheckTip: {
    marginTop: 4,
    paddingLeft: 25,
  },
})
