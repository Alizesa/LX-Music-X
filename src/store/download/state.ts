export interface DownloadState {
  /** 下载页的合并视图：活跃任务 + 已完成轻量历史 */
  tasks: LX.Download.DownloadListItem[]
}

const state: DownloadState = {
  tasks: [],
}

export default state
