import { cancelUpdateDownload, cleanupUpdateDownloads, downloadNewVersion, getVersionInfo, hasDownloadedUpdate, updateApp } from '@/utils/version'
import { isChannel, parseVersion, selectUpdate, type UpdateChannel, type UpdatePreferences } from '../../shared/release'
import { getInstalledAppInfo } from '@/utils/nativeModules/utils'
import versionActions from '@/store/version/action'
import versionState, { type InitState } from '@/store/version/state'
import { getIgnoreVersionFailTipTime, getUpdatePreferences, saveUpdatePreferences, saveIgnoreVersionFailTipTime } from '@/utils/data'
import { showVersionModal } from '@/navigation'
import { Navigation } from 'react-native-navigation'
import { toast } from '@/utils/tools'

const checkErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

let preferences: UpdatePreferences
let initialization: Promise<void> | null = null
let revision = 0
let pendingCheck: { revision: number, promise: Promise<void> } | null = null
let preferenceWrites = Promise.resolve()
let preferenceWriteRevision = 0
let durablePreferences: UpdatePreferences | null = null
const persistPreferences = () => {
  const writeRevision = ++preferenceWriteRevision
  const snapshot = { channel: preferences.channel, ignored: { ...preferences.ignored } }
  preferenceWrites = preferenceWrites.catch(() => {}).then(async() => {
    await saveUpdatePreferences(snapshot)
    durablePreferences = snapshot
  }).catch((error: unknown) => {
    if (writeRevision === preferenceWriteRevision && durablePreferences) {
      const channelChanged = preferences.channel !== durablePreferences.channel
      preferences = { channel: durablePreferences.channel, ignored: { ...durablePreferences.ignored } }
      versionActions.setIgnoreVersion(preferences.ignored[preferences.channel] ?? null)
      if (channelChanged) {
        // Invalidate work started under the unsaved selection. The rollback
        // target is the last successful write, not another pending selection.
        revision++
        cancelUpdateDownload()
        versionActions.setProgress({ total: 0, current: 0 })
        versionActions.setVersionInfo({ channel: preferences.channel, newVersion: null, status: 'error', isLatest: false, isUnknown: true, checkError: checkErrorMessage(error), integrityError: false, installError: false })
      }
    }
    throw error
  })
  return { revision: writeRevision, promise: preferenceWrites }
}

export const initializeVersion = async() => {
  if (versionState.versionInfo.initialized) return
  if (!initialization) {
    initialization = (async() => {
      const [installed, saved] = await Promise.all([getInstalledAppInfo(), getUpdatePreferences()])
      void cleanupUpdateDownloads(installed.version).catch(() => {})
      parseVersion(installed.version)
      const channel: UpdateChannel = saved && isChannel(saved.channel) ? saved.channel : 'stable'
      const ignored: UpdatePreferences['ignored'] = {}
      for (const item of ['stable', 'next'] as const) {
        const tag = saved?.ignored?.[item]
        if (typeof tag !== 'string' || !tag.startsWith('v')) continue
        try { parseVersion(tag.slice(1)); ignored[item] = tag } catch {}
      }
      preferences = { channel, ignored }
      const savedIgnored = saved?.ignored
      const alreadySaved = saved?.channel === channel && savedIgnored != null &&
        typeof savedIgnored === 'object' && !Array.isArray(savedIgnored) &&
        Object.keys(savedIgnored).length === Object.keys(ignored).length &&
        (['stable', 'next'] as const).every(item => savedIgnored[item] === ignored[item])
      // Valid preferences are already durable. Do not require a new write to
      // use them; keep a separate snapshot for later failed-write rollbacks.
      if (alreadySaved) durablePreferences = { channel, ignored: { ...ignored } }
      else await persistPreferences().promise
      versionActions.setIgnoreVersion(ignored[channel] ?? null)
      versionActions.setVersionInfo({ ...installed, channel, initialized: true })
    })().catch((error: unknown) => {
      initialization = null
      throw error
    })
  }
  await initialization
}

export const showModal = () => {
  if (versionState.showModal) return
  versionActions.setVisibleModal(true)
  showVersionModal()
}

export const hideModal = (componentId: string) => {
  if (!versionState.showModal) return
  versionActions.setVisibleModal(false)
  void Navigation.dismissOverlay(componentId)
}

const reportCheckFailure = async() => {
  try {
    const time = await getIgnoreVersionFailTipTime()
    if (Date.now() - time < 7 * 86400000) return
    saveIgnoreVersionFailTipTime(Date.now())
    toast(global.i18n.t('version_tip_unknown'))
  } catch { toast(global.i18n.t('version_tip_unknown')) }
}

const hasUpdateDownload = () => versionState.versionInfo.status === 'downloading' || versionState.versionInfo.status === 'downloaded'

