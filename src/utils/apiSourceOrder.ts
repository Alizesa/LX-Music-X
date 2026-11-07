/** 设置仍使用扁平的基本类型，以兼容现有备份和设置合并。[] 表示明确取消全部音源。 */
export const parseApiSourceOrder = (value: string, legacyId: string): string[] => {
  if (value) {
    try {
      const ids: unknown = JSON.parse(value)
      if (Array.isArray(ids)) return [...new Set(ids.filter((id): id is string => typeof id == 'string' && id.startsWith('user_api')))]
    } catch {}
  }
  return typeof legacyId == 'string' && legacyId.startsWith('user_api') ? [legacyId] : []
}
