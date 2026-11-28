const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { createHarness, song, task } = require('./helpers/download-cleanup-runtime.cjs')
const { getDownloadQuality } = load('src/core/downloadQuality.ts')

const songMid = '004RsOoP2AyO7J'
const music = (mid = songMid) => ({ ...song(`tx_${mid}`), meta: { songId: mid, strMediaMid: 'old', _qualitys: {} } })
const detail = (mid = songMid, qualities = ['128k', '320k', 'flac']) => ({
  songmid: mid,
  strMediaMid: '000bYrRA2I7GQ7',
  interval: '04:39',
  types: qualities.map(type => ({ type, size: type === '320k' ? '10.68 MiB' : '4 MiB' })),
})
const catalog = read => load('src/core/downloadCatalog.ts', { '@/utils/musicSdk/tx/musicInfo': { default: read } })

test('public QQ details restore 320k for a sparse playlist entry without consulting a VIP account', async() => {
  const calls = []
  const api = catalog(async mid => { calls.push(mid); return detail() })
  const original = music()
  const [prepared] = await api.prepareDownloadMusicInfos([original])
  assert.deepEqual(calls, [songMid])
  assert.equal(getDownloadQuality(prepared, '320k'), '320k')
  assert.equal(prepared.meta.strMediaMid, '000bYrRA2I7GQ7')
  assert.equal(prepared.interval, '04:39')
  assert.equal(original.meta.strMediaMid, 'old')
  assert.deepEqual(original.meta._qualitys, {})
})

test('public details repair legacy entries that have a quality array but no quality map', async() => {
  const response = detail()
  const original = music()
  original.meta.qualitys = response.types
  original.meta.strMediaMid = response.strMediaMid
  original.interval = response.interval
  delete original.meta._qualitys
  const [prepared] = await catalog(async() => response).prepareDownloadMusicInfos([original])
  assert.equal(prepared.meta._qualitys['320k'].size, '10.68 MiB')
})

test('a stale Hi-Res entry is capped at the public catalog before any audio source is contacted', async() => {
  const calls = []
  const h = await createHarness({
    probeMusicInfo: async mid => { calls.push(['catalog', mid]); return detail(mid, ['128k', '320k']) },
    downloadSettings: { 'player.noVipStandardQuality': true, 'download.urlSource': 'source' },
    url: async args => { calls.push(['source', args.quality]); return 'https://fixture/audio' },
  })
  const original = music()
  original.meta._qualitys = { '128k': { size: '' }, flac24bit: { size: '' } }
  const [id] = await h.api.addTasks([original], 'flac24bit')
  await flush()
  assert.deepEqual(calls, [['catalog', songMid], ['source', '320k']])
  assert.equal(h.api.getDownloadTaskItem(id).quality, '320k')
  assert.equal((await h.data.getDownloadActiveTasks())[0].requestedQuality, '320k')
  assert.equal((await h.api.addTasks([original], '320k')).length, 0)
  assert.equal(calls.filter(([kind]) => kind === 'catalog').length, 1)
})

test('source failures keep the 320k confirmed by the public catalog and never request 128k', async() => {
  const calls = []
  const h = await createHarness({
    probeMusicInfo: async() => detail(),
    url: async args => {
      calls.push(args.quality)
      if (args.quality === '320k') throw new Error('all selected sources failed')
      return 'https://fixture/audio'
    },
  })
  const [id] = await h.api.addTasks([music()], '320k')
  await flush()
  assert.deepEqual(calls, ['320k'])
  assert.equal(h.api.getDownloadTaskItem(id).quality, '320k')
  assert.equal(h.api.getDownloadTaskItem(id).status, 'error')
  assert.equal(h.enqueued.length, 0)
  assert.equal((await h.data.getDownloadActiveTasks())[0].requestedQuality, '320k')
})

