import BackgroundTimer from 'react-native-background-timer'

const defaultHeaders = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}

const prepareOptions = ({ method = 'get', headers = {}, format, ...options }) => {
  headers = { ...defaultHeaders, ...headers }
  const contentTypeKey = Object.keys(headers).find(key => key.toLowerCase() === 'content-type')
  if (method.toLowerCase() === 'post') {
    if (options.form) {
      if (!contentTypeKey) headers['Content-Type'] = 'application/x-www-form-urlencoded'
      options.body = Object.entries(options.form).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&')
      delete options.form
    } else if (options.formData) {
      const data = options.formData
      if (data instanceof global.FormData) options.body = data
      else {
        const body = new global.FormData()
        for (const [key, value] of Object.entries(data)) body.append(key, value)
        options.body = body
      }
      // multipart 的 boundary 由原生 FormData 生成。
      delete options.formData
    } else if (!contentTypeKey) headers['Content-Type'] = 'application/json'
  }
  if (headers[contentTypeKey ?? 'Content-Type'] === 'application/json' && options.body) options.body = JSON.stringify(options.body)
  return { ...options, method, headers }
}

const blobToBuffer = (blob) => new Promise((resolve, reject) => {
  const reader = new global.FileReader()
  reader.onerror = reject
  reader.onload = () => {
    const data = reader.result.slice(reader.result.indexOf('base64,') + 7)
    resolve(Buffer.from(data, 'base64'))
  }
  reader.readAsDataURL(blob)
})

/** 共用请求、超时和响应解析；调用方只提供各自的默认项及音源签名处理。 */
export const createFetchData = ({ timeout: defaultTimeout = 15000, defaults = {}, prepare = async(url, options) => options } = {}) =>
  (url, { timeout = defaultTimeout, ...options } = {}) => {
    const controller = new global.AbortController()
    const timer = BackgroundTimer.setTimeout(() => { controller.abort() }, timeout)
    const request = Promise.resolve().then(async() => {
      const prepared = await prepare(url, prepareOptions({ ...defaults, ...options }))
      if (controller.signal.aborted) throw new Error('Aborted')
      const response = await global.fetch(url, { ...prepared, signal: controller.signal })
      let body
      if (prepared.binary) body = await blobToBuffer(await response.blob())
      else {
        body = await response.text()
        try { body = JSON.parse(body) } catch {}
      }
      return {
        headers: response.headers.map,
        body,
        statusCode: response.status,
        statusMessage: response.statusText,
        url: response.url,
        ok: response.ok,
      }
    }).finally(() => { BackgroundTimer.clearTimeout(timer) })
    return { request, abort: () => { controller.abort() } }
  }
