const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createApkInspector, getBuildToolsVersion } = require('../publish/android-tools.cjs')
const { seedState } = require('../publish/release.cjs')
const { fixtureConfig } = require('./helpers/github.cjs')
const { githubFixture, releaseManifest } = require('./helpers/github.cjs')
const source = require('./fixtures/apksigner/source.json')

const recordedOutput = fs.readFileSync(path.join(__dirname, 'fixtures/apksigner/build-tools-37.txt'), 'utf8')
const badging = (applicationId = source.applicationId) => `package: name='${applicationId}' versionCode='79003' versionName='1.9.2' platformBuildVersionName='16'\nsdkVersion:'23'\n`
const inspector = (overrides = {}) => {
  const calls = []
  const read = createApkInspector({
    root: path.resolve('/source'), env: { ANDROID_HOME: path.resolve('/sdk'), JAVA_HOME: path.resolve('/jdk') },
    platform: 'linux', readFile: () => 'buildToolsVersion = "35.0.0"\n', exists: () => true,
    execute: (command, args, options) => { calls.push({ command, args, options }); return args[0] === 'dump' ? badging() : recordedOutput },
    ...overrides,
  })
  return { read, calls }
}

test('APK inspection selects the Gradle-declared tools and JAVA_HOME before parsing real output', () => {
  const app = inspector()
  assert.deepEqual(app.read('/cache/release.apk'), { applicationId: source.applicationId, versionCode: 79003, version: '1.9.2', certificateSha256: source.certificateSha256 })
  assert.equal(app.calls[0].command, path.join(path.resolve('/sdk'), 'build-tools/35.0.0/aapt'))
  assert.equal(app.calls[1].command, path.join(path.resolve('/jdk'), 'bin/java'))
  assert.deepEqual(app.calls[1].args, ['-jar', path.join(path.resolve('/sdk'), 'build-tools/35.0.0/lib/apksigner.jar'), 'verify', '--print-certs', '/cache/release.apk'])
  assert.ok(app.calls.every(call => call.options.timeout === 60000))
})

test('missing declared SDK tools fail explicitly instead of selecting another installed release', () => {
  const app = inspector({ exists: file => file.includes('37.0.0') })
  assert.throws(() => app.read('/cache/release.apk'), /Build Tools 35\.0\.0.*install build-tools;35\.0\.0/)
  assert.equal(app.calls.length, 0)
})

test('APK inspection never trusts certificate text from a failed verification process', () => {
  const app = inspector({ execute: (command, args) => {
    if (args[0] === 'dump') return badging()
    throw Object.assign(new Error('Verification failed'), { status: 1, stdout: recordedOutput, stderr: 'DOES NOT VERIFY' })
  } })
  assert.throws(() => app.read('/cache/broken.apk'), /broken\.apk.*Android Build Tools 35\.0\.0[\s\S]*DOES NOT VERIFY/)
})

test('foreign application APKs are identified without treating their signatures as this fork signer', () => {
  const calls = []
  const app = inspector({ execute: (command, args) => { calls.push(args); assert.equal(args[0], 'dump'); return badging('cn.toside.music.mobile') } })
  const metadata = app.read('/cache/upstream.apk', { signingApplicationId: fixtureConfig.applicationId })
  assert.equal(metadata.applicationId, 'cn.toside.music.mobile')
  assert.equal(metadata.certificateSha256, undefined)
  assert.equal(calls.length, 1)
})

test('Windows inspection calls aapt.exe and the Java JAR directly without a batch shell', () => {
  const app = inspector({ platform: 'win32' })
  app.read('/cache/release.apk')
  assert.equal(path.basename(app.calls[0].command), 'aapt.exe')
  assert.equal(path.basename(app.calls[1].command), 'java.exe')
  assert.equal(app.calls.some(call => call.options.shell || /cmd\.exe/.test(call.command)), false)
})

test('SDK declarations must be explicit and unambiguous', () => {
  assert.equal(getBuildToolsVersion('/root', () => "  buildToolsVersion = '35.0.0' // Android SDK\r\n"), '35.0.0')
  for (const input of ['', 'buildToolsVersion = sdkVersion', 'buildToolsVersion = "35.0.0" + suffix', 'buildToolsVersion = "35.0.0"\nbuildToolsVersion = "37.0.0"']) {
    assert.throws(() => getBuildToolsVersion('/root', () => input), /one explicit/)
  }
})

test('historical APK errors identify the release and asset before failing initialization', async() => {
  const github = {
    list: async() => [{ tag_name: 'legacy-next', draft: false, assets: [{ id: 17, name: 'legacy-arm64.apk' }] }],
    request: async() => [], downloadAsset: async(asset, target) => fs.writeFileSync(target, 'inspection fixture'),
  }
  await assert.rejects(seedState(github, fixtureConfig, { version: '1.9.2', name: 'lx-music-mobile' }, () => { throw new Error('unsupported signer output') }), /legacy-next\/legacy-arm64\.apk \(asset 17\): unsupported signer output/)
})

test('unrelated application version codes cannot raise or exhaust this application baseline', async() => {
  const github = {
    list: async() => [{ tag_name: 'legacy', draft: false, assets: [{ id: 18, name: 'other-app.apk' }] }],
    request: async() => [], downloadAsset: async(asset, target) => fs.writeFileSync(target, 'inspection fixture'),
  }
  const state = await seedState(github, fixtureConfig, { version: '1.9.2', name: 'lx-music-mobile' }, (file, options) => {
    assert.equal(options.signingApplicationId, fixtureConfig.applicationId)
    return { applicationId: 'other.application', versionCode: 2147483647, version: '1.0.0' }
  })
  assert.equal(state.versionCodeBase, fixtureConfig.versionCodeBase)
  assert.equal(state.signingCertificateSha256, null)
})

test('a foreign historical manifest cannot populate this application update channels', async() => {
  const { createState } = require('../publish/release-state.cjs')
  const app = githubFixture(createState('1.9.2', 100000))
  app.addRelease(releaseManifest({ version: '1.9.3', versionCode: 100001, sourceSha: 'a'.repeat(40) }))
  const state = await seedState(app.github, fixtureConfig, { version: '1.9.2', name: 'lx-music-mobile' }, () => ({ applicationId: 'other.application', versionCode: 2147483647, version: '1.9.3' }))
  assert.deepEqual(state.channels, {})
  assert.deepEqual(state.builds, {})
  assert.equal(state.versionCodeBase, fixtureConfig.versionCodeBase)
  assert.equal(state.lastStableVersion, '1.9.3', 'Existing tag names still reserve their namespace')
})

test('the release workflow prepares Java and declared SDK tools before reserving versions', () => {
  const yaml = require('js-yaml')
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'))
  const steps = workflow.jobs.release.steps
  const reserve = steps.findIndex(step => step.run === 'node publish/release.cjs reserve')
  const java = steps.findIndex(step => step.uses === 'actions/setup-java@v4' && step.with['java-version'] === '17')
  const selected = steps.findIndex(step => step.run === 'node publish/android-tools.cjs')
  const installed = steps.findIndex(step => step.run?.includes('sdkmanager'))
  assert.ok(java >= 0 && java < reserve)
  assert.ok(selected > java && selected < reserve)
  assert.ok(installed > selected && installed < reserve)
})
