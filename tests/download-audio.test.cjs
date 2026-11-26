const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load, deferred, flush } = require('./helpers/load.cjs')
const { createHarness, song, task } = require('./helpers/download-cleanup-runtime.cjs')
const { validateDownloadMedia, inspectDownloadMedia } = load('src/core/downloadAudio.ts', { '@/utils/nativeModules/remoteAudio': {} })
const aac = { readable: true, durationMs: 180000, mime: 'audio/mp4a-latm', headerKind: 'mp4', bitRate: 96000, contentLength: 3413074 }
const resolve = media => async args => {
  const url = 'https://fixture/audio'
  await args.validateUrl(url, media)
  return url
}

test('compressed downloads reject real FLAC, Hi-Res and video tracks', () => {
  for (const quality of ['128k', '320k']) {
    for (const media of [
      { readable: true, mime: 'audio/flac', bitDepth: 16 },
      { readable: true, mime: 'audio/flac', bitDepth: 24 },
      { ...aac, hasVideo: true },
    ]) assert.throws(() => validateDownloadMedia(quality, media), error => error.code === 'quality_mismatch' || error.code === 'not_audio')
  }
})

test('download bitrate checks exclude ID3 artwork and enforce compressed tiers', () => {
  const mp3 = { readable: true, mime: 'audio/mpeg', headerKind: 'mp3', durationMs: 280000, contentLength: 4480000 }
  assert.equal(validateDownloadMedia('128k', mp3).extension, 'mp3')
  assert.equal(validateDownloadMedia('128k', { ...mp3, contentLength: 24480000, audioOffset: 20000000 }).extension, 'mp3')
  assert.throws(() => validateDownloadMedia('128k', { ...mp3, contentLength: 11200000 }), /quality_mismatch/)
  assert.throws(() => validateDownloadMedia('320k', mp3), /quality_mismatch/)
  assert.throws(() => validateDownloadMedia('128k', { ...aac, bitRate: 256000 }), /quality_mismatch/)
})

test('lossless download tiers distinguish standard FLAC from Hi-Res', () => {
  const flac = { readable: true, mime: 'audio/flac', headerKind: 'flac', sampleRate: 44100, bitDepth: 16 }
  assert.equal(validateDownloadMedia('flac', flac).extension, 'flac')
  assert.throws(() => validateDownloadMedia('flac24bit', flac), /quality_mismatch/)
  assert.throws(() => validateDownloadMedia('flac', { ...flac, bitDepth: 24 }), /quality_mismatch/)
  assert.equal(validateDownloadMedia('flac24bit', { ...flac, bitDepth: 24 }).extension, 'flac')
})

test('AAC, Ogg Opus and MP4 codecs keep their actual filename containers', () => {
  assert.equal(validateDownloadMedia('128k', aac).mimeType, 'audio/mp4')
  assert.equal(validateDownloadMedia('128k', { ...aac, mime: 'audio/aac', headerKind: 'unknown' }).extension, 'aac')
  assert.equal(validateDownloadMedia('128k', { ...aac, mime: 'audio/opus', headerKind: 'ogg' }).extension, 'ogg')
  assert.equal(validateDownloadMedia('flac', { readable: true, mime: 'audio/flac', headerKind: 'mp4', bitDepth: 16, sampleRate: 44100 }).extension, 'm4a')
  for (const contentLength of [-1, NaN, Infinity, 0]) assert.equal(validateDownloadMedia('128k', { ...aac, contentLength }).contentLength, undefined)
})

test('QQ cross-platform probes remain cancellable', async() => {
  const gate = deferred()
  const controller = new AbortController()
  let signal
  const helper = load('src/core/downloadAudio.ts', { '@/utils/nativeModules/remoteAudio': { probeRemoteAudio: async(_url, _duration, options) => { signal = options.signal; return gate.promise } } })
  const pending = helper.inspectDownloadMedia(song('cancel'), '128k', 'https://fixture/audio', undefined, controller.signal)
  const rejected = assert.rejects(pending, /取消/)
  controller.abort()
  gate.resolve(aac)
  await rejected
  assert.equal(signal.aborted, true)
})

test('non-QQ downloads check completeness and reuse existing media without extra probes', async() => {
  for (const source of ['kw', 'kg', 'wy', 'mg']) {
    const music = { ...song('other'), source }
    assert.equal((await inspectDownloadMedia(music, '128k', 'https://fixture/audio', aac, new AbortController().signal)).extension, 'm4a')
    await assert.rejects(inspectDownloadMedia(music, '128k', 'https://fixture/ad', { ...aac, durationMs: 12000 }, new AbortController().signal), error => error.code === 'duration_mismatch')
  }
})

test('an already probed replacement is checked against the original OP version duration', async() => {
  const original = { ...song('tx_0027W1wz3eeYtZ'), interval: '01:37' }
  const replacement = { ...aac, durationMs: 280000, bitRate: 320000 }
  await assert.rejects(inspectDownloadMedia(original, '320k', 'https://fixture/replacement', replacement, new AbortController().signal), error => error.code === 'duration_mismatch')
})

