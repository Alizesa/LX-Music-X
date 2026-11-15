const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { userApiHarness, song, flush } = require('./user-api.cjs')

const preload = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/script/user-api-preload.js'), 'utf8')

const scopeHarness = async script => {
  const h = await userApiHarness({ autoReply: false, scripts: { user_api_A: { promise: Promise.resolve(script) }, user_api_B: { promise: Promise.resolve(script) } } })
  const environments = new Map(); const timers = new Map(); const events = []
  const pendingSettled = []
  let holdSettled = false
  let loadOffset = 0; let sendOffset = 0; let destroyOffset = 0
  const setup = entry => {
    const context = vm.createContext({
      console: { log() {} },
      __lx_native_call__: (key, action, raw) => {
        const data = JSON.parse(raw)
        events.push({ runtimeId: entry.runtimeId, action, data })
        if (holdSettled && action === 'requestSettled') pendingSettled.push({ runtimeId: entry.runtimeId, data })
        else h.emit(entry.runtimeId, action, data)
      },
      __lx_native_call__set_timeout: (id, delay) => { timers.set(`${entry.runtimeId}:${id}`, { runtimeId: entry.runtimeId, id, delay }) },
      __lx_native_call__clear_timeout: id => { timers.delete(`${entry.runtimeId}:${id}`) },
    })
    for (const name of ['utils_str2b64', 'utils_b642buf', 'utils_str2md5', 'utils_aes_encrypt', 'utils_rsa_encrypt']) context[`__lx_native_call__${name}`] = () => ''
    vm.runInContext(preload, context)
    context.lx_setup('key', entry.info.id, entry.info.name, '', '', '', '', entry.info.script)
    vm.runInContext(entry.info.script, context)
    environments.set(entry.runtimeId, context)
  }
  const pump = async() => {
    for (let guard = 0; guard < 20; guard++) {
      while (destroyOffset < h.destroyed.length) {
        const id = h.destroyed[destroyOffset++]
        environments.delete(id)
        for (const [key, timer] of timers) if (timer.runtimeId === id) timers.delete(key)
      }
      while (loadOffset < h.loads.length) setup(h.loads[loadOffset++])
      while (sendOffset < h.sends.length) {
        const sent = h.sends[sendOffset++]
        environments.get(sent.runtimeId)?.__lx_native__('key', sent.action, JSON.stringify(sent.data))
        await flush()
      }
      await flush()
      if (loadOffset === h.loads.length && sendOffset === h.sends.length && destroyOffset === h.destroyed.length) break
    }
  }
  h.api.setApiSource('user_api_A')
  await flush(); await pump()
  const start = (id, onCancel) => h.runtime.requestUserApiMusicUrl('user_api_A', { ...song, id }, '128k', onCancel)
  const respond = async(index, body = 'https://audio.test/final') => {
    h.http[index].result.resolve({ statusCode: 200, statusMessage: 'OK', headers: {}, body })
    await pump()
  }
  const recover = async() => {
    const [id, callback] = [...h.timers.entries()].at(-1)
    h.timers.delete(id)
    callback()
    await pump()
  }
  const releaseSettled = async() => {
    holdSettled = false
    for (const { runtimeId, data } of pendingSettled.splice(0)) h.emit(runtimeId, 'requestSettled', data)
    await pump()
  }
  return { ...h, environments, scriptTimers: timers, events, pump, start, respond, recover, holdSettled: () => { holdSettled = true }, releaseSettled }
}

module.exports = { scopeHarness }
