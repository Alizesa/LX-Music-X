export type UpdateChannel = 'stable' | 'next'
export interface ReleaseAsset {
  abi: string
  fileName: string
  url: string
  size: number
  sha256: string
}
export interface ReleaseNotes {
  version: string
  desc: string
}
export interface UpdateManifest extends ReleaseNotes {
  schemaVersion: 1
  channel: UpdateChannel
  versionCode: number
  tag: string
  sourceSha: string
  signingCertificateSha256?: string
  publishedAt: string
  releaseUrl: string
  assets: ReleaseAsset[]
  history: ReleaseNotes[]
}
export interface UpdatePreferences {
  channel: UpdateChannel
  ignored: Partial<Record<UpdateChannel, string>>
}
export const MAX_VERSION_CODE: number
export const ABIS: string[]
export function parseVersion(version: string): { core: string[], prerelease: string[] }
export function compareVersions(a: string, b: string): -1 | 0 | 1
export function nextPatch(version: string): string
export function isChannel(channel: unknown): channel is UpdateChannel
export function validateManifest(info: unknown, channel: UpdateChannel, repository: string, packageName: string): UpdateManifest
export function canUpgrade(currentVersion: string, currentCode: number, candidate: UpdateManifest): boolean
export function selectUpdate(manifests: UpdateManifest[], channel: UpdateChannel, currentVersion: string, currentCode: number): UpdateManifest | null
export function selectAsset(assets: ReleaseAsset[], supportedAbis: string[]): ReleaseAsset
