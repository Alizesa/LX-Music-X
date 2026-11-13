import { type UpdateChannel, type UpdateManifest } from '../../shared/release'

export const UPDATE_REPOSITORY: string
export function getVersionInfo(channel?: UpdateChannel, force?: boolean): Promise<{ manifests: UpdateManifest[], incomplete: boolean, errors: string[] }>
export function cancelUpdateDownload(): void
export function cleanupUpdateDownloads(installedVersion?: string): Promise<void>
export function hasDownloadedUpdate(tag: string): boolean
export function downloadNewVersion(info: UpdateManifest, onDownload?: (total: number, current: number) => void): Promise<void>
export function updateApp(): Promise<void>
