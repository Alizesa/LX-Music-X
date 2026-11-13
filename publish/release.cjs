const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { GitHub, PUBLICATION_LEASE_MS } = require('./github.cjs')
const { createState, branchChannel, buildKey, registerPush, publishManifest, restoreBranchHeads } = require('./release-state.cjs')
const { createSourceHistory } = require('./source-history.cjs')
const { historicalSigningCertificate, pinSigningCertificate } = require('./signing.cjs')
const { createApkInspector } = require('./android-tools.cjs')
const { ABIS, compareVersions, parseVersion, validateManifest } = require('../shared/release')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, '.release')
const CONFIG = require('./release-config.json')
const ZERO = '0'.repeat(40)
const sourceContains = createSourceHistory(ROOT)
const inspectApk = createApkInspector({ root: ROOT })

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() }
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function tagVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null
  try { parseVersion(tag.slice(1)); return tag.slice(1) } catch { return null }
}

// Initialization runs only in CI. Historical split APKs had ABI-adjusted codes,
// so inspect their manifests rather than trusting the old JS versionCode.
async function seedState(github, config = CONFIG, pkg = readJson(path.join(ROOT, 'package.json')), inspect = inspectApk, isAncestor = sourceContains) {
  const [releases, tags] = await Promise.all([github.list('/releases'), github.request('GET', '/git/matching-refs/tags/v')])
  let stable = pkg.version.split('-')[0]
  let target = stable
  let sequence = 0
  let codeBase = config.versionCodeBase
  for (const tag of [...tags.map(item => item.ref.replace('refs/tags/', '')), ...releases.map(item => item.tag_name)]) {
    const version = tagVersion(tag)
    if (!version) continue
    const parsed = parseVersion(version)
    if (!parsed.prerelease.length && compareVersions(version, stable) > 0) stable = version
    if (compareVersions(parsed.core.join('.'), target) > 0) target = parsed.core.join('.')
    if (/^next\.[1-9]\d*$/.test(parsed.prerelease.join('.'))) sequence = Math.max(sequence, Number(parsed.prerelease[1]))
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-release-history-'))
  const history = []
  const channels = {}
  const builds = {}
  const certificates = []
  const previews = []
  try {
    for (const release of releases.filter(item => !item.draft)) {
      const version = tagVersion(release.tag_name)
      const apkMetadata = new Map()
      // Even releases with legacy non-SemVer tags can contain a higher APK code.
      for (const asset of release.assets.filter(item => item.name.endsWith('.apk'))) {
        const file = path.join(temporary, `${asset.id}.apk`)
        console.log(`Inspecting historical APK ${release.tag_name}/${asset.name}`)
        try {
          await github.downloadAsset(asset, file)
          const metadata = inspect(file, { signingApplicationId: config.applicationId })
          apkMetadata.set(asset.name, metadata)
          if (metadata.applicationId === config.applicationId) {
            codeBase = Math.max(codeBase, metadata.versionCode)
            certificates.push(metadata.certificateSha256)
          }
          fs.unlinkSync(file)
        } catch (error) {
          throw new Error(`Historical APK ${release.tag_name}/${asset.name} (asset ${asset.id}): ${error.message}`, { cause: error })
        }
      }
      if (!version || ![...apkMetadata.values()].some(metadata => metadata.applicationId === config.applicationId)) continue
      const prerelease = parseVersion(version).prerelease
      const channel = prerelease.length ? 'next' : 'stable'
      if (channel === 'next' && !/^next\.[1-9]\d*$/.test(prerelease.join('.'))) continue
      if (release.prerelease !== (channel === 'next')) continue
      const asset = release.assets.find(item => item.name === 'update.json')
      let manifest
      if (asset) {
        manifest = validateManifest(await github.assetJson(asset), channel, config.repository, pkg.name)
        if (manifest.tag !== release.tag_name) throw new Error('Historical update.json does not match its release')
        requireCompleteRelease(release, manifest, config)
        for (const asset of manifest.assets) {
          if (apkMetadata.get(asset.fileName)?.applicationId !== config.applicationId) throw new Error(`Historical manifest references a different application: ${release.tag_name}/${asset.fileName}`)
        }
        const branch = channel === 'stable' ? 'master' : 'Next'
        const key = buildKey(branch, manifest.sourceSha)
        if (!builds[key] || compareVersions(manifest.version, builds[key].version) > 0) {
          builds[key] = { branch, sourceSha: manifest.sourceSha, before: ZERO, channel, version: manifest.version, versionCode: manifest.versionCode, tag: manifest.tag, status: 'published', notes: { version: manifest.version, desc: manifest.desc }, publishedAt: manifest.publishedAt }
        }
        const previous = channels[channel]
        if (!previous || compareVersions(manifest.version, previous.version) > 0) channels[channel] = manifest
        if (channel === 'next') previews.push(manifest)
      }
      let sourceSha = manifest?.sourceSha
      if (!sourceSha) {
        const ref = await github.request('GET', `/git/ref/tags/${encodeURIComponent(release.tag_name)}`, { allow404: true })
        let object = ref?.object
        while (object?.type === 'tag') object = (await github.request('GET', `/git/tags/${object.sha}`)).object
        if (object?.type === 'commit') sourceSha = object.sha
      }
      history.push({ channel, version, sourceSha, desc: manifest?.desc ?? release.body ?? '', publishedAt: release.published_at })
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  const state = createState(stable, codeBase)
  if (!Number.isSafeInteger(sequence)) throw new Error('Historical build sequence is too large')
  state.sequence = sequence
  if (compareVersions(target, state.nextTargetVersion) > 0) state.nextTargetVersion = target
  state.channels = channels
  state.builds = builds
  state.legacyHistory = history
  if (channels.stable && previews.length) {
    channels.next = null
    for (const preview of previews.sort((a, b) => compareVersions(b.version, a.version))) {
      if (compareVersions(preview.version, channels.stable.version) <= 0 || isAncestor(preview.sourceSha, channels.stable.sourceSha)) {
        builds[buildKey('Next', preview.sourceSha)].supersededBy = channels.stable.tag
      } else channels.next ??= preview
    }
  }
  state.signingCertificateSha256 = historicalSigningCertificate(certificates, config.signingCertificateSha256)
  state.signingHistoryChecked = true
  restoreBranchHeads(state)
  return state
}

async function pushContext(github, event, env = process.env) {
  let branch
  let sha
  let before
  if (env.GITHUB_EVENT_NAME === 'push') {
    if (event.deleted || event.after === ZERO) throw new Error('Deleted branches are not releases')
    branch = event.ref.replace('refs/heads/', '')
    sha = event.after
    before = event.before
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    branch = event.inputs?.source_branch
    sha = event.inputs?.source_sha
    before = event.inputs?.before_sha
  } else throw new Error('Release must be triggered by a branch push or manual rerun')
  branchChannel(branch)
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A complete source SHA is required')
  const snapshot = await github.readState()
  const reservation = snapshot.state?.builds[buildKey(branch, sha)]
  if (reservation) return { branch, sha, before: reservation.before, bootstrap: false, reservation }
  if (!/^[a-f0-9]{40}$/.test(before ?? '')) throw new Error('An unregistered push requires its original complete before SHA')
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  if (manual) {
    const [source, history] = await Promise.all([
      github.request('GET', `/compare/${sha}...${encodeURIComponent(branch)}`),
      before === ZERO ? null : github.request('GET', `/compare/${before}...${sha}`),
    ])
    if (!['ahead', 'identical'].includes(source.status)) throw new Error('Manual source SHA is not on the selected release branch')
    if (history && history.status !== 'ahead') throw new Error('Manual before SHA must precede the source SHA')
  }
  // A skipped push has no Actions run. Manual registration supplies its
  // original before/after edge; registerPush still enforces exact ordering.
  if (snapshot.state?.branches[branch]) return { branch, sha, before, bootstrap: false }
  const runs = await github.list(`/actions/workflows/release.yml/runs?branch=${encodeURIComponent(branch)}&event=push`)
  // GitHub's workflow-runs endpoint wraps its list, unlike other list routes.
  const matching = runs.filter(run => run.event === 'push' && run.head_branch === branch)
    .sort((a, b) => a.run_number - b.run_number)
  if (manual && matching.length === 0) return { branch, sha, before, bootstrap: true }
  const failedBeforeRegistration = run => /^[a-f0-9]{40}$/.test(run.head_sha ?? '') && run.head_sha !== sha && run.status === 'completed' &&
    ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(run.conclusion) &&
    !snapshot.state?.builds[buildKey(branch, run.head_sha)] && !snapshot.state?.events?.[buildKey(branch, run.head_sha)]
  // A failed initial history scan has no reservation/receipt to recover. It
  // must not force every subsequent fixed commit to wait forever for that run.
  // Active/successful runs and all recorded pushes still retain their order.
  const eligible = matching.filter(run => !failedBeforeRegistration(run))
  if (!matching.some(run => run.head_sha === sha) && !(manual && eligible.length === 0)) throw new Error('Initialize the release branch with its earliest push run before recovering a missing push')
  const first = eligible[0]
  const pending = first && snapshot.state?.events?.[buildKey(branch, first.head_sha)]
  const skipped = matching.filter(run => failedBeforeRegistration(run) && (!first || run.run_number < first.run_number)).map(run => run.head_sha)
  return {
    branch,
    sha,
    before,
    bootstrap: first?.head_sha === sha || Boolean(pending) || (manual && !first),
    ...(pending ? { bootstrapBefore: pending.before } : {}),
    ...(skipped.length ? { initializationSkippedSources: skipped } : {}),
  }
}

async function reserve(github, env = process.env, isAncestor = sourceContains) {
  const event = readJson(env.GITHUB_EVENT_PATH)
  const context = await pushContext(github, event, env)
  const correction = env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? event.inputs?.target_version?.trim() : undefined
  const targetVersion = correction ? correction === 'auto' ? null : correction : CONFIG.targetVersion
  if (git('rev-parse', 'HEAD') !== context.sha) throw new Error('Checkout does not match the triggering source SHA')
  const snapshot = await github.readState()
  const seed = snapshot.state ? undefined : await seedState(github)
  const deadline = Date.now() + 600000
  let nextBootstrapCheck = 0
  let record
  do {
    const transaction = await github.updateState(state => registerPush(state, { ...context, reservation: undefined, targetVersion }, { isAncestor, correctTarget: Boolean(correction) }), seed)
    record = transaction.result
    if (record) {
      const skipped = (context.initializationSkippedSources ?? []).filter(sha => transaction.state.initializationSkipped?.[context.branch]?.includes(sha))
      if (skipped.length) console.log(`Initialized after earlier pushes failed without reservations: ${skipped.join(', ')}`)
      break
    }
    if (!transaction.state.branches[context.branch] && Date.now() >= nextBootstrapCheck) {
      nextBootstrapCheck = Date.now() + 30000
      const refreshed = await pushContext(github, event, env)
      if (refreshed.bootstrap) {
        context.bootstrap = true
        context.bootstrapBefore = refreshed.bootstrapBefore
        context.initializationSkippedSources = refreshed.initializationSkippedSources
        continue
      }
    }
    console.log(`Waiting for the earlier ${context.branch} push ${context.before} to reserve its version`)
    await delay(10000)
  } while (Date.now() < deadline)
  if (!record) throw new Error(`Preceding push ${context.branch}/${context.before} has not registered; dispatch Android release for that source_sha with its original before_sha (no push run is required), then rerun this source commit`)
  writeJson(path.join(OUTPUT, 'record.json'), record)
  const release = await github.getRelease(record.tag)
  const reuse = release && !release.draft ? 'true' : 'false'
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `version=${record.version}\nversion_code=${record.versionCode}\nchannel=${record.channel}\ntag=${record.tag}\nreuse_public=${reuse}\n`)
  console.log(`Reserved ${record.tag}, Android versionCode ${record.versionCode}; reuse public release: ${reuse}`)
  return record
}

function inject(record, root = ROOT) {
  const file = path.join(root, 'package.json')
  const pkg = readJson(file)
  pkg.version = record.version
  pkg.versionCode = record.versionCode
  pkg.releaseChannel = record.channel
  pkg.releaseSourceSha = record.sourceSha
  writeJson(file, pkg)
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lockFile = path.join(root, name)
    if (!fs.existsSync(lockFile)) continue
    const lock = readJson(lockFile)
    lock.version = record.version
    if (lock.packages?.['']) lock.packages[''].version = record.version
    writeJson(lockFile, lock)
  }
}

function releaseHistory(state, record) {
  return [...(state.legacyHistory ?? []), ...Object.values(state.builds).filter(item => item.status === 'published' && item.notes).map(item => ({ ...item.notes, channel: item.channel, sourceSha: item.sourceSha, publishedAt: item.publishedAt }))]
    .filter(item => item.channel === record.channel && compareVersions(item.version, record.version) < 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .filter((item, index, entries) => entries.findIndex(entry => entry.version === item.version) === index)
}

function makeManifest(record, assets, state, description, config = CONFIG) {
  const history = releaseHistory(state, record).slice(0, 20).map(({ version, desc }) => ({ version, desc }))
  return {
    schemaVersion: 1,
    channel: record.channel,
    version: record.version,
    versionCode: record.versionCode,
    tag: record.tag,
    sourceSha: record.sourceSha,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${config.repository}/releases/tag/${encodeURIComponent(record.tag)}`,
    desc: description,
    history,
    assets,
    ...(state.signingCertificateSha256 ? { signingCertificateSha256: state.signingCertificateSha256 } : {}),
  }
}

async function verifyReleaseSigning(github, certificate, { config = CONFIG, pkg, inspect = inspectApk } = {}) {
  const { state: snapshot } = await github.readState()
  // Metadata created before certificate pinning needs one historical audit.
  // Fresh repositories establish the pin with their first prepared release.
  const history = snapshot.signingHistoryChecked || snapshot.signingCertificateSha256
    ? null
    : await seedState(github, config, pkg, inspect)
  const { state } = await github.updateState(state => {
    if (!state.signingCertificateSha256 && history?.signingCertificateSha256) state.signingCertificateSha256 = history.signingCertificateSha256
    pinSigningCertificate(state, certificate, config.signingCertificateSha256)
  })
  return state
}

async function prepare(github, record, inspect = inspectApk) {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  if (pkg.version !== record.version || pkg.versionCode !== record.versionCode) throw new Error('Build package version was not injected')
  const directory = path.join(ROOT, 'android/app/build/outputs/apk/release')
  const assets = []
  let signature
  for (const abi of CONFIG.abis) {
    const fileName = `${pkg.name}-v${record.version}-${abi}.apk`
    const file = path.join(directory, fileName)
    const metadata = inspect(file, { signingApplicationId: CONFIG.applicationId })
    if (metadata.version !== record.version || metadata.versionCode !== record.versionCode || metadata.applicationId !== CONFIG.applicationId) throw new Error(`Incorrect Android package metadata: ${fileName}`)
    const certificate = metadata.certificateSha256
    if (!/^[a-f0-9]{64}$/.test(certificate) || (signature && signature !== certificate)) throw new Error('APK signatures are missing or inconsistent')
    signature = certificate
    assets.push({ abi, fileName, size: fs.statSync(file).size, sha256: digest(file), url: `https://github.com/${CONFIG.repository}/releases/download/${encodeURIComponent(record.tag)}/${encodeURIComponent(fileName)}` })
  }
  const state = await verifyReleaseSigning(github, signature, { pkg, inspect })
  const previous = releaseHistory(state, record).find(item => item.sourceSha)
  // Complete history checkout allows changelogs to include every commit since
  // the previous successful release, including skipped/failed build snapshots.
  const range = previous?.sourceSha ? `${previous.sourceSha}..${record.sourceSha}` : record.sourceSha
  const description = git('log', '--no-merges', '--format=- %s (%h)', ...(previous?.sourceSha ? [] : ['-n', '50']), range) || 'Maintenance release.'
  const manifest = makeManifest(record, assets, state, description)
  validateManifest(manifest, record.channel, CONFIG.repository, pkg.name)
  const outputDirectory = path.join(OUTPUT, 'artifacts')
  fs.mkdirSync(outputDirectory, { recursive: true })
  for (const asset of assets) fs.copyFileSync(path.join(directory, asset.fileName), path.join(outputDirectory, asset.fileName))
  fs.writeFileSync(path.join(outputDirectory, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256}  ${asset.fileName}\n`).join(''))
  writeJson(path.join(outputDirectory, 'update.json'), manifest)
  return manifest
}

function requireCompleteRelease(release, manifest, config = CONFIG) {
  if (release.tag_name !== manifest.tag || release.prerelease !== (manifest.channel === 'next')) throw new Error('Release channel or tag is inconsistent')
  if (config.abis.some(abi => !manifest.assets.some(asset => asset.abi === abi))) throw new Error('Manifest is missing an expected APK architecture')
  for (const expected of [...manifest.assets.map(asset => ({ name: asset.fileName, size: asset.size })), { name: 'update.json' }, { name: 'SHA256SUMS.txt' }]) {
    const matching = release.assets.filter(asset => asset.name === expected.name && asset.state === 'uploaded')
    if (matching.length !== 1 || (expected.size !== undefined && matching[0].size !== expected.size)) throw new Error(`Release has an incomplete asset: ${expected.name}`)
  }
}

async function publishedManifest(github, release, record, knownManifest) {
  const pkg = readJson(path.join(ROOT, 'package.json'))
  const asset = release.assets.find(item => item.name === 'update.json')
  const manifest = validateManifest(knownManifest ?? await github.assetJson(asset), record.channel, CONFIG.repository, pkg.name)
  if (manifest.sourceSha !== record.sourceSha || manifest.version !== record.version || manifest.versionCode !== record.versionCode) throw new Error('Public release differs from its immutable reservation')
  requireCompleteRelease(release, manifest)
  for (const expected of manifest.assets) {
    if (await github.assetChecksum(release.assets.find(asset => asset.name === expected.fileName)) !== expected.sha256) throw new Error('Public APK checksum differs from update.json')
  }
  return manifest
}

async function promote(github, manifest, owner, publishAction, isAncestor = sourceContains) {
  return github.withPromotionLock(owner, async lease => {
    await lease.assertOwned()
    if (publishAction) await publishAction()
    const { state: snapshot } = await github.readState()
    const records = new Map(Object.values(snapshot.builds).map(record => [record.tag, record]))
    const published = (await github.list('/releases')).filter(item => !item.draft && tagVersion(item.tag_name))
      .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
    const known = new Map([manifest, ...Object.values(snapshot.channels)].filter(Boolean).map(info => [info.tag, info]))
    const read = async release => {
      const record = records.get(release.tag_name)
      if (!record) throw new Error(`Public release ${release.tag_name} has no reservation; restore release metadata first`)
      return publishedManifest(github, release, record, known.get(release.tag_name))
    }
    const stableRelease = published.find(release => !release.prerelease && !parseVersion(release.tag_name.slice(1)).prerelease.length && release.assets.some(asset => asset.name === 'update.json'))
    const stable = stableRelease ? await read(stableRelease) : snapshot.channels.stable
    const superseded = new Map()
    if (manifest.channel === 'next' && stable && (compareVersions(manifest.version, stable.version) <= 0 || isAncestor(manifest.sourceSha, stable.sourceSha))) {
      superseded.set(manifest.tag, stable.tag)
    }
    let next
    for (const release of published) {
      if (!release.prerelease || !/^next\.[1-9]\d*$/.test(parseVersion(release.tag_name.slice(1)).prerelease.join('.'))) continue
      const record = records.get(release.tag_name)
      if (!record) continue // Legacy previews had no managed update manifest.
      if (record.supersededBy || (stable && (compareVersions(record.version, stable.version) <= 0 || isAncestor(record.sourceSha, stable.sourceSha)))) {
        superseded.set(record.tag, record.supersededBy ?? stable.tag)
        continue
      }
      next = await read(release)
      break
    }
    // One reconciliation repairs both channels, even if a different/older job
    // is the first one to finish after an earlier publication's metadata failure.
    await lease.assertOwned()
    await github.updateState(state => {
      for (const info of [manifest, stable, next].filter(Boolean)) {
        if (info.signingCertificateSha256) pinSigningCertificate(state, info.signingCertificateSha256, CONFIG.signingCertificateSha256)
      }
      for (const [tag, stableTag] of superseded) {
        const record = records.get(tag)
        state.builds[buildKey(record.branch, record.sourceSha)].supersededBy = stableTag
      }
      if (state.channels.next && (superseded.has(state.channels.next.tag) || (stable && (compareVersions(state.channels.next.version, stable.version) <= 0 || isAncestor(state.channels.next.sourceSha, stable.sourceSha))))) {
        state.channels.next = null
      }
      publishManifest(state, manifest)
      if (stable) publishManifest(state, stable)
      if (next) publishManifest(state, next)
    })
    // Unmanaged legacy releases can still be Latest before the first managed
    // stable release, but never displace a complete managed channel snapshot.
    const latest = stableRelease ?? published.find(release => !release.prerelease && !parseVersion(release.tag_name.slice(1)).prerelease.length)
    if (latest) {
      await lease.assertOwned()
      await github.request('PATCH', `/releases/${latest.id}`, { json: { make_latest: 'true' } })
    }
  })
}

async function publish(github, record, isAncestor = sourceContains) {
  const owner = `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}/${randomUUID()}`
  return github.withLock(`releaseLock:${record.tag}`, owner, PUBLICATION_LEASE_MS, async lease => {
    await lease.assertOwned()
    await github.ensureTag(record.tag, record.sourceSha)
    const release = await github.getRelease(record.tag)
    if (release && !release.draft) {
      const manifest = await publishedManifest(github, release, record)
      await promote(github, manifest, owner, undefined, isAncestor)
      console.log(`Reused immutable public release ${record.tag}`)
      return manifest
    }
    const directory = path.join(OUTPUT, 'artifacts')
    const manifest = validateManifest(readJson(path.join(directory, 'update.json')), record.channel, CONFIG.repository, readJson(path.join(ROOT, 'package.json')).name)
    if (manifest.sourceSha !== record.sourceSha || manifest.version !== record.version || manifest.versionCode !== record.versionCode) throw new Error('Prepared artifacts do not match the version reservation')
    const { state: signingState } = await github.readState()
    if (!signingState.signingCertificateSha256 || manifest.signingCertificateSha256 !== signingState.signingCertificateSha256) throw new Error('Prepared APKs do not match the pinned release signing certificate')
    if (!release) {
      await lease.assertOwned()
    }
    const draftRelease = release ?? await github.request('POST', '/releases', { json: { tag_name: record.tag, target_commitish: record.sourceSha, name: record.tag, body: manifest.desc, draft: true, prerelease: record.channel === 'next', make_latest: 'false' } })
    const names = [...manifest.assets.map(asset => asset.fileName), 'SHA256SUMS.txt', 'update.json']
    for (const name of names) {
      const file = path.join(directory, name)
      const checksum = digest(file)
      const expected = manifest.assets.find(asset => asset.fileName === name)
      if (expected && (expected.sha256 !== checksum || expected.size !== fs.statSync(file).size)) throw new Error(`Local artifact changed after preparation: ${name}`)
      const existing = draftRelease.assets.find(asset => asset.name === name)
      if (existing?.state === 'uploaded' && existing.size === fs.statSync(file).size && await github.assetChecksum(existing) === checksum) continue
      if (existing) {
        await lease.assertOwned()
        await github.request('DELETE', `/releases/assets/${existing.id}`)
      }
      await lease.assertOwned()
      await github.request('POST', `/releases/${draftRelease.id}/assets?name=${encodeURIComponent(name)}`, {
        upload: true, body: fs.readFileSync(file), headers: { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
      })
    }
    const uploadedRelease = await github.getRelease(record.tag)
    requireCompleteRelease(uploadedRelease, manifest)
    for (const name of names) {
      if (await github.assetChecksum(uploadedRelease.assets.find(asset => asset.name === name)) !== digest(path.join(directory, name))) throw new Error(`Uploaded artifact failed SHA-256 verification: ${name}`)
    }
    await promote(github, manifest, owner, async() => {
      await lease.assertOwned()
      await github.request('PATCH', `/releases/${uploadedRelease.id}`, { json: { draft: false, prerelease: record.channel === 'next', body: manifest.desc, make_latest: 'false' } })
    }, isAncestor)
    console.log(`Published ${record.tag} and reconciled the ${record.channel} channel`)
    return manifest
  })
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== CONFIG.repository) throw new Error('Release commands run only in this repository CI')
  if (CONFIG.abis.length !== ABIS.length || ABIS.some(abi => !CONFIG.abis.includes(abi))) throw new Error('Release must contain all supported APK architectures')
  const github = new GitHub(CONFIG.repository, process.env.GITHUB_TOKEN, CONFIG.metadataBranch)
  const command = process.argv[2]
  if (command === 'reserve') return reserve(github)
  const record = readJson(path.join(OUTPUT, 'record.json'))
  if (command === 'inject') return inject(record)
  if (command === 'prepare') return prepare(github, record)
  if (command === 'publish') return publish(github, record)
  throw new Error(`Unknown release command: ${command}`)
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { seedState, pushContext, reserve, inject, releaseHistory, makeManifest, requireCompleteRelease, promote, publish, prepare, inspectApk, verifyReleaseSigning }
