declare namespace LX {
  namespace ConfigFile {
    interface MyListInfoPart {
      type: 'playListPart_v2'
      /** 单个列表的导出/导入载荷。内置列表拆完后只剩自建列表这一种 */
      data: LX.List.UserListInfoFull
    }

  }
}
