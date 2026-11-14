import { httpGet } from '@/utils/request'
import { name } from '../../package.json'
import { canUpgrade, compareVersions, isChannel, parseVersion, selectAsset, validateManifest } from '../../shared/release'
import { downloadFile, hash, readDir, stat, stopDownload, temporaryDirectoryPath, unlink } from '@/utils/fs'
import { getInstalledAppInfo, getSupportedAbis, installApk } from '@/utils/nativeModules/utils'
import { APP_PROVIDER_NAME } from '@/config/constant'

export const UPDATE_REPOSITORY = 'Alizesa/LX-Music-X'
const CHECK_DEADLINE = 20000
const REQUEST_TIMEOUT = 8000
const CACHE_TIME = 5 * 60000
// All endpoints read the same repository and metadata branch.
const sources = [
  {
    host: 'raw.githubusercontent.com',
    canonical: true,
    url: channel => `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/release-meta/channels/${channel}.json`,
  },
  {
    host: 'cdn.jsdelivr.net',
    canonical: false,
    url: channel => `https://cdn.jsdelivr.net/gh/${UPDATE_REPOSITORY}@release-meta/channels/${channel}.json`,
  },
  {
    // The API can confirm an unpublished channel when raw is unreachable
    // and the CDN only has a 404. It is last to avoid routine API rate limits.
    host: 'api.github.com',
    canonical: true,
    url: channel => `https://api.github.com/repos/${UPDATE_REPOSITORY}/contents/channels/${channel}.json?ref=release-meta`,
    headers: { Accept: 'application/vnd.github.raw+json' },
  },
]
const cache = new Map()
const channelTags = new Map()
const channelActivity = new Map()

const request = (url, timeout, headers) => new Promise((resolve, reject) => {
  httpGet(url, { timeout, headers }, (err, resp, body) => {
    if (err) reject(err)
    else if (resp.statusCode === 404) resolve(null)
    else if (resp.statusCode !== 200) reject(new Error(`Update request failed: ${resp.statusCode}`))
    else resolve(body)
  })
})

const getChannel = async(channel, force, deadline) => {
  const cacheKey = `${channel}:${channelTags.get(channel)}`
  const cached = cache.get(cacheKey)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.manifest
  if (!channelActivity.has(channel)) channelActivity.set(channel, { started: 0, resolved: 0, cleared: 0 })
  const activity = channelActivity.get(channel)
  const requestId = ++activity.started
  const errors = []
  for (const source of sources) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      errors.push(`${channel}: Update check timed out`)
      break
    }
    try {
      const info = await request(source.url(channel), Math.min(REQUEST_TIMEOUT, remaining), source.headers)
      // Only GitHub's canonical endpoints can confirm an unpublished channel.
      // Mirrors may cache a 404 while release metadata is still syncing.
      if (info === null) {
        if (source.canonical) {
          if (requestId < activity.resolved) return cache.get(`${channel}:${channelTags.get(channel)}`)?.manifest ?? null
          activity.resolved = activity.cleared = requestId
          cache.delete(`${channel}:${channelTags.get(channel)}`)
          channelTags.delete(channel)
          return null
        }
        throw new Error('Update mirror is missing channel metadata')
      }
      const manifest = validateManifest(info, channel, UPDATE_REPOSITORY, name)
      // A channel can be withdrawn when stable already contains its source.
      // An earlier response must not resurrect that withdrawn preview.
      if (requestId < activity.cleared) return cache.get(`${channel}:${channelTags.get(channel)}`)?.manifest ?? null
      activity.resolved = Math.max(activity.resolved, requestId)
      const previousKey = `${channel}:${channelTags.get(channel)}`
      const previous = cache.get(previousKey)
      // Requests from an older check may finish after a channel switch and
      // a newer response. Preserve the newest validated release in the cache.
      if (previous && (previous.manifest.versionCode > manifest.versionCode || compareVersions(previous.manifest.version, manifest.version) > 0)) return previous.manifest
      cache.delete(previousKey)
      channelTags.set(channel, manifest.tag)
      cache.set(`${channel}:${manifest.tag}`, { manifest, expiresAt: Date.now() + CACHE_TIME })
      return manifest
    } catch (error) {
      const message = error?.name === 'AbortError' || error?.message === 'Aborted' ? 'Update request timed out' : error?.message ?? String(error)
      errors.push(`${channel} / ${source.host}: ${message}`)
    }
  }
  throw new Error(errors.join('\n'))
}

