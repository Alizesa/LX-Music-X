const test = require('node:test')
const assert = require('node:assert/strict')
const { load, flush } = require('./helpers/load.cjs')
const { jsx, hookHost, elements } = require('./helpers/react.cjs')
const { githubFixture, releaseManifest, loadRelease, fingerprint, fixtureConfig } = require('./helpers/github.cjs')
const { createUpdateApp } = require('./helpers/update-flow.cjs')
const { repository, packageName } = require('./helpers/release.cjs')
const messages = require('../src/lang/zh-cn.json')

const sha = value => value.repeat(40)
const sourcePackage = { name: packageName, version: '1.9.2', versionCode: 79 }

const publishSnapshot = async(server, { branch = 'master', source = 'a', before = '0', version = '1.9.3', code = 100001 } = {}, inspectOverride) => {
  const info = releaseManifest({ version, versionCode: code, sourceSha: sha(source) })
  const pipeline = loadRelease(info)
  pipeline.files.set('package.json', Buffer.from(JSON.stringify(sourcePackage)))
  pipeline.files.set('package-lock.json', Buffer.from(JSON.stringify({ version: '1.9.2', packages: { '': { version: '1.9.2' }, 'node_modules/example': { version: '3.0.0' } } })))
  pipeline.files.delete('update.json')
  pipeline.files.delete('SHA256SUMS.txt')
  pipeline.files.set('event.json', Buffer.from(JSON.stringify({ ref: `refs/heads/${branch}`, before: sha(before), after: sha(source) })))
  const github = server.client()
  const request = github.request
  github.request = async(method, route, options) => route.startsWith('/actions/workflows/')
    ? { workflow_runs: [{ event: 'push', head_branch: branch, head_sha: sha(source), run_number: 1 }] }
    : request(method, route, options)
  const record = await pipeline.reserve(github, { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/fixture/event.json' }, () => false)
  assert.equal(record.version, version)
  assert.equal(record.versionCode, code)
  pipeline.inject(record)
  const pkg = JSON.parse(pipeline.files.get('package.json'))
  const lock = JSON.parse(pipeline.files.get('package-lock.json'))
  assert.equal(pkg.version, version)
  assert.equal(pkg.versionCode, code)
  assert.equal(pkg.releaseSourceSha, record.sourceSha)
  assert.equal(lock.packages[''].version, version)
  assert.equal(lock.packages['node_modules/example'].version, '3.0.0')
  // The APK build/Android tools are deliberately replaced by metadata fixtures.
  // Actual injection, file hashes, manifest generation and publication still run.
  await pipeline.prepare(server.client(), record, file => ({
    version: pkg.version, versionCode: pkg.versionCode, applicationId: fixtureConfig.applicationId, certificateSha256: fingerprint,
    ...inspectOverride?.(file),
  }))
  const prepared = JSON.parse(pipeline.files.get('update.json'))
  assert.equal(prepared.sourceSha, record.sourceSha)
  assert.equal(prepared.signingCertificateSha256, fingerprint)
  await pipeline.publish(server.client(), record, () => false)
  assert.equal(server.channel(record.channel).tag, record.tag)
  assert.ok(server.releases.every(release => !release.draft))
  return { record, prepared, pkg }
}

test('fresh metadata -> reservation -> injection -> publication -> automatic check -> verified install', async() => {
  const server = githubFixture(null)
  const release = await publishSnapshot(server)
  const app = createUpdateApp({ server })
  const home = await app.boot()
  assert.equal(app.settingState.setting['version.autoCheckUpdate'], true)
  assert.equal(app.disk.get('setting')['version.autoCheckUpdate'], true)
  assert.equal(app.requests.length, 1)
  assert.equal(app.versionState.versionInfo.versionCode, 79003)
  assert.equal(app.versionState.versionInfo.newVersion.tag, release.record.tag)
  assert.deepEqual(app.modals, [release.record.tag])
  await home()
  await flush()
  assert.equal(app.requests.length, 1, 'Returning to Home must not issue another startup check')
  await app.core.downloadUpdate()
  assert.equal(app.downloads.length, 1)
  assert.equal(app.downloads[0].url, release.prepared.assets.find(asset => asset.abi === 'arm64-v8a').url)
  assert.equal(app.hashes.length, 1)
  assert.equal(app.installations.length, 1)
  assert.deepEqual(app.installations[0].bytes, server.assetBytes(release.record.tag, release.prepared.assets.find(asset => asset.abi === 'arm64-v8a').fileName))
  assert.equal(app.versionState.versionInfo.status, 'downloaded')
  const restarted = createUpdateApp({ server, disk: app.disk, installed: { version: release.pkg.version, versionCode: release.pkg.versionCode } })
  await restarted.boot()
  assert.equal(restarted.versionState.versionInfo.version, release.pkg.version)
  assert.equal(restarted.versionState.versionInfo.isLatest, true)
  assert.equal(restarted.modals.length, 0)
})

test('a preview install receives the later stable APK and keeps its preview subscription after restart', async() => {
  const server = githubFixture(null)
  const preview = await publishSnapshot(server, { branch: 'Next', version: '1.9.3-next.1' })
  const app = createUpdateApp({ server, installed: { version: '1.9.2-next.7', versionCode: 79003 } })
  await app.boot()
  assert.equal(app.versionState.versionInfo.channel, 'next')
  assert.equal(app.versionState.versionInfo.newVersion.tag, preview.record.tag)
  await app.core.downloadUpdate()
  const stable = await publishSnapshot(server, { branch: 'master', source: 'b', code: 100002 })
  const previewInstalled = createUpdateApp({ server, disk: app.disk, installed: { version: preview.pkg.version, versionCode: preview.pkg.versionCode } })
  await previewInstalled.boot()
  assert.equal(previewInstalled.versionState.versionInfo.newVersion.tag, stable.record.tag)
  await previewInstalled.core.downloadUpdate()
  const stableInstalled = createUpdateApp({ server, disk: app.disk, installed: { version: stable.pkg.version, versionCode: stable.pkg.versionCode } })
  await stableInstalled.boot()
  assert.equal(stableInstalled.versionState.versionInfo.channel, 'next')
  assert.equal(stableInstalled.versionState.versionInfo.isLatest, true)
  assert.equal(stableInstalled.disk.get('updatePreferences').channel, 'next')
  assert.equal(server.channel('next'), null)
})

for (const invalid of [null, 0, 'false', { enabled: false }]) {
  test(`invalid saved automatic-update value ${JSON.stringify(invalid)} falls back to enabled at startup`, async() => {
    const server = githubFixture(null)
    await publishSnapshot(server)
    const app = createUpdateApp({ server, settings: { 'common.isAgreePact': true, 'version.autoCheckUpdate': invalid } })
    await app.boot()
    assert.equal(app.settingState.setting['version.autoCheckUpdate'], true)
    assert.equal(app.disk.get('setting')['version.autoCheckUpdate'], true)
    assert.equal(app.requests.length, 1)
  })
}

test('turning automatic checking off in the real settings component persists across startup while manual checking works', async() => {
  const server = githubFixture(null)
  await publishSnapshot(server)
  const app = createUpdateApp({ server })
  await app.boot()
  const host = hookHost()
  const frame = host.frame()
  const Version = load('src/screens/Home/Views/Setting/settings/Version.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View', StyleSheet: { create: value => value } },
    '../components/Section': { default: 'Section' }, '../components/SubTitle': { default: 'SubTitle' }, '../components/Button': { default: 'Button' },
    '../components/CheckBoxItem': { default: 'CheckBox' }, '@/components/common/Text': { default: 'Text' },
    '@/utils': { sizeFormate: String }, '@/lang': { useI18n: () => key => messages[key] },
    '@/store/version/hook': { useVersionInfo: () => app.versionState.versionInfo, useVersionDownloadProgressUpdated: () => app.versionState.progress },
    '@/store/setting/hook': { useSettingValue: key => app.settingState.setting[key] }, '@/core/common': { updateSetting: app.changeSetting }, '@/core/version': app.core,
  }).default
  let tree = host.render(frame, Version)
  assert.equal(elements(tree, 'CheckBox')[0].props.check, true)
  elements(tree, 'CheckBox')[0].props.onChange(false)
  tree = host.render(frame, Version)
  assert.equal(elements(tree, 'CheckBox')[0].props.check, false)
  const restarted = createUpdateApp({ server, disk: app.disk })
  await restarted.boot()
  assert.equal(restarted.settingState.setting['version.autoCheckUpdate'], false)
  assert.equal(restarted.requests.length, 0)
  await restarted.core.checkUpdate(true, false)
  assert.equal(restarted.versionState.versionInfo.newVersion.version, '1.9.3')
  assert.equal(restarted.requests.length, 1)
  host.unmount(frame)
})

