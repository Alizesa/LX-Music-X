const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { createHarness, song, task } = require('./helpers/download-cleanup-runtime.cjs')
const { getDownloadQualityOrder } = load('src/core/downloadQuality.ts')
const track = (qualities = ['128k', '320k', 'flac']) => {
  const music = song('bounded')
  music.meta._qualitys = Object.fromEntries(qualities.map(quality => [quality, { size: '' }]))
  return music
}
const aac = { readable: true, durationMs: 180000, mime: 'audio/mp4a-latm', headerKind: 'mp4', contentLength: 2200000, bitRate: 96000 }
const mp3 = { readable: true, durationMs: 180000, mime: 'audio/mpeg', headerKind: 'mp3', contentLength: 7200000, bitRate: 320000 }
const accept = async(args, media) => { const url = 'https://fixture/audio'; await args.validateUrl(url, media); return url }

for (const [available, requested, expected] of [
  [['128k'], 'flac24bit', ['128k']],
  [['128k', '320k'], 'flac24bit', ['320k', '128k']],
  [['128k', '320k', 'flac'], 'flac24bit', ['flac', '320k', '128k']],
  [['128k', '320k', 'flac', 'flac24bit'], '320k', ['320k', '128k']],
  [['128k', '320k', 'flac', 'flac24bit'], '128k', ['128k']],
  [['128k', 'flac'], '320k', ['128k']],
  [[], 'flac24bit', ['128k']],
]) {
  test(`download quality order caps ${requested} at QQ catalog ${available.join(',') || 'unknown'}`, () => {
    assert.deepEqual(Array.from(getDownloadQualityOrder(track(available), requested)), expected)
  })
}

test('legacy zero-sized phantom tiers do not raise the download ceiling', () => {
  const music = track(['128k', '320k', 'flac', 'flac24bit'])
  music.meta._qualitys['320k'].size = '0 B'
  music.meta._qualitys.flac.size = 'NaN undefined'
  music.meta._qualitys.flac24bit.size = 'Infinity MiB'
  assert.deepEqual(Array.from(getDownloadQualityOrder(music, 'flac24bit')), ['128k'])
})

test('catalog bounds QQ requests while other platforms keep their requested tiers', () => {
  assert.deepEqual(Array.from(getDownloadQualityOrder(track(), 'flac24bit')), ['flac', '320k', '128k'])
  assert.deepEqual(Array.from(getDownloadQualityOrder({ ...track(), source: 'kg' }, 'flac24bit')), ['flac24bit'])
})

test('mixed batches cap each song separately and deduplicate after capping', async() => {
  const calls = []
  const h = await createHarness({ url: async args => { calls.push([args.musicInfo.id, args.quality]); return 'https://fixture/audio' } })
  const first = { ...track(['128k']), id: 'standard' }
  const second = { ...track(['128k', '320k']), id: 'high' }
  assert.equal((await h.api.addTasks([first, second], 'flac24bit')).length, 2)
  await flush()
  assert.deepEqual(calls, [['standard', '128k'], ['high', '320k']])
  assert.equal((await h.api.addTasks([first], '320k')).length, 0)
  const active = await h.data.getDownloadActiveTasks()
  assert.deepEqual(Array.from(active, value => value.quality), ['128k', '320k'])
  assert.deepEqual(Array.from(active, value => value.requestedQuality), ['128k', '320k'])
})

test('all selected sources at each tier precede lower-tier requests and final history records the downgrade', async() => {
  const calls = []; const probes = []; const options = []
  const setting = { 'common.apiSource': 'user_api_A', 'common.apiSourceOrder': '["user_api_A","user_api_B"]' }
  const message = load('src/utils/message.ts')
  const qq = load('src/core/qqMusicUrl.ts', {
    './qqMusic': {},
    '@/utils/nativeModules/remoteAudio': {
      probeRemoteAudio: async url => {
        probes.push(url)
        return url.includes('flac') ? { ...aac, mime: 'audio/alac' } : aac
      },
    },
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
  })
  const priority = load('src/core/music/sourcePriority.ts', {
    '@/store/setting/state': { default: { setting } },
    '@/store/userApi': { state: { list: [{ id: 'user_api_A' }, { id: 'user_api_B' }] } },
    '@/utils/apiSourceOrder': load('src/utils/apiSourceOrder.ts'),
    '@/utils/message': message,
    '@/core/qqMusicUrl': qq,
    '@/core/userApiRuntime': {
      requestUserApiMusicUrl: async(id, _music, quality, _cancel, fallback) => {
        calls.push([id, quality, fallback])
        if (id === 'user_api_B') throw Error('unavailable')
        return { url: `https://fixture/${quality}/${id}`, type: quality }
      },
    },
  }, { global: { i18n: { t: key => key } } })
  const h = await createHarness({
    url: async args => {
      options.push(args.urlSourceOrder)
      return (await priority.getMusicUrlByPriority({ ...args, allowQualityFallback: false })).url
    },
  })
  const [id] = await h.api.addTasks([track()], 'flac24bit')
  await flush()
  assert.deepEqual(calls.map(([source, quality]) => [source, quality]), [
    ['user_api_A', 'flac'], ['user_api_B', 'flac'],
    ['user_api_A', '320k'], ['user_api_B', '320k'], ['user_api_A', '128k'],
  ])
  assert.ok(calls.every(([, , fallback]) => fallback === false))
  assert.deepEqual(options, ['sourceOnly', 'sourceOnly', 'sourceOnly'])
  assert.equal(probes.length, 3)
  assert.equal(h.api.getDownloadTaskItem(id).quality, '128k')
  assert.equal(h.enqueued[0].fileName, 'bounded.m4a')
  const saved = (await h.data.getDownloadActiveTasks())[0]
  assert.equal(saved.requestedQuality, 'flac')
  assert.equal(saved.quality, '128k')
  h.emit({ taskId: id, nativeId: 'work-1', status: 'completed', downloaded: aac.contentLength, total: aac.contentLength, filePath: 'content://fixture/bounded.m4a' })
  await flush(); await h.run(250)
  const history = await h.api.getDownloadList()
  assert.equal(history[0].quality, '128k')
  assert.equal(history[0].id, id)
  assert.equal((await h.api.addTasks([track()], 'flac24bit')).length, 0)
})