export const getVersionInfo = async(channel = 'stable', force = false) => {
  if (!isChannel(channel)) throw new Error('Invalid update channel')
  const deadline = Date.now() + CHECK_DEADLINE
  const channels = channel === 'next' ? ['stable', 'next'] : ['stable']
  const results = await Promise.allSettled(channels.map(item => getChannel(item, force, deadline)))
  const manifests = results.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value)
  const errors = results.filter(item => item.status === 'rejected').map(item => item.reason?.message ?? String(item.reason))
  // A partial failure must not be presented as latest when the other channel
  // may hold an eligible update. Valid candidates can still be offered.
  return { manifests, incomplete: errors.length > 0, errors }
}

let downloadJobId = null
let downloadGeneration = 0
let downloaded = null
let installation = null
let cleanupQueue = Promise.resolve()
const protectedFiles = new Set()
const downloadTasks = new Set()

const settleDownloadWaiter = (waiter, failed, value) => {
  const callback = failed ? waiter.reject : waiter.resolve
  if (!callback) return
  waiter.task.waiters.delete(waiter)
  waiter.task = waiter.resolve = waiter.reject = null
  callback(value)
}

const waitForDownloadTask = (task, promise) => {
  const waiter = { task, resolve: null, reject: null }
  const result = new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
  task.waiters.add(waiter)
  // A pending native Promise retains only this detachable waiter, never the
  // caller's async frame, progress callback or release manifest after cancellation.
  Promise.resolve(promise).then(settleDownloadWaiter.bind(null, waiter, false), settleDownloadWaiter.bind(null, waiter, true))
  if (task.cancelled) settleDownloadWaiter(waiter, true, new Error('UPDATE_CANCELLED'))
  return result
}

const createDownloadTask = onDownload => {
  const task = { cancelled: false, onDownload, waiters: new Set() }
  downloadTasks.add(task)
  return task
}

const finishDownloadTask = task => {
  task.onDownload = null
  downloadTasks.delete(task)
}

const reportDownloadProgress = (task, total, { bytesWritten = 0 } = {}) => {
  if (!task.cancelled) task.onDownload?.(total, bytesWritten)
}

const cachedApkVersion = fileName => {
  if (!fileName.startsWith(`${name}-v`)) return null
  const suffix = /-(?:arm64-v8a|armeabi-v7a|x86_64|x86|universal)\.apk\.[1-9]\d*\.apk$/.exec(fileName)
  if (!suffix) return null
  const version = fileName.slice(name.length + 2, suffix.index)
  try { parseVersion(version); return version } catch { return null }
}

export const cleanupUpdateDownloads = (installedVersion) => {
  cleanupQueue = cleanupQueue.catch(() => {}).then(async() => {
    const entries = await readDir(temporaryDirectoryPath)
    for (const entry of entries) {
      if (!entry.isFile) continue
      const version = cachedApkVersion(entry.name)
      const legacy = entry.name === `${name}.apk`
      if (!version && !legacy) continue
      const path = `${temporaryDirectoryPath}/${entry.name}`
      if (protectedFiles.has(path)) continue
      // Startup removes installed/obsolete APKs and day-old abandoned files.
      // Starting a replacement download can also discard unclaimed future APKs.
      const expired = Number.isFinite(entry.lastModified) && entry.lastModified > 0 && Date.now() - entry.lastModified > 86400000
      if (!installedVersion || legacy || expired || compareVersions(version, installedVersion) <= 0) await unlink(path).catch(() => {})
    }
  })
  return cleanupQueue
}

const discardDownload = async({ path }) => {
  if (downloaded?.path === path) downloaded = null
  if (protectedFiles.delete(path)) await unlink(path).catch(() => {})
}

const finishNativeDownload = async(completion) => {
  completion.settled = true
  if (completion.discard) await discardDownload(completion)
}

export const hasDownloadedUpdate = tag => downloaded !== null && downloaded.manifest.tag === tag

