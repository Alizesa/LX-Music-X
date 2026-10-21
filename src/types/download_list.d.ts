
// interface DownloadList {

// }


declare namespace LX {
  namespace Download {
    type DownloadTaskStatus = 'resolving'
    | 'run'
    | 'waiting'
    | 'pause'
    | 'finalizing'
    | 'error'
    | 'completed'

    type FileExt = 'mp3' | 'flac' | 'wav' | 'ape'

    interface ProgressInfo {
      progress: number
      speed: string
      downloaded: number
      total: number
    }

    interface DownloadTaskActionBase <A> {
      action: A
    }
    interface DownloadTaskActionData<A, D> extends DownloadTaskActionBase<A> {
      data: D
    }
    type DownloadTaskAction<A, D = undefined> = D extends undefined ? DownloadTaskActionBase<A> : DownloadTaskActionData<A, D>

    type DownloadTaskActions = DownloadTaskAction<'start'>
    | DownloadTaskAction<'complete'>
    | DownloadTaskAction<'refreshUrl'>
    | DownloadTaskAction<'statusText', string>
    | DownloadTaskAction<'progress', ProgressInfo>
    | DownloadTaskAction<'error', {
      error?: string
      message?: string
    }>

    interface ListItem {
      id: string
      isComplate: boolean
      status: DownloadTaskStatus
      statusText: string
      downloaded: number
      total: number
      progress: number
      speed: string
      metadata: {
        musicInfo: LX.Music.MusicInfoOnline
        url: string | null
        quality: LX.Quality
        ext: FileExt
        fileName: string
        filePath: string
      }
    }

    interface saveDownloadMusicInfo {
      list: ListItem[]
      addMusicLocationType: LX.AddMusicLocationType
    }

    interface DownloadTask {
      id: string
      musicInfo: LX.Music.MusicInfoOnline
      quality: LX.Quality
      status: DownloadTaskStatus
      progress: ProgressInfo
      fileName: string
      filePath?: string
      directoryUri: string
      nativeId?: string
      error?: string
      createdAt: number
    }

    /** 已完成任务的轻量记录：只保留展示、删除文件、查重需要的字段 */
    interface DownloadHistoryItem {
      id: string
      name: string
      singer: string
      quality: LX.Quality
      filePath?: string
      createdAt: number
    }

    /** 下载页展示用的合并视图（活跃任务 + 已完成历史） */
    interface DownloadListItem {
      id: string
      status: DownloadTaskStatus
      quality: LX.Quality
      name: string
      singer: string
      filePath?: string
      createdAt: number
      error?: string
      /** 只有活跃任务有 */
      progress?: ProgressInfo
    }

    interface DownloadDirectory {
      uri: string
      name: string
    }
  }
}
