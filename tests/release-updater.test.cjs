const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  MAX_VERSION_CODE, parseVersion, compareVersions, nextPatch,
  validateManifest, canUpgrade, selectUpdate, selectAsset,
} = require('../shared/release')
const { manifest, repository, packageName } = require('./helpers/release.cjs')

test('SemVer sorts multi-digit previews and releases without losing integer precision', () => {
  const versions = [
    '1.9.2', '1.9.3-next.2', '1.9.3-next.10', '1.9.3', '1.9.4-next.11',
    '1.10.0', '2.0.0', '9007199254740992.0.0', '9007199254740993.0.0',
  ]
  for (let i = 0; i < versions.length; i++) {
    for (let j = 0; j < versions.length; j++) {
      assert.equal(compareVersions(versions[i], versions[j]), Math.sign(i - j))
    }
  }
  assert.equal(compareVersions('1.9.3+build.1', '1.9.3+build.2'), 0)
  assert.equal(compareVersions('1.9.3-next', '1.9.3-next.1'), -1)
  assert.equal(compareVersions('1.9.3-1', '1.9.3-alpha'), -1)
  assert.equal(nextPatch('1.9.9'), '1.9.10')
})

test('malformed versions and ambiguous numeric identifiers are rejected', () => {
  for (const version of ['', 'v1.9.3', '1.9', '01.9.3', '1.9.03', '1.9.3-next.01', '1.9.3-next..2', '1.9.3\n', null, 193]) {
    assert.throws(() => parseVersion(version), undefined, String(version))
  }
  assert.throws(() => nextPatch('1.9.9007199254740993'))
})

test('stable subscription excludes previews and next promotes the same target stable release', () => {
  const stable = manifest('1.9.3', 100003)
  const preview = manifest('1.9.3-next.2', 100002)
  assert.equal(selectUpdate([preview], 'stable', '1.9.2', 79003), null)
  assert.equal(selectUpdate([preview, stable], 'next', '1.9.2', 79003), stable)
  assert.equal(selectUpdate([stable], 'next', preview.version, preview.versionCode), stable)
  const futurePreview = manifest('1.9.4-next.4', 100004)
  assert.equal(selectUpdate([futurePreview, stable], 'next', stable.version, stable.versionCode), futurePreview)
})

test('upgrades require both SemVer and the actual installed APK version code to increase', () => {
  const candidate = manifest('1.9.3', 100003)
  assert.equal(canUpgrade('1.9.2', 79004, candidate), true)
  assert.equal(canUpgrade('1.9.3-next.4', 100004, candidate), false)
  assert.equal(canUpgrade('1.9.4-next.4', 100002, candidate), false)
  assert.equal(canUpgrade('1.9.3', 79004, candidate), false)
  for (const code of [null, 0, -1, NaN, '79', 79.5]) assert.equal(canUpgrade('1.9.2', code, candidate), false)
  assert.equal(selectUpdate([candidate], 'stable', '1.9.4-next.4', 100004), null)
})

test('the manifest pins APK downloads to this repository and its immutable tag', () => {
  const good = manifest()
  assert.equal(validateManifest(good, 'stable', repository, packageName), good)
  assert.equal(validateManifest(manifest('1.9.3-next.10'), 'next', repository, packageName).version, '1.9.3-next.10')
  const invalid = [
    info => { info.schemaVersion = 2 },
    info => { info.channel = 'next' },
    info => { info.versionCode = MAX_VERSION_CODE + 1 },
    info => { info.versionCode = '100003' },
    info => { info.sourceSha = 'main' },
    info => { info.signingCertificateSha256 = ['a'.repeat(64)] },
    info => { info.signingCertificateSha256 = 'not-a-certificate' },
    info => { info.tag = 'latest' },
    info => { info.releaseUrl = 'https://github.com/lyswhut/lx-music-mobile/releases/tag/v1.9.3' },
    info => { info.assets[0].url = info.assets[0].url.replace(repository, 'lyswhut/lx-music-mobile') },
    info => { info.assets[0].url = info.assets[0].url.replace('/v1.9.3/', '/latest/') },
    info => { info.assets[0].url = 'http://example.com/update.apk' },
    info => { info.assets[0].fileName = '../update.apk' },
    info => { info.assets[0].size = 0 },
    info => { info.assets[0].sha256 = 'b'.repeat(63) },
    info => { info.assets.push(info.assets[0]) },
    info => { info.assets[1] = { ...info.assets[0] } },
    info => { info.assets = [] },
    info => { info.publishedAt = 'invalid' },
    info => { info.history = [{ version: '1.9.3-next.2', desc: 'Preview' }] },
    info => { info.history = [{ version: '1.9.4', desc: 'Future' }] },
  ]
  for (const mutate of invalid) {
    const info = structuredClone(good)
    mutate(info)
    assert.throws(() => validateManifest(info, 'stable', repository, packageName))
  }
})

test('APK selection follows device ABI preference, with universal fallback and no incompatible download', () => {
  const assets = manifest().assets
  assert.equal(selectAsset(assets, ['x86_64', 'x86']).abi, 'x86_64')
  assert.equal(selectAsset(assets, ['armeabi-v7a', 'arm64-v8a']).abi, 'armeabi-v7a')
  assert.equal(selectAsset(assets.filter(asset => asset.abi !== 'arm64-v8a'), ['arm64-v8a']).abi, 'universal')
  assert.equal(selectAsset(assets, ['unknown']).abi, 'universal')
  assert.throws(() => selectAsset(assets.filter(asset => asset.abi !== 'universal'), ['unknown']))
})
