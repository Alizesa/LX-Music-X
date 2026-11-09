const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Run the APK's actual preload script. Observe its Maps without changing its source.
const scriptHarness = () => {
  const maps = []
  const calls = []
  let queue
  const context = vm.createContext({
    console: { log() {} },
    __observeMap: map => { maps.push(map) },
    __lx_native_call__: (_key, action, raw) => {
      const data = JSON.parse(raw)
      calls.push({ action, data })
      if (action === 'request') queue = maps.find(map => map.has(data.requestKey))
    },
  })
  for (const name of ['set_timeout', 'clear_timeout', 'utils_str2b64', 'utils_b642buf', 'utils_str2md5', 'utils_aes_encrypt', 'utils_rsa_encrypt']) {
    context[`__lx_native_call__${name}`] = () => ''
  }
  vm.runInContext(`
    const NativeMap = Map
    globalThis.Map = class extends NativeMap {
      constructor(...args) { super(...args); __observeMap(this) }
    }
  `, context)
  const file = path.join(__dirname, '../../android/app/src/main/assets/script/user-api-preload.js')
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
  context.lx_setup('key', 'source', 'Source', '', '', '', '', '')
  const respond = (requestKey, error = null, body = 'audio') => context.__lx_native__('key', 'response', JSON.stringify({
    requestKey, error, response: { statusCode: 200, statusMessage: 'OK', headers: {}, body },
  }))
  return { context, calls, respond, get queue() { return queue } }
}

module.exports = { scriptHarness }
