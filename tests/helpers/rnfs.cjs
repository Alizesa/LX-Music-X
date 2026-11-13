const fs = require('node:fs')
const vm = require('node:vm')
const { transformSync } = require('@babel/core')
const { deferred } = require('./load.cjs')

const filename = require.resolve('react-native-fs/FS.common.js')
const code = transformSync(fs.readFileSync(filename, 'utf8'), {
  filename,
  babelrc: false,
  configFile: false,
  plugins: ['@babel/plugin-transform-flow-strip-types'],
}).code

// Execute the installed dependency, including postinstall patches. Only the
// native bridge and event transport are controlled; no network or file writes.
const rnfsHarness = () => {
  const listeners = new Set(); const jobs = new Map(); const stops = []
  let startError
  class NativeEventEmitter {
    addListener(event, listener) {
      const entry = { event, listener }
      listeners.add(entry)
      return { remove() { listeners.delete(entry) } }
    }
  }
  const manager = {
    downloadFile(options) {
      if (startError) throw startError
      const gate = deferred()
      jobs.set(options.jobId, { options, ...gate })
      return gate.promise
    },
    stopDownload(jobId) { stops.push(jobId) },
  }
  const loaded = { exports: {} }
  vm.runInNewContext(code, {
    module: loaded,
    exports: loaded.exports,
    Function,
    require: name => name === 'react-native'
      ? { NativeModules: { RNFSManager: manager }, NativeEventEmitter, Platform: { OS: 'android' } }
      : require(name),
  }, { filename })
  return {
    rnfs: loaded.exports,
    listeners,
    jobs,
    stops,
    failStart: error => { startError = error },
    emit(event, data) { for (const entry of [...listeners]) if (entry.event === event) entry.listener(data) },
    start(options = {}) {
      return loaded.exports.downloadFile({ fromUrl: 'https://download.test/file', toFile: '/fixture/file', ...options })
    },
  }
}

module.exports = { rnfsHarness }
