import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated } from 'react-native'


const ANIMATION_DURATION = 800

export const useAnimateColor = (color: string) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anim = useMemo(() => new Animated.Value(0), [color])
  const [finished, setFinished] = useState(true)
  const currentColor = useRef(color)
  const nextColor = useMemo(() => color, [color])

  const animColor = useMemo(() => anim.interpolate({
    inputRange: [0, 1],
    outputRange: [currentColor.current, nextColor],
  }), [anim, nextColor])

  useEffect(() => {
    if (currentColor.current === nextColor) return
    setFinished(false)
    let cancelled = false
    const animation = Animated.timing(anim, {
      toValue: 1,
      duration: ANIMATION_DURATION,
      useNativeDriver: false,
    })
    animation.start(({ finished }) => {
      if (cancelled || !finished) return
      setFinished(true)
    })
    currentColor.current = nextColor
    return () => { cancelled = true; animation.stop() }
  }, [anim, nextColor])

  return [animColor, finished] as const
}