export const cancelUpdateDownload = () => {
  downloadGeneration++
  for (const task of downloadTasks) {
    task.cancelled = true
    task.onDownload = null
    for (const waiter of task.waiters) settleDownloadWaiter(waiter, true, new Error('UPDATE_CANCELLED'))
  }
  downloadTasks.clear()
  if (downloadJobId !== null) { try { stopDownload(downloadJobId) } catch {} }
  downloadJobId = null
  const previous = downloaded
  downloaded = null
  if (previous) discardDownload(previous).catch(() => {})
}

const assertCurrent = generation => {
  if (generation !== downloadGeneration) throw new Error('UPDATE_CANCELLED')
}
const verifyDownload = async({ path, asset: { size, sha256 } }, generation) => {
  const details = await stat(path)
  assertCurrent(generation)
  if (details.size !== size || (await hash(path, 'sha256')).toLowerCase() !== sha256) {
    throw new Error('UPDATE_INTEGRITY_FAILED')
  }
}

const openInstaller = async({ path, manifest: { version, versionCode } }, generation) => {
  const installed = await getInstalledAppInfo()
  assertCurrent(generation)
  if (!canUpgrade(installed.version, installed.versionCode, { version, versionCode })) {
    await discardDownload({ path })
    throw new Error('APK is no longer an eligible upgrade')
  }
  await installApk(path, APP_PROVIDER_NAME)
}

export const updateApp = async() => {
  const file = downloaded
  if (!file) throw new Error('No verified APK is available')
  if (installation?.file === file) return installation.promise
  const generation = downloadGeneration
  const task = createDownloadTask(null)
  const promise = (async() => {
    try { await waitForDownloadTask(task, verifyDownload(file, generation)) } catch (error) {
      const cleanup = discardDownload(file)
      if (task.cancelled) cleanup.catch(() => {})
      else await cleanup
      throw error
    }
    await waitForDownloadTask(task, openInstaller(file, generation))
  })()
  installation = { file, promise }
  try { await promise } finally {
    finishDownloadTask(task)
    if (installation?.promise === promise) installation = null
  }
}

export const downloadNewVersion = async(info, onDownload = () => {}) => {
  const manifest = validateManifest(info, info.channel, UPDATE_REPOSITORY, name)
  cancelUpdateDownload()
  const generation = downloadGeneration
  const task = createDownloadTask(onDownload)
  try {
    await waitForDownloadTask(task, cleanupUpdateDownloads().catch(() => {}))
    const installed = await waitForDownloadTask(task, getInstalledAppInfo())
    if (!canUpgrade(installed.version, installed.versionCode, manifest)) throw new Error('APK is not an eligible upgrade')
    const asset = selectAsset(manifest.assets, await waitForDownloadTask(task, getSupportedAbis()))
    assertCurrent(generation)
    const path = `${temporaryDirectoryPath}/${asset.fileName}.${generation}.apk`
    const file = { path, asset, manifest }
    protectedFiles.add(path)
    let completion
    try {
      const progress = reportDownloadProgress.bind(null, task, asset.size)
      const { jobId, promise } = downloadFile(asset.url, path, {
        progressInterval: 500,
        connectionTimeout: 20000,
        readTimeout: 30000,
        begin: progress,
        progress,
      })
      downloadJobId = jobId
      // Keep only the path and cleanup flags alive until native streams close.
      completion = { path, settled: false, discard: false }
      const result = await waitForDownloadTask(task, promise.finally(finishNativeDownload.bind(null, completion)))
      assertCurrent(generation)
      if (result.statusCode !== 200 || result.bytesWritten !== asset.size) throw new Error('UPDATE_INTEGRITY_FAILED')
      await waitForDownloadTask(task, verifyDownload(file, generation))
      assertCurrent(generation)
      downloaded = file
    } catch (error) {
      if (completion && !completion.settled) completion.discard = true
      else {
        const cleanup = discardDownload(file)
        if (task.cancelled) cleanup.catch(() => {})
        else await cleanup
      }
      throw error
    } finally {
      if (generation === downloadGeneration) downloadJobId = null
    }
    // Installer failures preserve the verified APK for an explicit retry.
    const promise = waitForDownloadTask(task, openInstaller(file, generation))
    installation = { file, promise }
    try { await promise } finally {
      if (installation?.promise === promise) installation = null
    }
  } finally {
    finishDownloadTask(task)
  }
}