test('matching text tags cannot override a large duration difference and correct versions reuse the existing probe', async() => {
  const original = { ...song('op-version'), name: 'Song (OP ver.1.2)', singer: 'Artist', interval: '01:37' }
  const metadata = { title: original.name, artist: original.singer, album: 'Album' }
  await assert.rejects(inspectDownloadMedia(original, '320k', 'https://fixture/wrong', { ...aac, ...metadata, durationMs: 306155, bitRate: 320000 }, new AbortController().signal), error => error.code === 'duration_mismatch')
  const media = await inspectDownloadMedia(original, '320k', 'https://fixture/correct', { ...aac, ...metadata, durationMs: 97454, bitRate: 320000 }, new AbortController().signal)
  assert.equal(media.extension, 'm4a')
})

test('download diagnostics compare the original song with file tags instead of displaying the original tags twice', async() => {
  const entries = []
  const helper = load('src/core/downloadAudio.ts', {
    '@/utils/nativeModules/remoteAudio': {},
    '@/utils/playbackLog': { playbackLog: (event, fields) => entries.push({ event, data: fields() }) },
  })
  const original = { ...song('op-version'), name: 'Song (OP ver.1.2)', interval: '01:37' }
  const replacement = { ...aac, title: 'Song (Full version)', artist: 'Artist', album: 'Another album', durationMs: 306155, bitRate: 320000 }
  await assert.rejects(helper.inspectDownloadMedia(original, '320k', 'https://fixture/replacement', replacement, new AbortController().signal), /duration_mismatch/)
  assert.equal(entries[0].event, 'download.audio_check')
  assert.equal(entries[0].data.expected.name, original.name)
  assert.equal(entries[0].data.actual.name, replacement.title)
  assert.equal(entries[0].data.actual.album, replacement.album)
  assert.equal(entries[0].data.reason, 'duration_mismatch')
})

test('M4A downloads persist actual media, transfer headers and LOCAL extension', async() => {
  const local = []
  const h = await createHarness({ url: resolve(aac), catalog: { beforeLocal: items => { local.push(...items) } } })
  const [id] = await h.api.addTasks([song('aac')])
  await flush()
  const queued = h.enqueued[0]
  assert.equal(queued.fileName, 'aac.m4a')
  assert.equal(queued.mimeType, 'audio/mp4')
  assert.match(queued.headers['User-Agent'], /Pixel 3/)
  assert.equal(queued.headers['Accept-Encoding'], 'identity')
  assert.equal((await h.data.getDownloadActiveTasks())[0].media.contentLength, aac.contentLength)
  h.files.add('content://fixture/aac.m4a')
  h.emit({ taskId: id, nativeId: 'work-1', status: 'completed', downloaded: aac.contentLength, total: aac.contentLength, filePath: 'content://fixture/aac.m4a' })
  await flush(); await h.run(250)
  assert.equal(h.api.isDownloadCompleted(id), true)
  assert.equal(local[0].meta.ext, 'm4a')
})

test('download completion checks the probed representation length exactly', async() => {
  const h = await createHarness({ url: resolve(aac) })
  const [id] = await h.api.addTasks([song('truncated')])
  await flush()
  const path = 'content://fixture/truncated.m4a'
  h.files.add(path)
  h.emit({ taskId: id, nativeId: 'work-1', status: 'completed', downloaded: aac.contentLength - 1, total: aac.contentLength - 1, filePath: path })
  await flush(); await h.run(250)
  assert.equal(h.api.isDownloadCompleted(id), false)
  assert.equal(h.files.has(path), false)
  assert.equal(h.api.getDownloadTaskItem(id).status, 'error')
})

test('restart finalization uses persisted AAC length rather than MP3 catalog size', async() => {
  const active = {
    ...task('restored'),
    status: 'finalizing',
    filePath: 'content://fixture/restored.m4a',
    media: { extension: 'm4a', mimeType: 'audio/mp4', contentLength: aac.contentLength },
    pendingCompletion: { downloaded: aac.contentLength, total: aac.contentLength },
  }
  active.musicInfo.meta._qualitys['128k'] = { size: '10 MiB' }
  const h = await createHarness({ active: [active] })
  await h.api.initDownloads(); await flush(); await h.run(250)
  assert.equal(h.api.isDownloadCompleted('restored'), true)
  assert.equal(h.urlCalls(), 0)
})

for (const deleteFile of [false, true]) {
  test(`M4A download-page deletion permits a clean re-add, delete file: ${deleteFile}`, async() => {
    const h = await createHarness({ url: resolve(aac) })
    const music = song('repeat')
    const [id] = await h.api.addTasks([music])
    await flush()
    const path = 'content://fixture/repeat.m4a'
    h.files.add(path)
    h.emit({ taskId: id, nativeId: 'work-1', status: 'completed', downloaded: aac.contentLength, total: aac.contentLength, filePath: path })
    await flush(); await h.run(250)
    await h.api.removeTasks([id], deleteFile)
    assert.equal(h.api.isDownloadCompleted(id), false)
    assert.equal(h.files.has(path), !deleteFile)
    h.files.add(`/private/downloads/${id}.part`)
    assert.deepEqual(Array.from(await h.api.addTasks([music])), [id])
    await flush()
    assert.equal(h.enqueued.length, 2)
    assert.equal(h.enqueued[1].fileName, 'repeat.m4a')
    assert.equal(h.files.has(`/private/downloads/${id}.part`), false)
  })
}

test('unconfirmed bitrate or FLAC resolution cannot silently claim a download tier', () => {
  assert.throws(() => validateDownloadMedia('128k', { readable: true, mime: 'audio/mp4a-latm' }), /bitrate_unavailable/)
  assert.throws(() => validateDownloadMedia('flac', { readable: true, mime: 'audio/flac' }), /quality_mismatch/)
})
