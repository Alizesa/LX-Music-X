const { MAX_VERSION_CODE, compareVersions, nextPatch, parseVersion } = require('../shared/release')

const branchChannel = branch => {
  if (branch === 'master') return 'stable'
  if (branch === 'Next') return 'next'
  throw new Error(`Not a release branch: ${branch}`)
}
const buildKey = (branch, sha) => `${branch}/${sha}`

function validateTargetVersion(version) {
  if (version == null) return null
  const parsed = parseVersion(version)
  if (parsed.core.join('.') !== version) throw new Error('Target must contain only major.minor.patch')
  // Leave room for the largest possible preview suffix in the shared schema.
  parseVersion(`${version}-next.${MAX_VERSION_CODE}`)
  return version
}

function latestStableBuild(state) {
  return Object.values(state.builds).filter(record => record.channel === 'stable')
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}

function restoreBranchHeads(state) {
  for (const branch of ['master', 'Next']) {
    if (state.branches[branch]) continue
    const latest = Object.values(state.builds).filter(record => record.branch === branch)
      .sort((a, b) => b.versionCode - a.versionCode)[0]
    if (latest) state.branches[branch] = latest.sourceSha
  }
}

function createState(version, versionCodeBase) {
  if (parseVersion(version).prerelease.length) throw new Error('Release baseline must be stable')
  if (!Number.isSafeInteger(versionCodeBase) || versionCodeBase < 1 || versionCodeBase >= MAX_VERSION_CODE) throw new Error('Invalid version code baseline')
  return { schemaVersion: 1, versionCodeBase, sequence: 0, lastStableVersion: version, nextTargetVersion: nextPatch(version), branches: {}, events: {}, builds: {}, channels: {}, legacyHistory: [] }
}

// Called inside a compare-and-swap transaction on release-meta. before/after
// chains let a later Actions run register first without reversing versions.
function registerPush(state, event, { isAncestor = () => false, correctTarget = false } = {}) {
  branchChannel(event.branch)
  if (!/^[a-f0-9]{40}$/.test(event.sha) || !/^[a-f0-9]{40}$/.test(event.before)) throw new Error('Invalid push SHA')
  restoreBranchHeads(state)
  const key = buildKey(event.branch, event.sha)
  if (state.builds[key]) return state.builds[key]
  const targetVersion = validateTargetVersion(event.targetVersion)
  const existing = state.events[key]
  if (existing && existing.before !== event.before) throw new Error('Source commit was reintroduced with different history')
  if (!existing) state.events[key] = { ...event, targetVersion }
  else {
    let invalidTarget = false
    try { validateTargetVersion(existing.targetVersion) } catch { invalidTarget = true }
    if (correctTarget || invalidTarget) {
      existing.targetVersion = targetVersion
      delete existing.error
    }
  }
  if (!state.branches[event.branch] && event.bootstrap) state.branches[event.branch] = event.before
  allocateReady(state, isAncestor)
  return state.builds[key] ?? null
}

function allocateReady(state, isAncestor) {
  let progress
  do {
    progress = false
    const ready = Object.entries(state.events).sort(([a], [b]) => a.localeCompare(b))
    for (const [key, event] of ready) {
      if (state.branches[event.branch] !== event.before) continue
      // Old metadata may already contain an invalid pending target. Keep its
      // error visible, without rolling back unrelated/predecessor reservations.
      try { validateTargetVersion(event.targetVersion) } catch (error) {
        event.error = error.message
        continue
      }
      if (state.sequence + state.versionCodeBase >= MAX_VERSION_CODE) throw new Error('Android version codes exhausted')
      const channel = branchChannel(event.branch)
      const stable = latestStableBuild(state)
      const superseded = channel === 'next' && stable && isAncestor(event.sha, stable.sourceSha)
      let target = nextPatch(state.lastStableVersion)
      if (state.nextTargetVersion && compareVersions(state.nextTargetVersion, target) > 0) target = state.nextTargetVersion
      if (event.targetVersion) {
        if (compareVersions(event.targetVersion, target) > 0) target = event.targetVersion
      }
      if (superseded) target = parseVersion(stable.version).core.join('.')
      const sequence = ++state.sequence
      const version = channel === 'stable' ? target : `${target}-next.${sequence}`
      if (channel === 'stable') state.lastStableVersion = version
      if (!superseded) state.nextTargetVersion = channel === 'stable' ? nextPatch(version) : target
      state.builds[key] = {
        branch: event.branch,
        sourceSha: event.sha,
        before: event.before,
        channel,
        sequence,
        version,
        versionCode: state.versionCodeBase + sequence,
        tag: `v${version}`,
        status: 'allocated',
        ...(superseded ? { supersededBy: stable.tag } : {}),
      }
      state.branches[event.branch] = event.sha
      delete state.events[key]
      progress = true
    }
  } while (progress)
}

function publishManifest(state, manifest) {
  const branch = manifest.channel === 'stable' ? 'master' : 'Next'
  const record = state.builds[buildKey(branch, manifest.sourceSha)]
  if (!record || record.version !== manifest.version || record.versionCode !== manifest.versionCode) throw new Error('Release does not match its reservation')
  record.status = 'published'
  record.notes = { version: manifest.version, desc: manifest.desc }
  record.publishedAt = manifest.publishedAt
  if (record.supersededBy) return false
  const previous = state.channels[manifest.channel]
  if (previous && (previous.versionCode >= manifest.versionCode || compareVersions(previous.version, manifest.version) >= 0)) return false
  state.channels[manifest.channel] = manifest
  return true
}

module.exports = { branchChannel, buildKey, createState, registerPush, publishManifest, validateTargetVersion, latestStableBuild, restoreBranchHeads }
