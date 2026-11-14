const { setTimeout: delay } = require('node:timers/promises')
const { createWriteStream } = require('node:fs')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { createHash } = require('node:crypto')

const PUBLICATION_LEASE_MS = 120000
const REQUEST_TIMEOUT_MS = 30000
const UPLOAD_TIMEOUT_MS = 180000
const WRITE_MARGIN_MS = 5000
const lostLock = () => Object.assign(new Error('Publication lock ownership was lost'), { code: 'PUBLICATION_LOCK_LOST' })

class GitHubError extends Error {
  constructor(status, message) {
    super(`GitHub ${status}: ${message}`)
    this.status = status
  }
}

class GitHub {
  constructor(repository, token, metadataBranch, fetchImpl = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('A repository and GITHUB_TOKEN are required')
    this.repository = repository
    this.token = token
    this.metadataBranch = metadataBranch
    this.fetch = fetchImpl
    this.snapshot = null
  }

  async request(method, route, { json, body, headers = {}, allow404 = false, upload = false, signal } = {}) {
    const base = upload ? 'https://uploads.github.com' : 'https://api.github.com'
    const timeout = AbortSignal.timeout(upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
    const response = await this.fetch(`${base}/repos/${this.repository}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LX-Music-X-release',
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: json === undefined ? body : JSON.stringify(json),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (allow404 && response.status === 404) return null
    const text = await response.text()
    let value
    try { value = text ? JSON.parse(text) : null } catch { value = null }
    if (!response.ok) throw new GitHubError(response.status, value?.message ?? response.statusText)
    return value
  }

  async list(route) {
    const items = []
    for (let page = 1; ; page++) {
      const response = await this.request('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const batch = Array.isArray(response) ? response : response?.workflow_runs
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub list response')
      items.push(...batch)
      if (batch.length < 100) return items
    }
  }

  async readState() {
    const ref = await this.request('GET', `/git/ref/heads/${encodeURIComponent(this.metadataBranch)}`, { allow404: true })
    if (!ref) {
      this.snapshot = null
      return { head: null, tree: null, state: null }
    }
    // Still read the mutable ref on every ownership check. Commit contents are
    // immutable, so the same head needs no further tree/blob requests.
    if (this.snapshot?.head === ref.object.sha) return structuredClone(this.snapshot)
    const commit = await this.request('GET', `/git/commits/${ref.object.sha}`)
    const tree = await this.request('GET', `/git/trees/${commit.tree.sha}`)
    const entry = tree.tree.find(item => item.path === 'state.json' && item.type === 'blob')
    if (!entry) throw new Error('Existing metadata branch has no release state; refusing to overwrite it')
    const blob = await this.request('GET', `/git/blobs/${entry.sha}`)
    const state = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'))
    if (state.schemaVersion !== 1 || state.repository !== this.repository || !Number.isSafeInteger(state.sequence)) throw new Error('Unknown release state')
    this.snapshot = { head: ref.object.sha, tree: commit.tree.sha, state }
    return structuredClone(this.snapshot)
  }

  async updateState(change, seed) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const snapshot = await this.readState()
      const state = structuredClone(snapshot.state ?? seed)
      if (!state) throw new Error('Release state has not been initialized')
      state.repository = this.repository
      const result = await change(state)
      if (snapshot.state && JSON.stringify(state) === JSON.stringify(snapshot.state)) return { state, result }
      const files = [{ path: 'state.json', mode: '100644', type: 'blob', content: JSON.stringify(state, null, 2) + '\n' }]
      for (const channel of ['stable', 'next']) {
        const manifest = state.channels[channel] ?? null
        if (JSON.stringify(manifest) !== JSON.stringify(snapshot.state?.channels[channel] ?? null)) {
          files.push({ path: `channels/${channel}.json`, mode: '100644', type: 'blob', content: JSON.stringify(manifest, null, 2) + '\n' })
        }
      }
      const tree = await this.request('POST', '/git/trees', { json: { ...(snapshot.tree ? { base_tree: snapshot.tree } : {}), tree: files } })
      const commit = await this.request('POST', '/git/commits', {
        json: { message: 'release: update version reservations and channels', tree: tree.sha, parents: snapshot.head ? [snapshot.head] : [] },
      })
      try {
        if (snapshot.head) {
          // This commit has the previously read head as its sole parent.
          // force:false rejects a concurrent sibling commit instead of losing it.
          await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(this.metadataBranch)}`, { json: { sha: commit.sha, force: false } })
        } else {
          await this.request('POST', '/git/refs', { json: { ref: `refs/heads/${this.metadataBranch}`, sha: commit.sha } })
        }
        this.snapshot = { head: commit.sha, tree: tree.sha, state: structuredClone(state) }
        return { state, result }
      } catch (error) {
        if (![409, 422].includes(error.status)) throw error
        const latest = await this.readState()
        if (latest.head === snapshot.head) throw error
        await delay(100 + Math.random() * 400)
      }
    }
    throw new Error('Release metadata is busy; rerun this source commit')
  }

  async getRelease(tag) {
    const release = await this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
    if (release) return release
    // Drafts may not be returned by the tag endpoint.
    return (await this.list('/releases')).find(item => item.tag_name === tag) ?? null
  }

  async assetJson(asset) {
    if (!asset || !Number.isSafeInteger(asset.id)) throw new Error('Missing release metadata asset')
    return this.request('GET', `/releases/assets/${asset.id}`, { headers: { Accept: 'application/octet-stream' } })
  }

  async assetResponse(asset) {
    const response = await this.fetch(`https://api.github.com/repos/${this.repository}/releases/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) throw new GitHubError(response.status, 'Cannot download release asset')
    return response
  }

  async downloadAsset(asset, target) {
    const response = await this.assetResponse(asset)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: 'wx' }))
  }

  async assetChecksum(asset) {
    if (/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) return asset.digest.slice(7)
    const response = await this.assetResponse(asset)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length
      hash.update(chunk)
    }
    if (size !== asset.size) throw new Error('Release asset size changed during verification')
    return hash.digest('hex')
  }

  async ensureTag(tag, sha) {
    let ref = await this.request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`, { allow404: true })
    if (!ref) {
      try {
        ref = await this.request('POST', '/git/refs', { json: { ref: `refs/tags/${tag}`, sha } })
      } catch (error) {
        if (error.status !== 422) throw error
        ref = await this.request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`)
      }
    }
    let object = ref.object
    while (object.type === 'tag') object = (await this.request('GET', `/git/tags/${object.sha}`)).object
    if (object.type !== 'commit' || object.sha !== sha) throw new Error(`Tag ${tag} already belongs to another commit`)
  }

  async withPromotionLock(owner, work) {
    return this.withLock('promotionLock', owner, PUBLICATION_LEASE_MS, work)
  }

  async lockOwnerCompleted(owner) {
    const run = /^([1-9]\d*)\/([1-9]\d*)\//.exec(owner ?? '')
    if (!run) return false
    // A rerun shares its run ID with the cancelled job. Inspect the owning
    // attempt, rather than the latest attempt which may already be running.
    const attempt = await this.request('GET', `/actions/runs/${run[1]}/attempts/${run[2]}`, { allow404: true })
    return attempt?.status === 'completed'
  }

  async withLock(key, owner, leaseMs, work) {
    const deadline = Date.now() + 180000
    let acquired = false
    let notBefore = 0
    let reclaimOwner
    let checkedOwner
    let nextRunCheck = 0
    let waitMs = 3000
    while (!acquired && Date.now() < deadline) {
      const transaction = await this.updateState(state => {
        const current = state[key]
        if (current && current.owner !== owner) {
          // A cancelled process can still have a GitHub mutation in flight.
          // Its recorded write window also applies to early Actions reclamation.
          if (current.writeExpiresAt > Date.now()) return false
          if (current.expiresAt > Date.now() && current.owner !== reclaimOwner) return false
        }
        // Older publishers checked ownership before PATCH but did not reserve
        // its full request window. Drain that possible request when taking over.
        const legacyPromotion = key === 'promotionLock' && current && current.owner !== owner && current.protocol !== 2
        const drainUntil = Math.max(current?.notBefore ?? 0, legacyPromotion ? Date.now() + REQUEST_TIMEOUT_MS + WRITE_MARGIN_MS : 0)
        state[key] = { owner, expiresAt: Date.now() + leaseMs, protocol: 2, ...(drainUntil > Date.now() ? { notBefore: drainUntil } : {}) }
        return true
      })
      acquired = transaction.result
      if (acquired) {
        notBefore = transaction.state[key].notBefore ?? 0
        break
      }
      const blockedOwner = transaction.state[key]?.owner
      if (blockedOwner && (blockedOwner !== checkedOwner || Date.now() >= nextRunCheck)) {
        checkedOwner = blockedOwner
        nextRunCheck = Date.now() + 15000
        // Missing run data or a failed API request is not evidence that a
        // worker stopped. Short leases still allow recovery when offline.
        if (await this.lockOwnerCompleted(blockedOwner).catch(() => false)) {
          reclaimOwner = blockedOwner
          continue
        }
      }
      const lock = transaction.state[key]
      const expiresAt = lock?.owner === reclaimOwner
        ? lock.writeExpiresAt ?? lock.expiresAt
        : Math.max(lock?.expiresAt ?? deadline, lock?.writeExpiresAt ?? 0)
      await delay(Math.max(1, Math.min(waitMs, expiresAt - Date.now(), deadline - Date.now())))
      waitMs = Math.min(15000, waitMs * 2)
    }
    if (!acquired) throw new Error('Another release owns the publication lock; rerun this source commit')
    let renewalFailure
    const controller = new AbortController()
    let writeUncertain = false
    const fail = error => {
      renewalFailure ??= error
      controller.abort(renewalFailure)
      return renewalFailure
    }
    let pendingRenewal = Promise.resolve()
    const renew = (protectWrite = false) => {
      pendingRenewal = pendingRenewal.then(async() => {
        if (renewalFailure) return
        const transaction = await this.updateState(state => {
          if (state[key]?.owner !== owner || state[key].expiresAt <= Date.now()) return false
          state[key].expiresAt = Date.now() + leaseMs
          if (protectWrite) state[key].writeExpiresAt = state[key].expiresAt
          return true
        })
        if (!transaction.result) throw lostLock()
      }).catch(error => { fail(error) })
      return pendingRenewal
    }
    const timer = setInterval(renew, Math.min(60000, Math.floor(leaseMs / 3)))
    timer.unref()
    const lease = {
      assertOwned: async() => {
        if (renewalFailure) throw renewalFailure
        const { state } = await this.readState()
        if (state[key]?.owner !== owner || state[key].expiresAt <= Date.now()) throw fail(lostLock())
        return { expiresAt: state[key].expiresAt, writeExpiresAt: state[key].writeExpiresAt }
      },
      request: async(method, route, options = {}) => {
        // Reserve enough lease time for the entire bounded request, including
        // slow renewal commits. Checking the old lease alone is insufficient.
        await renew(true)
        const window = await lease.assertOwned()
        const timeout = options.upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        if (Math.min(window.expiresAt, window.writeExpiresAt ?? 0) - Date.now() <= timeout + WRITE_MARGIN_MS) throw fail(lostLock())
        writeUncertain = true
        let result
        try {
          result = await this.request(method, route, {
            ...options,
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
          })
          writeUncertain = false
        } catch (error) {
          throw renewalFailure ?? error
        }
        await lease.assertOwned()
        return result
      },
    }
    try {
      if (notBefore > Date.now()) {
        await delay(notBefore - Date.now())
        await lease.assertOwned()
      }
      const result = await work(lease)
      clearInterval(timer)
      await pendingRenewal
      if (renewalFailure) throw renewalFailure
      await lease.assertOwned()
      return result
    } finally {
      clearInterval(timer)
      await pendingRenewal
      await this.updateState(state => {
        if (state[key]?.owner !== owner) return
        if (writeUncertain && state[key].writeExpiresAt > Date.now()) {
          // A failed transport does not prove the server cancelled its PATCH.
          state[key].expiresAt = state[key].writeExpiresAt
        } else delete state[key]
      })
    }
  }
}

module.exports = { GitHub, GitHubError, PUBLICATION_LEASE_MS }