test('concurrent downloads share one public catalog read and short cache without sharing mutable song metadata', async() => {
  const gate = deferred(); let calls = 0
  const api = catalog(async() => { calls++; return gate.promise })
  const first = api.prepareDownloadMusicInfos([music()])
  const second = api.prepareDownloadMusicInfos([music()])
  assert.equal(calls, 1)
  gate.resolve(detail())
  const [a, b] = await Promise.all([first, second])
  a[0].meta.qualitys[0].size = 'changed'
  assert.notEqual(b[0].meta.qualitys[0].size, 'changed')
  const [cached] = await api.prepareDownloadMusicInfos([music()])
  assert.equal(calls, 1)
  assert.notEqual(cached.meta.qualitys[0].size, 'changed')
})

test('public catalog failures keep known song qualities and avoid repeated requests for the same failure', async() => {
  let calls = 0
  const api = catalog(async() => { calls++; throw new Error('catalog offline') })
  const original = music()
  original.meta._qualitys['320k'] = { size: '10.68 MiB' }
  const [prepared] = await api.prepareDownloadMusicInfos([original])
  assert.equal(prepared, original)
  assert.equal(getDownloadQuality(prepared, '320k'), '320k')
  await api.prepareDownloadMusicInfos([original])
  assert.equal(calls, 1)
})

test('details for a different QQ song and empty file metadata cannot change the download ceiling', async() => {
  for (const response of [detail('another-song'), detail(songMid, [])]) {
    const api = catalog(async() => response)
    const original = music()
    const [prepared] = await api.prepareDownloadMusicInfos([original])
    assert.equal(prepared, original)
  }
})

test('batch public catalog reads preserve order and limit parallel requests to four', async() => {
  const reads = []
  const api = catalog(mid => { const gate = deferred(); reads.push({ mid, gate }); return gate.promise })
  const songs = Array.from({ length: 9 }, (_, index) => music(String(index).padStart(14, '0')))
  const preparing = api.prepareDownloadMusicInfos(songs)
  assert.equal(reads.length, 4)
  for (let offset = 0; offset < songs.length; offset += 4) {
    for (const { mid, gate } of reads.slice(offset, offset + 4)) gate.resolve(detail(mid))
    await flush()
    assert.equal(reads.length, Math.min(offset + 8, songs.length))
  }
  assert.deepEqual(Array.from(await preparing, item => item.id), songs.map(item => item.id))
})

test('other platforms and invalid legacy QQ IDs do not trigger a public request', async() => {
  const api = catalog(async() => assert.fail('unexpected catalog request'))
  const values = [{ ...music(), source: 'kw' }, song('legacy')]
  const result = await api.prepareDownloadMusicInfos(values)
  assert.equal(result[0], values[0])
  assert.equal(result[1], values[1])
})

test('restored 320k tasks refresh sparse catalog data before choosing a source quality', async() => {
  const calls = []
  const value = { ...task('restored'), musicInfo: music(), quality: '320k', requestedQuality: '320k' }
  const h = await createHarness({
    active: [value],
    probeMusicInfo: async() => detail(),
    url: async args => { calls.push(args.quality); return 'https://fixture/audio' },
  })
  await h.api.initDownloads(); await flush()
  assert.deepEqual(calls, ['320k'])
  assert.equal(h.api.getDownloadTaskItem('restored').quality, '320k')
  assert.equal((await h.data.getDownloadActiveTasks())[0].musicInfo.meta.strMediaMid, '000bYrRA2I7GQ7')
})

test('pausing a restored task during catalog lookup prevents any late source request', async() => {
  const gate = deferred(); const calls = []
  const value = { ...task('paused-probe'), musicInfo: music(), quality: '320k', requestedQuality: '320k' }
  const h = await createHarness({
    active: [value],
    probeMusicInfo: async() => gate.promise,
    url: async args => { calls.push(args.quality); return 'https://fixture/audio' },
  })
  await h.api.initDownloads(); await flush()
  await h.api.pauseTask('paused-probe')
  gate.resolve(detail())
  await flush()
  assert.deepEqual(calls, [])
  assert.equal(h.api.getDownloadTaskItem('paused-probe').status, 'pause')
  assert.equal(h.enqueued.length, 0)
})

