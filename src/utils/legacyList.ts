/** 旧版收藏在线歌单时生成的本地副本；按来源识别，不按用户可修改的名称识别。 */
export const isLegacyCollectedList = (info: unknown) => {
  if (!info || typeof info !== 'object') return false
  const { source, sourceListId } = info as { source?: unknown, sourceListId?: unknown }
  return typeof source === 'string' && !!source.trim() && (
    (typeof sourceListId === 'string' && !!sourceListId.trim()) ||
    (typeof sourceListId === 'number' && Number.isFinite(sourceListId) && sourceListId > 0)
  )
}

/** 已移除的内置列表，以及新版改由在线账号管理的歌单副本。 */
export const isRemovedUserList = (info: unknown) => {
  if (!info || typeof info !== 'object') return false
  const { id } = info as { id?: unknown }
  return id === 'default' || id === 'love' || isLegacyCollectedList(info)
}
