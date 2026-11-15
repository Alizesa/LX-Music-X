const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { deferred, flush } = require('./helpers/load.cjs')
const { harness, songs } = require('./helpers/backup-stream.cjs')

test('streamed backup preserves the exact playList_v2 JSON, including metadata order, empty lists and Unicode', async() => {
  const lists = [{ id: 'a', name: '列表"一', locationUpdateTime: null }, { id: 'b', list: ['ignored'], name: '二', source: 'kw', locationUpdateTime: 1 }, { id: 'empty', name: '', extra: undefined }, { id: 'old', source: 'removed' }]
  const rows = id => songs(id, id === 'empty' ? 0 : 251)
  const h = harness({ lists, rows })
  await h.actions.handleExportList('/out')
  const expected = { type: 'playList_v2', data: lists.filter(info => info.source !== 'removed').map(info => ({ ...info, list: rows(info.id) })) }
  assert.equal(h.output('/out/lx_list.lxmc'), JSON.stringify(expected))
  assert.equal(h.peakCached(), 1)
  assert.equal(h.cache.allMusicList.size, 0)
  assert.equal(h.files.size, 0)
  assert.deepEqual(h.released, ['a', 'b', 'empty'])
  const batches = h.appends.map(text => {
    try { return JSON.parse('[' + text.replace(/^,/, '') + ']') } catch { return [] }
  }).filter(value => value[0]?.id)
  assert.equal(Math.max(...batches.map(batch => batch.length)), 100)
})

test('each list takes a membership snapshot before append waits so concurrent moves cannot duplicate or omit songs', async() => {
  const source = songs('a', 201); const gate = deferred()
  const h = harness({ lists: [{ id: 'a' }], rows: () => source })
  const append = h.fs.appendFile
  let batches = 0
  h.fs.appendFile = async(path, text) => {
    if (text.startsWith('{"id":"a-') && ++batches === 1) await gate.promise
    await append(path, text)
  }
  const exporting = h.actions.handleExportList('/out')
  await flush()
  source.push(source.shift())
  gate.resolve()
  await exporting
  assert.deepEqual(JSON.parse(h.output('/out/lx_list.lxmc')).data[0].list.map(item => item.id), songs('a', 201).map(item => item.id))
})

test('native append fragments stay bounded and preserve a surrogate pair at the 64 Ki-character boundary', async() => {
  const h = harness()
  const expected = { value: 'a'.repeat(64 * 1024 - 1 - '{"value":"'.length) + '😀end' }
  const chunks = async function * () { yield JSON.stringify(expected) }
  await h.tools.handleSaveFileChunks('/out', chunks())
  assert.deepEqual(JSON.parse(h.output('/out')), expected)
  assert.ok(h.appends.every(text => text.length <= 64 * 1024))
  assert.equal(h.appends.length, 2)
})

for (const failure of ['create', 'read', 'append', 'gzip']) {
  test(`${failure} failure removes the intermediate file and never reports export success`, async() => {
    const h = harness({ lists: [{ id: 'a' }], rows: () => songs('a'), failure })
    await h.actions.handleExportList('/out')
    assert.equal(h.errors.length, 1)
    assert.equal(h.notices.some(notice => notice === 'setting_backup_part_export_list_tip_success'), false)
    assert.equal(h.files.size, 0)
    assert.equal(h.cache.allMusicList.size, 0)
    assert.equal(h.removed.length, 1)
    if (failure !== 'gzip') assert.equal(h.outputs.size, 0)
  })
}

test('queued exports wait for the first gzip and preserve separate contents after a failed first compression', async() => {
  let version = 1
  const h = harness({ lists: [{ id: 'a' }], rows: () => songs(String(version), 2) }); const gate = deferred()
  const gzip = h.fs.gzipFile
  let compressions = 0
  h.fs.gzipFile = async(input, output) => {
    if (++compressions === 1) { await gate.promise; throw new Error('first compression failed') }
    await gzip(input, output)
  }
  const first = h.actions.handleExportList('/first'); const second = h.actions.handleExportList('/second')
  await flush()
  assert.equal(h.reads.length, 1)
  version = 2
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(h.errors.length, 1)
  assert.equal(h.reads.length, 2)
  assert.equal(JSON.parse(h.output('/second/lx_list.lxmc')).data[0].list[0].id, '2-0')
  assert.equal(h.files.size, 0)
})

test('single-list release protects LOCAL, TEMP, playback and an independent hold without clearing other caches', async() => {
  const h = harness()
  const values = ['local', 'temp', 'playing', 'held', 'other']
  values.forEach(id => h.cache.setMusicList(id, songs(id, 1)))
  h.state.playInfo.playerListId = 'playing'; h.setQueueFromTemp(true)
  const gate = deferred()
  const holding = h.cache.withListCacheProtection(['held'], () => gate.promise)
  for (const id of ['local', 'temp', 'playing', 'held', 'unknown']) h.cache.releaseIdleListCache(id)
  assert.deepEqual([...h.cache.allMusicList.keys()], values)
  gate.resolve(); await holding
  h.cache.releaseIdleListCache('held')
  assert.equal(h.cache.allMusicList.has('held'), false)
  assert.equal(h.cache.allMusicList.has('other'), true)
  h.setQueueFromTemp(false); h.cache.releaseIdleListCache('temp')
  assert.equal(h.cache.allMusicList.has('temp'), false)
})

test('finished exports do not keep decoded list arrays until the LRU timer fires', () => {
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', `
    const assert = require('node:assert/strict')
    const { harness, songs } = require('./tests/helpers/backup-stream.cjs')
    const { flush } = require('./tests/helpers/load.cjs')
    ;(async () => {
      const h = harness({ lists: ['a','b','c'].map(id => ({id})), rows: id => songs(id, 2000) })
      await h.actions.handleExportList('/out')
      assert.equal(h.peakCached(), 1)
      for (let index = 0; index < 10; index++) { await flush(); global.gc() }
      assert.ok(h.references.every(reference => reference.deref() === undefined))
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