test('separate download batches share the same four public-request slots', async() => {
  const reads = []
  const api = catalog(mid => { const gate = deferred(); reads.push({ mid, gate }); return gate.promise })
  const songs = Array.from({ length: 8 }, (_, index) => music(String(index).padStart(14, '0')))
  const batches = Promise.all([api.prepareDownloadMusicInfos(songs.slice(0, 4)), api.prepareDownloadMusicInfos(songs.slice(4))])
  assert.equal(reads.length, 4)
  for (const { mid, gate } of reads.slice(0, 4)) gate.resolve(detail(mid))
  await flush()
  assert.equal(reads.length, 8)
  for (const { mid, gate } of reads.slice(4)) gate.resolve(detail(mid))
  await batches
})

test('removing restored tasks cancels active catalog IO and never dispatches abandoned slots', async() => {
  const gate = deferred(); const reads = []
  const active = Array.from({ length: 18 }, (_, i) => ({ ...task('gone-' + i), musicInfo: music(String(i).padStart(14, '0')) }))
  const h = await createHarness({
    active,
    probeMusicInfo: async(mid, options) => { reads.push(options.signal); await gate.promise; return detail(mid) },
  })
  await h.api.initDownloads(); await flush()
  for (const row of active) {
    assert.equal(h.api.getDownloadTaskItem(row.id).status, 'resolving')
    await h.api.removeTasks([row.id]); await flush()
  }
  assert.equal(reads.length, 4)
  gate.resolve(); await flush()
  assert.equal(reads.length, 4, 'cancelled queued lookups must never start')
  assert.ok(reads.every(s => s?.aborted)); assert.equal(h.enqueued.length, 0)
})

test('shared catalog consumers cancel independently and a late abandoned result cannot poison a new lookup', async() => {
  const reads = []
  const api = catalog((mid, options) => { const gate = deferred(); reads.push({ gate, signal: options.signal }); return gate.promise })
  const a = new AbortController(); const b = new AbortController()
  const first = api.prepareDownloadMusicInfos([music()], a.signal); const second = api.prepareDownloadMusicInfos([music()], b.signal)
  const done = Promise.allSettled([first, second]); await flush(); a.abort(); await flush()
  assert.equal(reads.length, 1); assert.equal(reads[0].signal?.aborted, false)
  b.abort(); await flush(); assert.equal(reads[0].signal.aborted, true)
  assert.deepEqual((await done).map(r => r.status), ['rejected', 'rejected'])
  const fresh = api.prepareDownloadMusicInfos([music()]); await flush(); assert.equal(reads.length, 2)
  reads[1].gate.resolve(detail(songMid, ['320k'])); await fresh
  reads[0].gate.resolve(detail(songMid, ['128k'])); await flush()
  assert.ok((await api.prepareDownloadMusicInfos([music()]))[0].meta._qualitys['320k']); assert.equal(reads.length, 2)
})

test('cancelled catalog waiters release song objects before a stalled transport settles', () => {
  const child = require('node:child_process').spawnSync(process.execPath, ['--expose-gc', '-e', `
    const { load, deferred, flush } = require('./tests/helpers/load.cjs'); const gate = deferred(); const refs = []; let calls = 0
    const api = load('src/core/downloadCatalog.ts', { '@/utils/musicSdk/tx/musicInfo': { default: async() => { calls++; return gate.promise } } })
    async function submit(i) {
      const mid = String(i).padStart(14, '0'), music = { id: 'tx_'+mid, source: 'tx', meta: { songId: mid } }; refs.push(new WeakRef(music))
      const c = new AbortController(), p = api.prepareDownloadMusicInfos([music], c.signal).catch(() => {}); c.abort(); await p
    }
    ;(async()=>{ for(let i=0;i<100;i++) await submit(i); for(let i=0;i<5;i++){ await flush(); global.gc() }
      if(refs.some(r=>r.deref()) || calls!==4) throw Error('cancelled song retained or more than four requests dispatched'); gate.resolve(null)
    })().catch(e=>{console.error(e);process.exitCode=1})
  `], { encoding: 'utf8', timeout: 30000 })
  assert.equal(child.status, 0, child.stderr)
})
