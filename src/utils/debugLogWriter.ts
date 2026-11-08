interface LogFiles {
  existsFile: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<{ size: number }>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<unknown>
  appendFile: (path: string, text: string) => Promise<unknown>
  moveFile: (from: string, to: string) => Promise<unknown>
  unlink: (path: string) => Promise<unknown>
}
interface Timers {
  setTimeout: (fn: () => void, delay: number) => number
  clearTimeout: (id: number) => void
}

export const utf8Size = (text: string) => {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** 日志独占两个文件；追加、轮转、读取、清空共用队列，磁盘缓慢时只保留有限的待写记录。 */
export const createDebugLogWriter = (files: LogFiles, timers: Timers, path: string, {
  fileLimit = 1024 * 1024,
  bufferLimit = 64 * 1024,
  delay = 1000,
  onError = (_error: unknown) => {},
} = {}) => {
  const previous = `${path}.1`
  let pending: string[] = []
  let pendingBytes = 0
  let dropped = 0
  let bytes: number | undefined
  let generation = 0
  let timer: number | null = null
  let writing: Promise<void> | null = null
  let io: Promise<unknown> = Promise.resolve()

  const enqueue = async<T>(work: () => Promise<T>): Promise<T> => {
    const result = io.then(work)
    io = result.catch(onError)
    return result
  }
  const clearTimer = () => {
    if (timer != null) timers.clearTimeout(timer)
    timer = null
  }
  const ensure = async() => {
    if (bytes != null) return
    for (const file of [path, previous]) {
      if (!await files.existsFile(file)) { await files.writeFile(file, ''); continue }
      // 文件仅由本模块维护，异常超限时清空，避免一次读入无界文件。
      if ((await files.stat(file)).size > fileLimit) await files.writeFile(file, '')
    }
    // ensure 和所有文件操作只由 io 队列串行调用。
    // eslint-disable-next-line require-atomic-updates
    bytes = (await files.stat(path)).size
  }
  const write = async(lines: string[]) => {
    await ensure()
    let chunk = ''
    let chunkBytes = 0
    const append = async() => {
      if (!chunk) return
      if (bytes! + chunkBytes > fileLimit) {
        if (await files.existsFile(previous)) await files.unlink(previous)
        await files.moveFile(path, previous)
        await files.writeFile(path, '')
        // 轮转期间没有其他写入者。
        // eslint-disable-next-line require-atomic-updates
        bytes = 0
      }
      await files.appendFile(path, chunk)
      bytes = bytes! + chunkBytes
      // chunk 属于本次 write，append 在循环中逐次 await。
      // eslint-disable-next-line require-atomic-updates
      chunk = ''
      chunkBytes = 0
    }
    for (const line of lines) {
      const size = utf8Size(line)
      if (chunkBytes + size > fileLimit) await append()
      chunk += line
      chunkBytes += size
    }
    await append()
  }
  const schedule = () => {
    if (timer != null || writing != null || !pending.length) return
    timer = timers.setTimeout(() => {
      timer = null
      void flush().catch(() => {})
    }, delay)
  }
  const flush = async(): Promise<void> => {
    clearTimer()
    if (writing) await writing.catch(() => {})
    clearTimer()
    if (!pending.length) return
    const lines = pending
    if (dropped) lines.unshift(`${JSON.stringify({ event: 'log.dropped', count: dropped })}\n`)
    pending = []
    pendingBytes = 0
    dropped = 0
    const version = generation
    const current = enqueue(async() => {
      if (version !== generation) return
      try { await write(lines) } catch (error) { bytes = undefined; throw error }
    })
    // 等待已有写入后，同步摘取 pending；后续文件操作仍进入同一个 io 队列。
    // eslint-disable-next-line require-atomic-updates
    writing = current
    try { await current } finally {
      if (writing === current) writing = null
      schedule()
    }
  }
  return {
    append(line: string) {
      const text = `${line}\n`
      const size = utf8Size(text)
      if (size > Math.min(fileLimit, bufferLimit)) { dropped++; return }
      while (pending.length && pendingBytes + size > bufferLimit) {
        pendingBytes -= utf8Size(pending.shift()!)
        dropped++
      }
      pending.push(text)
      pendingBytes += size
      schedule()
    },
    flush,
    async read() {
      await flush()
      return enqueue(async() => {
        await ensure()
        return `${await files.readFile(previous)}${await files.readFile(path)}`
      })
    },
    async clear() {
      clearTimer()
      generation++
      pending = []
      pendingBytes = 0
      dropped = 0
      await enqueue(async() => {
        await files.writeFile(path, '')
        await files.writeFile(previous, '')
        bytes = 0
      })
    },
  }
}
