const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHarness, completed, task, flush, deferred } = require('./helpers/download-cleanup-runtime.cjs')

for (const stage of ['download', 'metadata', 'unlink']) {
  test(`a cancelled task keeps its temporary cover protected until native ${stage} finishes`, async() => {
    const pending = deferred()
    const cover = {
      download: () => stage === 'download' ? pending.promise : Promise.resolve({ statusCode: 200 }),
      metadata: () => stage === 'metadata' ? pending.promise : Promise.resolve(),
      unlink: () => stage === 'unlink' ? pending.promise : Promise.resolve(),
    }
    const h = await createHarness({ active: [{ ...task('cover'), status: 'pause', nativeId: 'old-work' }], cover })
    await h.api.initDownloads()
    await flush()
    h.emit(completed('cover', 'old-work', 'content://audio'))
    await flush()
    assert.equal(h.protectedPaths.size, 1)
    await h.api.removeTasks(['cover'])
    await flush()
    assert.equal(await h.api.getDownloadCount(), 0)
    assert.equal(h.protectedPaths.size, 1)
    if (stage === 'download') assert.deepEqual(h.stoppedCovers, [1])
    pending.resolve({ statusCode: 200 })
    await flush()
    assert.equal(h.protectedPaths.size, 0)
    assert.equal(h.files.has('/temp/lx-download-cover.jpg'), false)
  })
}