test('first-launch agreement acceptance triggers the enabled startup check once', async() => {
  const server = githubFixture(null)
  await publishSnapshot(server)
  const app = createUpdateApp({ server, settings: null })
  await app.boot()
  assert.equal(app.settingState.setting['version.autoCheckUpdate'], true)
  assert.equal(app.requests.length, 0)
  assert.equal(app.pacts.length, 1)
  const host = hookHost()
  const frame = host.frame()
  let now = 0, sequence = 0
  const timers = new Map(), alerts = []
  const setTimer = (callback, ms) => { const id = ++sequence; timers.set(id, { callback, at: now + ms }); return id }
  const advance = ms => {
    const target = now + ms
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = target
  }
  const Pact = load('src/navigation/components/PactModal.tsx', {
    react: host.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', ScrollView: 'ScrollView', Alert: { alert: (...args) => alerts.push(args) } },
    'react-native-navigation': { Navigation: { dismissOverlay: async() => {} } },
    '@/components/common/Button': { default: 'Button' }, '@/components/common/Text': { default: 'Text' }, './ModalContent': { default: 'Modal' },
    '@/utils/tools': { createStyle: value => value, openUrl: async() => {} }, '@/utils/nativeModules/utils': { exitApp() {} },
    '@/store/setting/hook': { useSettingValue: key => app.settingState.setting[key] }, '@/store/theme/hook': { useTheme: () => ({}) },
    '@/core/common': { updateSetting: app.changeSetting }, '@/core/version': app.core, '@/core/init/deeplink': { initDeeplink: async() => {} },
    '@/store/setting/state': { default: app.settingState },
  }, { setTimeout: setTimer, clearTimeout: id => timers.delete(id) }).default
  const footer = Pact({ componentId: 'pact' }).props.children.find(child => child.props?.componentId === 'pact')
  let tree = host.render(frame, () => footer.type(footer.props))
  assert.equal(elements(tree, 'Button').at(-1).props.disabled, true)
  advance(20000)
  tree = host.render(frame, () => footer.type(footer.props))
  assert.equal(elements(tree, 'Button').at(-1).props.disabled, false)
  elements(tree, 'Button').at(-1).props.onPress()
  advance(2000)
  alerts[0][2][0].onPress()
  await flush()
  assert.equal(app.settingState.setting['common.isAgreePact'], true)
  assert.equal(app.requests.length, 1)
  assert.deepEqual(app.modals, ['v1.9.3'])
  await app.boot()
  assert.equal(app.requests.length, 1)
  host.unmount(frame)
})

