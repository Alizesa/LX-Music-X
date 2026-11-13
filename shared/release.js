// Shared by the Android updater and the dependency-free CI release scripts.
const MAX_VERSION_CODE = 2100000000
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal']
const numeric = /^\d+$/

function parseVersion(version) {
  if (typeof version !== 'string' || version.length > 128) throw new Error('Invalid version')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(version)
  if (!match) throw new Error(`Invalid version: ${version}`)
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(part => numeric.test(part) && part.length > 1 && part[0] === '0')) throw new Error('Invalid numeric prerelease')
  return { core: match.slice(1, 4), prerelease }
}

function compareNumber(a, b) {
  return a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length < b.length ? -1 : 1
}

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const order = compareNumber(left.core[i], right.core[i])
    if (order) return order
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1
    if (l === r) continue
    if (numeric.test(l) && numeric.test(r)) return compareNumber(l, r)
    if (numeric.test(l) !== numeric.test(r)) return numeric.test(l) ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

function nextPatch(version) {
  const { core } = parseVersion(version)
  const patch = Number(core[2]) + 1
  if (!Number.isSafeInteger(patch)) throw new Error('Patch number exhausted')
  return `${core[0]}.${core[1]}.${patch}`
}

function isChannel(channel) {
  return channel === 'stable' || channel === 'next'
}

function validateManifest(info, channel, repository, packageName) {
  if (!info || typeof info !== 'object' || info.schemaVersion !== 1 || !isChannel(channel) || info.channel !== channel) throw new Error('Invalid update channel')
  const parsed = parseVersion(info.version)
  if (channel === 'stable' ? parsed.prerelease.length > 0 : !/^next\.[1-9]\d*$/.test(parsed.prerelease.join('.'))) throw new Error('Version does not match channel')
  if (!Number.isSafeInteger(info.versionCode) || info.versionCode < 1 || info.versionCode > MAX_VERSION_CODE) throw new Error('Invalid Android version code')
  if (info.tag !== `v${info.version}` || !/^[a-f0-9]{40}$/.test(info.sourceSha)) throw new Error('Invalid release identity')
  if (info.signingCertificateSha256 !== undefined && (typeof info.signingCertificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.signingCertificateSha256))) throw new Error('Invalid signing certificate fingerprint')
  const releaseRoot = `https://github.com/${repository}/releases`
  if (info.releaseUrl !== `${releaseRoot}/tag/${encodeURIComponent(info.tag)}`) throw new Error('Unexpected release repository')
  if (typeof info.publishedAt !== 'string' || !Number.isFinite(Date.parse(info.publishedAt)) || typeof info.desc !== 'string') throw new Error('Invalid release details')
  if (!Array.isArray(info.assets) || !info.assets.length || info.assets.length > ABIS.length) throw new Error('Invalid APK assets')
  const found = new Set()
  for (const asset of info.assets) {
    if (!asset || !ABIS.includes(asset.abi) || found.has(asset.abi)) throw new Error('Invalid or duplicate APK ABI')
    found.add(asset.abi)
    const fileName = `${packageName}-v${info.version}-${asset.abi}.apk`
    if (asset.fileName !== fileName || asset.url !== `${releaseRoot}/download/${encodeURIComponent(info.tag)}/${encodeURIComponent(fileName)}`) throw new Error('Unexpected APK download URL')
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid APK checksum or size')
  }
  if (!Array.isArray(info.history) || info.history.length > 20) throw new Error('Invalid release history')
  for (const entry of info.history) {
    if (!entry || typeof entry.desc !== 'string' || compareVersions(entry.version, info.version) >= 0) throw new Error('Invalid history entry')
    const pre = parseVersion(entry.version).prerelease
    if (channel === 'stable' ? pre.length > 0 : !/^next\.[1-9]\d*$/.test(pre.join('.'))) throw new Error('History channel mismatch')
  }
  return info
}

function canUpgrade(currentVersion, currentCode, candidate) {
  return Number.isSafeInteger(currentCode) && currentCode > 0 && candidate.versionCode > currentCode && compareVersions(candidate.version, currentVersion) > 0
}

function selectUpdate(manifests, channel, currentVersion, currentCode) {
  return manifests.filter(info => (channel === 'next' || info.channel === 'stable') && canUpgrade(currentVersion, currentCode, info))
    .sort((a, b) => compareVersions(b.version, a.version) || b.versionCode - a.versionCode)[0] ?? null
}

function selectAsset(assets, supportedAbis) {
  for (const abi of supportedAbis) {
    const asset = assets.find(item => item.abi === abi)
    if (asset) return asset
  }
  const universal = assets.find(item => item.abi === 'universal')
  if (!universal) throw new Error('No compatible APK')
  return universal
}

module.exports = { MAX_VERSION_CODE, ABIS, parseVersion, compareVersions, nextPatch, isChannel, validateManifest, canUpgrade, selectUpdate, selectAsset }
