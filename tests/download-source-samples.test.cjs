const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, flush } = require('./helpers/load.cjs')
const { createHarness, song } = require('./helpers/download-cleanup-runtime.cjs')

// Only public media metadata from the single-song investigation; no signed URLs, keys or script bodies.
const songMid = '004RsOoP2AyO7J'
const standard = { readable: true, mime: 'audio/mp4a-latm', headerKind: 'mp4', durationMs: 280055.873, bitRate: 95973, sampleRate: 44100, contentLength: 3413074 }
const high = { readable: true, mime: 'audio/mpeg', headerKind: 'mp3', durationMs: 279986.667, bitRate: 320000, sampleRate: 44100, contentLength: 11202458 }
const wrongVersion = { ...standard, durationMs: 306155.102, bitRate: 96010, contentLength: 3732392 }
const unreadableFormat = { readable: true, headerKind: 'unknown', contentLength: 11185987, reason: 'metadata_error' }

for (const hasHighQuality of [true, false]) {
  test(hasHighQuality
    ? 'a real 320k MP3 from the next source wins over an earlier 96kbps AAC without downgrading'
    : 'unreadable, unavailable and wrong-duration sources fail without lowering a 320k download', async() => {
    const calls = []
    const ids = ['hei', 'molan', 'huibq', 'hello'].map(name => `user_api_${name}`)
    const mediaBySource = { hei: standard, molan: hasHighQuality ? high : unreadableFormat, hello: wrongVersion }
    const qq = load('src/core/qqMusicUrl.ts', {
      './qqMusic': {},
      '@/utils/nativeModules/remoteAudio': { probeRemoteAudio: async url => mediaBySource[new URL(url).pathname.slice(1)] },
      'react-native-background-timer': { default: { setTimeout, clearTimeout } },
    })
    const priority = load('src/core/music/sourcePriority.ts', {
      '@/store/setting/state': { default: { setting: { 'common.apiSource': ids[0], 'common.apiSourceOrder': JSON.stringify(ids) } } },
      '@/store/userApi': { state: { list: ids.map(id => ({ id })) } },
      '@/utils/apiSourceOrder': load('src/utils/apiSourceOrder.ts'),
      '@/core/qqMusicUrl': qq,
      '@/core/userApiRuntime': {
        requestUserApiMusicUrl: async(id, _music, quality, _cancel, fallback) => {
          const source = id.replace('user_api_', '')
          calls.push([source, quality, fallback])
          if (source === 'huibq') throw new Error('HTTP 503')
          return { url: `https://fixture/${source}`, type: quality }
        },
      },
    }, { global: { i18n: { t: key => key } } })
    const h = await createHarness({
      probeMusicInfo: async() => ({
        songmid: songMid,
        strMediaMid: '000bYrRA2I7GQ7',
        interval: '04:39',
        types: [{ type: '128k', size: '4.27 MiB' }, { type: '320k', size: '10.68 MiB' }, { type: 'flac', size: '34.36 MiB' }],
      }),
      url: async args => (await priority.getMusicUrlByPriority({ ...args, allowQualityFallback: false })).url,
    })
    const music = { ...song(`tx_${songMid}`), meta: { songId: songMid, _qualitys: {} } }
    const [id] = await h.api.addTasks([music], '320k')
    await flush()
    assert.deepEqual(calls.map(([source, quality]) => [source, quality]), hasHighQuality
      ? [['hei', '320k'], ['molan', '320k']]
      : [['hei', '320k'], ['molan', '320k'], ['huibq', '320k'], ['hello', '320k']])
    assert.ok(calls.every(([, , fallback]) => fallback === false))
    assert.equal(h.api.getDownloadTaskItem(id).quality, '320k')
    if (hasHighQuality) {
      assert.equal(h.enqueued[0].mimeType, 'audio/mpeg')
      assert.ok(h.enqueued[0].fileName.endsWith('.mp3'))
    } else {
      assert.equal(h.api.getDownloadTaskItem(id).status, 'error')
      assert.equal(h.enqueued.length, 0)
    }
    assert.equal((await h.data.getDownloadActiveTasks())[0].requestedQuality, '320k')
  })
}

test('the 306-second AAC returned for the 279-second song fails completeness validation even at standard quality', async() => {
  const qq = load('src/core/qqMusicUrl.ts', {
    './qqMusic': {},
    '@/utils/nativeModules/remoteAudio': { probeRemoteAudio: async() => wrongVersion },
    'react-native-background-timer': { default: { setTimeout, clearTimeout } },
  })
  await assert.rejects(qq.validateQQMusicUrl({ ...song('wrong-version'), interval: '04:39' }, 'https://fixture/wrong-version'), error => error.code === 'duration_mismatch')
})
