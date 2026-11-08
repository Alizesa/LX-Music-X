import { requestMsg } from './message'
import { bHh } from './musicSdk/options'
import { deflateRaw } from 'pako'
import { createFetchData } from './httpRequest'

const regx = /(?:\d\w)+/g
const fetchData = createFetchData({
  defaults: { cache: 'no-store' },
  prepare: async(url, options) => {
    const { headers } = options
    if (headers[bHh]) {
      let name = Buffer.from(bHh, 'hex').toString()
      name = name.replace(name.substr(-1), '')
      name = Buffer.from(name, 'base64').toString()
      const version = process.versions.app.split('-')
      const value = version[0].split('.').map(n => n.length < 3 ? n.padStart(3, '0') : n).join('')
      const data = Buffer.from(JSON.stringify((url + value).match(regx), null, 1).concat(value)).toString('base64')
      headers[name] = !name || Buffer.from(deflateRaw(data)).toString('hex') + '&' + parseInt(value) + (version[1] || '')
      delete headers[bHh]
    }
    return options
  },
})

/** @param {string} url @param {Record<string, any>} [options] */
export const httpFetch = (url, options = { method: 'get' }) => {
  const requestObj = fetchData(url, options)
  return {
    promise: requestObj.request.catch(err => {
      switch (err.message) {
        case 'socket hang up': throw new Error(requestMsg.unachievable)
        case 'Aborted': throw new Error(requestMsg.timeout)
        case 'Network request failed': throw new Error(requestMsg.notConnectNetwork)
        default: throw err
      }
    }),
    cancelHttp: requestObj.abort,
  }
}

export const httpGet = (url, options, callback) => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const requestObj = fetchData(url, { ...options, method: 'get' })
  requestObj.request.then(resp => { callback(null, resp, resp.body) }).catch(err => { callback(err, null, null) })
  return requestObj.abort
}

export const checkUrl = async(url, options = {}) => {
  const response = await fetchData(url, { method: 'head', ...options }).request
  if (response.statusCode !== 200) throw new Error(response.statusCode)
}