test('the playback standard-only setting does not lower explicit downloads in either route', async() => {
  for (const mode of ['account', 'source']) {
    const requests = []
    const h = await createHarness({
      downloadSettings: { 'download.urlSource': mode, 'player.noVipStandardQuality': true },
      url: async args => { requests.push([args.quality, args.urlSourceOrder]); return 'https://fixture/audio' },
    })
    await h.api.addTasks([track()], 'flac24bit'); await flush()
    assert.deepEqual(requests, [['flac', mode === 'account' ? 'accountFirst' : 'sourceOnly']])
  }
})

test('128k failure stops after one tier', async() => {
  const calls = []
  const h = await createHarness({ url: async args => { calls.push(args.quality); throw Error('all sources unavailable') } })
  const [id] = await h.api.addTasks([track()], '128k'); await flush()
  assert.deepEqual(calls, ['128k'])
  assert.equal(h.api.getDownloadTaskItem(id).status, 'error')
  assert.equal(h.enqueued.length, 0)
})

test('pause during a failed high-tier resolution prevents lower-tier requests', async() => {
  const gate = deferred(); const calls = []
  const h = await createHarness({ url: args => { calls.push(args.quality); return gate.promise } })
  const [id] = await h.api.addTasks([track()], '320k'); await flush()
  await h.api.pauseTask(id)
  gate.reject(Error('unavailable')); await flush()
  assert.deepEqual(calls, ['320k'])
  assert.equal(h.api.getDownloadTaskItem(id).status, 'pause')
  assert.equal(h.enqueued.length, 0)
})

test('downgrading clears incompatible partial bytes; retry can use the original bounded tier', async() => {
  let highAvailable = false
  const calls = []
  const h = await createHarness({
    url: async args => {
      calls.push(args.quality)
      if (args.quality === '320k' && !highAvailable) throw Error('high unavailable')
      return accept(args, args.quality === '320k' ? mp3 : aac)
    },
  })
  const [id] = await h.api.addTasks([track()], '320k'); await flush()
  assert.equal(h.api.getDownloadTaskItem(id).quality, '128k')
  await h.api.pauseTask(id)
  const partial = `/private/downloads/${id}.part`
  h.files.add(partial)
  highAvailable = true
  await h.api.retryTask(id); await flush()
  assert.deepEqual(calls, ['320k', '128k', '320k'])
  assert.equal(h.files.has(partial), false)
  assert.equal(h.api.getDownloadTaskItem(id).quality, '320k')
  assert.equal(h.enqueued[1].fileName, 'bounded.mp3')
  assert.equal((await h.data.getDownloadActiveTasks())[0].id, id)
})

test('failure to clear an incompatible partial blocks the new transfer', async() => {
  const value = {
    ...task('partial'),
    musicInfo: track(['128k']),
    quality: '320k',
    requestedQuality: '320k',
    media: { extension: 'mp3', mimeType: 'audio/mpeg', contentLength: mp3.contentLength },
  }
  const h = await createHarness({ active: [value], url: args => accept(args, aac) })
  const partial = '/private/downloads/partial.part'
  h.files.add(partial)
  h.settings.failUnlink = partial
  await h.api.initDownloads(); await flush()
  assert.equal(h.api.getDownloadTaskItem('partial').status, 'error')
  assert.equal(h.enqueued.length, 0)
  assert.equal(h.files.has(partial), true)
})
