import { useEffect, useState } from 'react'
import Lyric, { type Lines } from 'lrc-file-parser'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'

export type Line = Lines[number]
type PlayHook = (line: number, text: string) => void
type SetLyricHook = (lines: Lines) => void

const EMPTY_LINES: Lines = []
const EMPTY_LINE = { line: -1, text: '' }
const playHooks = new Set<PlayHook>()
const setLyricHooks = new Set<SetLyricHook>()
let parser: Lyric | null = null
let currentLines = EMPTY_LINES
let currentLine = EMPTY_LINE
let lyricText = ''
let translationText = ''
let romaText = ''
let showTranslation = false
let showRoma = false
let playing = false
let observing = false
let parsed = false
let revision = 0
let position = 0
let positionAt = 0
let rate = 1
let readPosition: (() => Promise<number>) | undefined

const currentPosition = () => position + (playing ? Math.max(0, Date.now() - positionAt) * rate : 0)
const getParser = () => {
  parser ??= new Lyric({
    offset: 100,
    onPlay(line, text) {
      currentLine = { line, text }
      for (const hook of playHooks) hook(line, text)
    },
    onSetLyric(lines) {
      currentLines = lines.length ? lines : EMPTY_LINES
      currentLine = EMPTY_LINE
      for (const hook of playHooks) hook(-1, '')
      for (const hook of setLyricHooks) hook(currentLines)
    },
  })
  return parser
}
const ensureParsed = () => {
  if (parsed) return
  parsed = true
  const extended: string[] = []
  if (showTranslation && translationText) extended.push(translationText)
  if (showRoma && romaText) extended.push(romaText)
  getParser().setLyric(lyricText, extended)
}
const clearParsed = () => {
  parser?.pause()
  parser?.setLyric('', [])
  parsed = false
  currentLines = EMPTY_LINES
  currentLine = EMPTY_LINE
}
const applyPosition = (time: number) => {
  position = Math.max(0, time)
  positionAt = Date.now()
  ensureParsed()
  getParser().play(position)
  if (!playing) getParser().pause()
}
const syncPosition = async() => {
  if (!observing) return
  const generation = ++revision
  let time: number
  try { time = readPosition ? await readPosition() : currentPosition() } catch { time = currentPosition() }
  if (!observing || generation !== revision) return
  applyPosition(Number.isFinite(time) ? time : currentPosition())
}
const updateObservation = () => {
  const active = playHooks.size + setLyricHooks.size > 0
  if (active === observing) return
  observing = active
  revision++
  if (active) {
    ensureParsed()
    void syncPosition()
  } else {
    // 没有 UI 消费者时只留原文与播放时钟；桌面/蓝牙歌词由原生层独立处理。
    clearParsed()
  }
}
const rebuild = () => {
  const time = currentPosition()
  revision++
  parsed = false
  if (observing) applyPosition(time)
  else clearParsed()
}

/** readCurrentPosition 返回音频位置（毫秒），只在页面重新订阅时校准。 */
export const init = async(readCurrentPosition?: () => Promise<number>) => {
  readPosition = readCurrentPosition
  getParser().setPlaybackRate(rate)
}

export const setLyric = (lyric: string, translation = '', romalrc = '') => {
  revision++
  playing = false
  position = 0
  positionAt = Date.now()
  lyricText = lyric
  translationText = translation
  romaText = romalrc
  parsed = false
  if (observing) {
    ensureParsed()
    // 暂停后才收到歌词时不会再有 play 事件，也需要校准并显示当前句。
    if (currentLines.length) void syncPosition()
  } else clearParsed()
}
export const setPlaybackRate = (playbackRate: number) => {
  position = currentPosition()
  positionAt = Date.now()
  revision++
  rate = playbackRate
  getParser().setPlaybackRate(playbackRate)
  if (observing && currentLine.line < 0) void syncPosition()
}
export const toggleTranslation = (show: boolean) => {
  if (showTranslation === show) return
  showTranslation = show
  rebuild()
}
export const toggleRoma = (show: boolean) => {
  if (showRoma === show) return
  showRoma = show
  rebuild()
}
export const play = (time: number) => {
  revision++
  position = time
  positionAt = Date.now()
  playing = true
  if (observing) applyPosition(time)
}
export const pause = () => {
  position = currentPosition()
  positionAt = Date.now()
  revision++
  playing = false
  parser?.pause()
  if (observing && currentLine.line < 0) void syncPosition()
}

export const useLrcPlay = (autoUpdate = true) => {
  const visible = useScreenVisible()
  const [info, setInfo] = useState(currentLine)
  useEffect(() => {
    if (!visible) setInfo(EMPTY_LINE)
    if (!autoUpdate || !visible) return
    const reset: SetLyricHook = () => { setInfo(EMPTY_LINE) }
    const update: PlayHook = (line, text) => { setInfo({ line, text }) }
    setLyricHooks.add(reset)
    playHooks.add(update)
    updateObservation()
    setInfo(currentLine)
    return () => {
      setLyricHooks.delete(reset)
      playHooks.delete(update)
      updateObservation()
    }
  }, [autoUpdate, visible])
  return info
}

export const useLrcSet = () => {
  const visible = useScreenVisible()
  const [lines, setLines] = useState<Lines>(visible ? currentLines : EMPTY_LINES)
  useEffect(() => {
    if (!visible) { setLines(EMPTY_LINES); return }
    setLyricHooks.add(setLines)
    updateObservation()
    setLines(currentLines)
    return () => {
      setLyricHooks.delete(setLines)
      updateObservation()
    }
  }, [visible])
  return lines
}

