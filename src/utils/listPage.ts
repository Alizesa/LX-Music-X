const indexes = new WeakMap<unknown[], { positions: Map<unknown, number>, length: number }>()

/** 页追加只检查本页；索引随所属数组一起回收，恢复的数组只在首次追加时建索引。 */
export const appendListPage = <T>(current: T[], incoming: readonly T[], reset: boolean, key: (item: T) => unknown, replace = false): T[] => {
  const list = reset ? [] : current
  let index = indexes.get(list)
  if (!index || index.length !== list.length) {
    index = { positions: new Map(list.map((item, position) => [key(item), position])), length: list.length }
    indexes.set(list, index)
  }
  for (const item of incoming) {
    const id = key(item)
    const position = index.positions.get(id)
    if (position == null) {
      index.positions.set(id, list.length)
      list.push(item)
    } else if (replace) list[position] = item
  }
  index.length = list.length
  return list
}