export const checkUpdate = async(force = false, notify = true) => {
  if (hasUpdateDownload()) return
  try { await initializeVersion() } catch (error: unknown) {
    versionActions.setVersionInfo({ status: 'error', newVersion: null, isLatest: false, isUnknown: true, checkError: checkErrorMessage(error) })
    if (notify) await reportCheckFailure()
    return
  }
  // Initialization yields even when already complete. A download may have
  // started in that gap and must retain its candidate and state.
  if (hasUpdateDownload()) return
  if (pendingCheck?.revision === revision) return pendingCheck.promise
  const currentRevision = revision
  const channel = preferences.channel
  const check = (async() => {
    versionActions.setVersionInfo({ status: 'checking', isLatest: false, isUnknown: false, checkError: null, integrityError: false, installError: false, newVersion: null })
    try {
      const { manifests, incomplete, errors = [] } = await getVersionInfo(channel, force)
      const installed = await getInstalledAppInfo()
      if (currentRevision !== revision || preferences.channel !== channel) return
      const candidate = selectUpdate(manifests, channel, installed.version, installed.versionCode)
      if (!candidate && incomplete) throw new Error(errors.join('\n') || 'Update channels could not be fully checked')
      versionActions.setVersionInfo({ ...installed, status: 'idle', isLatest: candidate === null, isUnknown: false, newVersion: candidate })
      if (notify && candidate && preferences.ignored[channel] !== candidate.tag) showModal()
    } catch (error: unknown) {
      if (currentRevision !== revision) return
      versionActions.setVersionInfo({ status: 'error', isLatest: false, isUnknown: true, checkError: checkErrorMessage(error), newVersion: null })
      if (notify) await reportCheckFailure()
    }
  })()
  pendingCheck = { revision: currentRevision, promise: check }
  try { await check } finally {
    if (pendingCheck?.promise === check) pendingCheck = null
  }
}

export const setUpdateChannel = async(channel: UpdateChannel) => {
  if (!isChannel(channel)) return
  let currentRevision = revision
  let writeRevision: number | null = null
  try {
    await initializeVersion()
    if (preferences.channel === channel) return
    currentRevision = ++revision
    cancelUpdateDownload()
    preferences.channel = channel
    versionActions.setIgnoreVersion(preferences.ignored[channel] ?? null)
    versionActions.setProgress({ total: 0, current: 0 })
    versionActions.setVersionInfo({ channel, newVersion: null, isLatest: false, isUnknown: false, checkError: null, integrityError: false, installError: false, status: 'checking' })
    const write = persistPreferences()
    writeRevision = write.revision
    await write.promise
    if (currentRevision === revision) await checkUpdate(true, false)
  } catch (error: unknown) {
    if (writeRevision === null ? currentRevision !== revision : writeRevision !== preferenceWriteRevision) return
    versionActions.setVersionInfo({ status: 'error', isUnknown: true, isLatest: false, checkError: checkErrorMessage(error) })
    toast(global.i18n.t('version_tip_failed'))
  }
}

const reportDownloadFailure = (error: unknown) => {
  const integrityError = error instanceof Error && error.message === 'UPDATE_INTEGRITY_FAILED'
  const installError = hasDownloadedUpdate(versionState.versionInfo.newVersion?.tag ?? '')
  versionActions.setVersionInfo({ status: installError ? 'downloaded' : 'error', integrityError, installError })
  toast(global.i18n.t(installError ? 'version_tip_install_failed' : integrityError ? 'version_tip_integrity_failed' : 'version_tip_failed'))
}

export const downloadUpdate = async() => {
  const candidate = versionState.versionInfo.newVersion
  if (!candidate || versionState.versionInfo.isLatest || versionState.versionInfo.status === 'downloading') return
  // Results from older checks cannot replace the candidate bound to this APK.
  const currentRevision = ++revision
  versionActions.setVersionInfo({ status: 'downloading', integrityError: false, installError: false })
  versionActions.setProgress({ total: 0, current: 0 })
  try {
    await downloadNewVersion(candidate, (total, current) => {
      if (currentRevision === revision) versionActions.setProgress({ total, current })
    })
    if (currentRevision === revision) versionActions.setVersionInfo({ status: 'downloaded' })
  } catch (error: unknown) {
    if (currentRevision === revision) reportDownloadFailure(error)
  }
}

export const installDownloadedUpdate = async() => {
  const currentRevision = revision
  versionActions.setVersionInfo({ installError: false })
  try { await updateApp() } catch (error: unknown) {
    if (currentRevision === revision) reportDownloadFailure(error)
  }
}

export const setIgnoreVersion = async(tag: InitState['ignoreVersion']) => {
  let writeRevision: number | null = null
  try {
    await initializeVersion()
    if (tag !== null && tag !== versionState.versionInfo.newVersion?.tag) return
    if (tag === null) delete preferences.ignored[preferences.channel]
    else preferences.ignored[preferences.channel] = tag
    versionActions.setIgnoreVersion(tag)
    const write = persistPreferences()
    writeRevision = write.revision
    await write.promise
  } catch {
    if (writeRevision !== null && writeRevision !== preferenceWriteRevision) return
    toast(global.i18n.t('version_tip_failed'))
  }
}
