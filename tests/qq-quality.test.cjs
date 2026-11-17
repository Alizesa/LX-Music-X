const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./helpers/load.cjs')

const utils = { sizeFormate: bytes => `${bytes}B`, formatPlayTime: () => '04:39' }
const quality = load('src/utils/musicSdk/tx/quality.js', { '../../index': utils })
const track = file => ({ file: { media_mid: 'media', ...file }, mid: 'song', id: 1, title: 'Song', interval: 279, singer: [], album: { name: 'Album', mid: 'album' } })

const parsers = {
  detail: async item => load('src/utils/musicSdk/tx/musicInfo.js', {
    './quality': quality,
    '../../request': { httpFetch: () => ({ promise: Promise.resolve({ body: { code: 0, req: { code: 0, data: { track_info: item } } } }) }) },
    '../../index': utils,
  }).default('song'),
  search: async item => load('src/utils/musicSdk/tx/musicSearch.js', {
    './quality': quality,
    '../../index': utils,
    '../utils': { formatSingerName: () => '' },
    './utils': {},
  }).default.handleResult([item])[0],
  playlist: async item => load('src/utils/musicSdk/tx/songList.js', {
    './quality': quality,
    '../../request': {},
    '../../index': utils,
    '../utils': { formatSingerName: () => '' },
  }).default.filterListDetail([item])[0],
}

for (const [name, parse] of Object.entries(parsers)) {
  test(`QQ ${name} never invents higher quality from omitted size fields`, async() => {
    const info = await parse(track({ size_128mp3: 4481160 }))
    assert.deepEqual(JSON.parse(JSON.stringify(info.types)), [{ type: '128k', size: '4481160B' }])
    assert.deepEqual(Object.keys(info._types), ['128k'])
  })

  test(`QQ ${name} ignores zero, null, negative, nonnumeric and nonfinite sizes`, async() => {
    for (const invalid of [0, '0', null, undefined, -1, '', 'bad', Infinity, 'Infinity', NaN, true]) {
      const info = await parse(track({ size_128mp3: '4481160', size_320mp3: invalid, size_flac: invalid, size_hires: invalid }))
      assert.deepEqual(Object.keys(info._types), ['128k'], `${name}: ${String(invalid)}`)
    }
  })

  test(`QQ ${name} preserves all explicitly available tiers and their sizes`, async() => {
    const info = await parse(track({ size_128mp3: 4481160, size_320mp3: '11202458', size_flac: 36033294, size_hires: 50000000 }))
    assert.deepEqual(Object.keys(info._types), ['128k', '320k', 'flac', 'flac24bit'])
    assert.equal(info._types['320k'].size, '11202458B')
  })
}

test('empty QQ file metadata exposes no proven quality', () => {
  for (const file of [undefined, null, {}]) assert.equal(quality.buildMusicQuality(file).types.length, 0)
})