test('mismatched Android metadata stops preparation before any release can be published', async() => {
  const server = githubFixture(null)
  await assert.rejects(publishSnapshot(server, {}, file => file.endsWith('-arm64-v8a.apk') ? { versionCode: 79 } : {}), /Incorrect Android package metadata/)
  assert.equal(server.releases.length, 0)
  assert.deepEqual(server.state.channels, {})
})

test('About downloads, source code and issue feedback lead to this repository, with a separate upstream attribution', async() => {
  const urls = []
  const About = load('src/screens/Home/Views/Setting/settings/About.tsx', {
    react: { memo: value => value }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { View: 'View', TouchableOpacity: 'Link' },
    '../components/Section': { default: 'Section' }, '@/utils/tools': { createStyle: value => value, openUrl: async url => urls.push(url) },
    '@/store/theme/hook': { useTheme: () => ({}) }, '@/lang': { useI18n: () => key => messages[key] },
    '@/components/common/Text': { default: 'Text' }, '@/core/common': { showPactModal() {} },
  }).default
  const tree = About()
  const links = elements(tree, 'Link')
  for (const link of links) link.props.onPress()
  assert.ok(urls.includes(`https://github.com/${repository}/releases`))
  assert.ok(urls.includes(`https://github.com/${repository}/issues`))
  assert.ok(urls.includes(`https://github.com/${repository}`))
  assert.ok(urls.includes('https://github.com/lyswhut/lx-music-mobile#readme'))
  assert.equal(urls.some(url => url.includes('lyswhut/lx-music-mobile/releases') || url.includes('lyswhut/lx-music-mobile/issues')), false)
})
