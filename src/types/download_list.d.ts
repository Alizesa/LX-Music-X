
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

    interface DownloadDirectory {
      uri: string
      name: string
    }
  }
}
