const jsx = (type, props) => ({ type, props })

// Run the real components with controlled effects, visibility and native refs.
const hookHost = () => {
  let current
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    memo: fn => fn,
    forwardRef: fn => fn,
    useState(initial) {
      const frame = current; const index = frame.cursor++
      if (!frame.slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = next => {
          next = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(next, slot.value)) { slot.value = next; frame.dirty = true }
        }
        frame.slots[index] = slot
      }
      const slot = frame.slots[index]
      return [slot.value, slot.set]
    },
    useRef(initial) {
      const frame = current; const index = frame.cursor++
      return frame.slots[index] ??= { current: initial }
    },
    useMemo(fn, deps) {
      const frame = current; const index = frame.cursor++; const old = frame.slots[index]
      if (!old || !same(old.deps, deps)) frame.slots[index] = { value: fn(), deps }
      return frame.slots[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(effect, deps) {
      const frame = current; const index = frame.cursor++; const old = frame.slots[index]
      if (old && same(old.deps, deps)) return
      const slot = { deps }
      frame.slots[index] = slot
      frame.effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() })
    },
    useImperativeHandle(ref, factory, deps) {
      react.useEffect(() => {
        if (!ref) return
        ref.current = factory()
        return () => { ref.current = null }
      }, deps)
    },
  }
  return {
    react,
    visible: () => current.visible,
    frame: () => ({ visible: true, slots: [], connect() {} }),
    render(frame, component) {
      for (let attempt = 0; attempt < 20; attempt++) {
        current = frame
        frame.cursor = 0
        frame.effects = []
        frame.dirty = false
        const tree = component()
        current = null
        frame.connect(tree)
        // React 提交后不会保留已执行 effect 队列；测试宿主也要释放旧依赖和 cleanup。
        const effects = frame.effects
        frame.effects = []
        effects.forEach(effect => effect())
        if (!frame.dirty) return tree
      }
      throw new Error('Render did not settle')
    },
    unmount(frame) { frame.slots.forEach(slot => slot?.cleanup?.()); frame.slots = [] },
  }
}
const elements = (tree, type) => {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, type))
  return [...(tree.type === type ? [tree] : []), ...elements(tree.props?.children, type)]
}

module.exports = { jsx, hookHost, elements }
