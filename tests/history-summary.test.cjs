const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { deferred, flush } = require('./helpers/load.cjs')
const { harness, historyKey, summaryKey, item } = require('./helpers/history-summary.cjs')

test('history count and recommendation seed read only their shared compact persisted index', async() => {
  const summary = { v: 1, count: 300, qqSeed: { id: '42', name: 'Seed' } }
  const h = harness([[summaryKey, JSON.stringify(summary)]])
  assert.equal(await h.api.getPlayHistoryCount(), 300)
  assert.deepEqual({ ...await h.api.getPlayHistoryQQSeed() }, summary.qqSeed)
  assert.deepEqual(h.reads, [summaryKey])
  assert.equal(h.writes.length, 0)
})

for (const previous of [null, { v: 2, count: 99, qqSeed: null }, { v: 1, count: -1, qqSeed: null }]) {
  test(`legacy or incompatible summary ${JSON.stringify(previous)} falls back once and migrates`, async() => {
    const downloaded = { musicInfo: { metadata: { musicInfo: item('downloaded', 'tx', { id: '42' }).musicInfo } }, playedAt: 2 }
    const history = [item('local', 'local'), item('missing', 'tx'), downloaded, item('older', 'tx', { id: '99' })]
    const h = harness([[historyKey, JSON.stringify(history)], ...(previous ? [[summaryKey, JSON.stringify(previous)]] : [])])
    const [count, seed] = await Promise.all([h.api.getPlayHistoryCount(), h.api.getPlayHistoryQQSeed()])
    assert.equal(count, 4)
    assert.deepEqual({ ...seed }, { id: '42', name: 'Song downloaded' })
    await flush()
    assert.equal(h.reads.filter(key => key === historyKey).length, 1)
    await h.api.getPlayHistoryCount()
    await h.api.getPlayHistoryQQSeed()
    assert.equal(h.reads.filter(key => key === historyKey).length, 1)
    const restarted = h.createData()
    assert.equal(await restarted.getPlayHistoryCount(), 4)
    assert.equal(h.reads.filter(key => key === historyKey).length, 1)
  })
}

test('summary fallback and a full history screen share one cold body read and preserve the screen cache', async() => {
  const history = [item('one'), item('seed', 'tx', { id: '42' })]
  const h = harness([[historyKey, JSON.stringify(history)]]); const gate = deferred()
  const getItem = h.native.getItem
  h.native.getItem = async key => { if (key === historyKey) await gate.promise; return getItem(key) }
  const count = h.api.getPlayHistoryCount(); const full = h.api.getPlayHistory()
  await flush(); gate.resolve()
  assert.equal(await count, 2)
  const rows = await full
  assert.equal(await h.api.getPlayHistory(), rows)
  assert.equal(h.reads.filter(key => key === historyKey).length, 1)
})

test('legacy rows lacking recommendation metadata still contribute to the count and do not break index migration', async() => {
  const history = [{ musicInfo: null }, { musicInfo: { source: 'tx', meta: null } }, item('seed', 'tx', { id: '42' })]
  const h = harness([[historyKey, JSON.stringify(history)]])
  assert.equal(await h.api.getPlayHistoryCount(), 3)
  assert.deepEqual({ ...await h.api.getPlayHistoryQQSeed() }, { id: '42', name: 'Song seed' })
  await flush()
  assert.equal(await h.createData().getPlayHistoryCount(), 3)
})

test('a late summary read cannot replace an updated in-memory history or its seed', async() => {
  const h = harness([[summaryKey, JSON.stringify({ v: 1, count: 1, qqSeed: null })]])
  const gate = deferred(); const getItem = h.native.getItem
  h.native.getItem = async key => { const value = await getItem(key); if (key === summaryKey) await gate.promise; return value }
  const count = h.api.getPlayHistoryCount(); const seed = h.api.getPlayHistoryQQSeed()
  await flush()
  await h.api.savePlayHistory([item('latest', 'tx', { id: '7' }), item('other')])
  gate.resolve()
  assert.equal(await count, 2)
  assert.deepEqual({ ...await seed }, { id: '7', name: 'Song latest' })
  await h.run()
  assert.equal(JSON.parse(h.values.get(summaryKey)).count, 2)
})

test('failed atomic history writes keep the old durable summary and retry the full pair on a later read', async() => {
  const old = [item('old')]
  const h = harness([[historyKey, JSON.stringify(old)], [summaryKey, JSON.stringify({ v: 1, count: 1, qqSeed: null })]])
  const commit = h.native.multiSet
  h.native.multiSet = async() => { throw new Error('disk full') }
  await h.api.savePlayHistory([item('new', 'tx', { id: '7' }), item('second')])
  await h.run()
  assert.equal(JSON.parse(h.values.get(summaryKey)).count, 1)
  assert.equal(await h.createData().getPlayHistoryCount(), 1)
  assert.equal(await h.api.getPlayHistoryCount(), 2)
  assert.equal(JSON.parse(h.values.get(summaryKey)).count, 1, 'an unsaved new body cannot backfill a standalone new index')
  h.native.multiSet = commit
  await h.run()
  assert.equal(JSON.parse(h.values.get(historyKey)).length, 2)
  assert.equal(await h.createData().getPlayHistoryCount(), 2)
})

test('a failed migration remains retryable without rereading the full body', async() => {
  const h = harness([[historyKey, JSON.stringify([item('old')])]])
  const commit = h.native.multiSet
  h.native.multiSet = async() => { throw new Error('migration unavailable') }
  assert.equal(await h.api.getPlayHistoryCount(), 1)
  await flush()
  h.native.multiSet = commit
  assert.equal(await h.api.getPlayHistoryCount(), 1)
  await flush()
  assert.equal(await h.createData().getPlayHistoryCount(), 1)
  assert.equal(h.reads.filter(key => key === historyKey).length, 1)
})

test('an index I/O failure is not interpreted as a missing history and can recover', async() => {
  const h = harness([[summaryKey, JSON.stringify({ v: 1, count: 300, qqSeed: null })]])
  const getItem = h.native.getItem
  h.native.getItem = async() => { throw new Error('read unavailable') }
  await assert.rejects(h.api.getPlayHistoryCount(), /read unavailable/)
  assert.equal(h.reads.filter(key => key === historyKey).length, 0)
  h.native.getItem = getItem
  assert.equal(await h.api.getPlayHistoryCount(), 300)
})

test('a count-only legacy migration releases the decoded 300-song body after deriving its compact index', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness, historyKey, item } = require('./tests/helpers/history-summary.cjs')
    const { flush } = require('./tests/helpers/load.cjs')
    ;(async () => {
      const h = harness([[historyKey, JSON.stringify(Array.from({ length: 300 }, (_, index) => item(String(index))))]])
      assert.equal(await h.api.getPlayHistoryCount(), 300)
      await flush()
      const reference = h.decoded[0]
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.equal(reference.deref(), undefined)
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
