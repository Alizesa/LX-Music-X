import { version } from '../../../package.json'
import { type UpdateChannel, type UpdateManifest, type ReleaseNotes } from '../../../shared/release'

export interface ProgressInfo {
  total: number
  current: number
}
export type VersionInfo = ReleaseNotes & { history?: ReleaseNotes[] }

export interface InitState {
  showModal: boolean
  versionInfo: {
    version: string
    versionCode: number | null
    channel: UpdateChannel
    initialized: boolean
    newVersion: UpdateManifest | null
    showModal: boolean
    isUnknown: boolean
    isLatest: boolean
    reCheck: boolean
    status: LX.UpdateStatus
    integrityError: boolean
    installError: boolean
  }
  ignoreVersion: string | null
  progress: ProgressInfo
}

const state: InitState = {
  showModal: false,
  versionInfo: {
    version,
    versionCode: null,
    channel: version.includes('-next.') ? 'next' : 'stable',
    initialized: false,
    newVersion: null,
    showModal: false,
    reCheck: false,
    isUnknown: false,
    isLatest: false,
    status: 'idle',
    integrityError: false,
    installError: false,
  },
  ignoreVersion: null,
  progress: { total: 0, current: 0 },
}

export default state
