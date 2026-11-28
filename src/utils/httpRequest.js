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

const parseText = text => { try { return JSON.parse(text) } catch { return text } }

// RN fetch also stores text responses in a native Blob. Consume it exactly once and
// close our reference even if fetch finished just after cancellation or the reader failed.
const readResponseBody = async(response, binary, signal, checkAborted) => {
  if (!binary && typeof response.blob !== 'function') {
    checkAborted()
    const text = await response.text()
    checkAborted()
    return parseText(text)
  }
  const blob = await response.blob()
  let reader; let abort
  try {
    checkAborted()
    reader = new global.FileReader()
    const result = await new Promise((resolve, reject) => {
      abort = () => {
        try { reader.abort() } catch {}
        reject(new Error('Aborted'))
      }
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read response'))
      signal.addEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
      if (binary) reader.readAsDataURL(blob)
      else reader.readAsText(blob, /charset=["']?([a-z0-9_-]+)/i.exec(blob.type)?.[1] ?? 'utf-8')
    })
    checkAborted()
    if (binary) return Buffer.from(result.slice(result.indexOf('base64,') + 7), 'base64')
    return parseText(result)
  } catch (error) {
    checkAborted()
    throw error
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    if (reader) reader.onload = reader.onerror = null
    blob.close?.()
  }
}

/** 共用请求、超时和响应解析；调用方只提供各自的默认项及音源签名处理。 */
export const createFetchData = ({ timeout: defaultTimeout = 15000, defaults = {}, prepare = async(url, options) => options } = {}) =>
  (url, { timeout = defaultTimeout, signal, ...options } = {}) => {
    const controller = new global.AbortController()
    const abort = () => { controller.abort() }
    signal?.addEventListener('abort', abort)
    if (signal?.aborted) abort()
    const checkAborted = () => {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? 'cancelled' : 'Aborted')
    }
    const timer = BackgroundTimer.setTimeout(() => { controller.abort() }, timeout)
    const request = Promise.resolve().then(async() => {
      checkAborted()
      const prepared = await prepare(url, prepareOptions({ ...defaults, ...options }))
      checkAborted()
      const response = await global.fetch(url, { ...prepared, signal: controller.signal })
      const body = await readResponseBody(response, prepared.binary, controller.signal, checkAborted)
      checkAborted()
      return {
        headers: response.headers.map,
        body,
        statusCode: response.status,
        statusMessage: response.statusText,
        url: response.url,
        ok: response.ok,
      }
    }).finally(() => {
      BackgroundTimer.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    })
    return { request, abort }
  }
