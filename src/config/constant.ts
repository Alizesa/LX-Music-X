import { type SearchType } from '@/store/search/state'

export const HEADER_HEIGHT = 42
export const LIST_ITEM_HEIGHT = 54
export const LIST_SCROLL_POSITION_KEY = '__LIST_SCROLL_POSITION_KEY__'

export const SPLIT_CHAR = {
  DISLIKE_NAME: '@',
  DISLIKE_NAME_ALIAS: '#',
} as const

/**
 * 列表 id。只剩这三个 + 自建列表（userList）：
 * 「试听列表」和本地「我的收藏」已经没有界面也没人写了，整套跟着拆掉；
 * LOCAL 不能动 —— 下载完成写的就是它，本地文件优先播放和「我的 → 本地歌曲」都靠它。
 */
export const LIST_IDS = {
  LOCAL: 'local',
  PLAY_QUEUE: 'play_queue',
  TEMP: 'temp',
  DOWNLOAD: 'download',
  PLAY_LATER: null,
} as const

/** 「每日推荐」写进临时列表时用的来源标记（自动续播靠它认出推荐列表） */
export const QQ_DAILY_RECOMMEND_ID = 'qq_daily_recommend'
/**
 * 每日推荐的播放队列自己的来源标记。
 * 其它虚拟列表（排行榜/歌单/歌手）都是往临时列表里放、队列打的也是 temp，
 * 只有推荐队列用这个专属标记，切到别的歌单后回来才认得出「刚才那条是推荐队列」。
 */
export const QQ_DAILY_RECOMMEND_QUEUE_SOURCE = 'qq_daily_recommend_queue'

// export const COMPONENT_IDS = {
//   home: 'home',
//   playDetail: 'playDetail',
// } as const
// export type COMPONENT_IDS_TYPE = keyof typeof COMPONENT_IDS
export enum COMPONENT_IDS {
  home = 'home',
  playDetail = 'playDetail',
  songlistDetail = 'songlistDetail',
  singerDetail = 'singerDetail',
  albumDetail = 'albumDetail',
  comment = 'comment',
  // 原来占 pager 页的四个页面，现在改成推入式页面，需要各自登记 id ——
  // Home 的返回键处理靠 componentIds 的条目数判断「上面有没有压着详情页」
  search = 'search',
  setting = 'setting',
  download = 'download',
  playHistory = 'playHistory',
  // QQ 歌单（含「我喜欢」dirid=201）。走自己的取歌通道，不复用多源的 SonglistDetail
  qqPlaylist = 'qqPlaylist',
  localSongs = 'localSongs',
}

export enum NAV_SHEAR_NATIVE_IDS {
  playDetail_pic = 'playDetail_pic',
  playDetail_header = 'playDetail_header',
  // playDetail_pageIndicator = 'playDetail_pageIndicator',
  playDetail_player = 'playDetail_player',
  songlistDetail_pic = 'songlistDetail_pic',
  songlistDetail_title = 'songlistDetail_title',
  singerDetail_pic = 'singerDetail_pic',
  albumDetail_pic = 'albumDetail_pic',
}


export const storageDataPrefix = {
  setting: '@setting_v1',
  userList: '@user_list',
  viewPrevState: '@view_prev_state',

  list: '@list__',
  listScrollPosition: '@list_scroll_position',

  lyric: '@lyric__',
  musicUrl: '@music_url__',
  musicOtherSource: '@music_other_source__',
  playInfo: '@play_info',

  syncAuthKey: '@sync_auth_key',
  syncHost: '@sync_host',
  syncHostHistory: '@sync_host_history',

  openStoragePath: '@open_storage_path',
  selectedManagedFolder: '@selected_managed_folder',
  downloadTasks: '@download_tasks',
  downloadPath: '@download_path',
  playQueue: '@play_queue',
  tempListMeta: '@temp_list_meta',
  playHistory: '@play_history',
  notificationTipEnable: '@notification_tip_enable',
  ignoringBatteryOptimizationTipEnable: '@ignoring_battery_optimization_tip_enable',

  searchHistoryList: '@search_history_list',
  listUpdateInfo: '@list_update_info',
  ignoreVersion: '@ignore_version',
  ignoreVersionFailTipTimeKey: '@ignore_version_fail_tip_time',
  leaderboardSetting: '@leaderboard_setting',
  songListSetting: '@songist_setting',
  searchSetting: '@search_setting',

  fontSize: '@font_size',

  theme: '@theme',

  cheatTip: '@cheat_tip',
  remoteLyricTip: '@remote_lyric_tip',

  dislikeList: '@dislike_list',

  userApi: '@user_api__',
  qqMusicCookie: '@qq_music_cookie',
  qqMusicUser: '@qq_music_user',
  qqMusicPlaylists: '@qq_music_playlists',
  qqMusicDailyRecommend: '@qq_music_daily_recommend',
  // 注意与上面的区分：qqMusicDailyRecommend 存的是「猜你喜欢」电台的结果
  // (get_radio_track)，这里存的才是真正的每日推荐歌单 (CgiGetDiss dirid=202)
  qqMusicDailyPlaylist: '@qq_music_daily_playlist',
  // 每日推荐播到哪了。只记歌 id：恢复时按 id 在当前列表里找位置，
  // 歌单换了/歌没了自然就退回开头
  qqMusicDailyPosition: '@qq_music_daily_position',
  // 「我喜欢」的全量歌曲。获取要翻好几页，缓存下来供心形状态和歌单页直接读，
  // 只有手动下拉刷新才重新拉
  qqMusicLikedSongs: '@qq_music_liked_songs',
  // 各个歌单的歌曲，按歌单 id 存。只留最近打开的几个（见 core/qqMusicPlaylistSongsCache）
  qqMusicPlaylistSongs: '@qq_music_playlist_songs',
  qqMusicRecommendPlaylists: '@qq_music_recommend_playlists',
  qqMusicRecommendSession: '@qq_music_recommend_session',
} as const

// v0.x.x 版本的 data keys
export const storageDataPrefixOld = {
  setting: '@setting',
  list: '@list__',
  listPosition: '@listposition__',
  listSort: '@listsort__',
  // lyric: '@lyric__',
  // musicUrl: '@music_url__',
  playInfo: '@play_info',
  syncAuthKey: '@sync_auth_key',
  syncHost: '@sync_host',
  syncHostHistory: '@sync_host_history',
  notificationTipEnable: '@notification_tip_enable',
} as const

export const APP_PROVIDER_NAME = 'io.github.alizesa.lxmusicx.provider'


// 底部导航栏只剩「首页」和「我的」两个 tab。
// 图标用 Ionicons（icomoon 里没有首页/用户这类字形），选中态用实心、未选中用描边。
export const NAV_MENUS = [
  { id: 'nav_home', icon: 'home', outlineIcon: 'home-outline' },
  { id: 'nav_mine', icon: 'person', outlineIcon: 'person-outline' },
] as const

// 页面 id 全集。除两个 tab 外的 id 属于未清理干净的旧页面：
// 搜索/设置/下载/播放历史已经改成推入式页面（不再占 pager 页），
// 歌单/排行榜/我的列表会在后续清理中删掉，届时这里只剩 nav_home / nav_mine。
export type NAV_ID_Type =
  | 'nav_home'
  | 'nav_mine'
  | 'nav_search'
  | 'nav_songlist'
  | 'nav_top'
  | 'nav_love'
  | 'nav_qq'
  | 'nav_download'
  | 'nav_setting'
  | 'nav_history'

export const LXM_FILE_EXT_RXP = ['json', 'lxmc', 'bin']
export const USER_API_SOURCE_FILE_EXT_RXP = ['js']

export const MUSIC_TOGGLE_MODE = {
  listLoop: 'listLoop', // 列表循环
  random: 'random', // 列表随机
  list: 'list', // 顺序播放
  singleLoop: 'singleLoop', // 单曲循环
  none: 'none', // 禁用
} as const

// 播放详情页的模式按钮只在这三种之间循环。
// 顺序播放(list)与禁用(none)引擎仍然支持，只是不再出现在这个循环里 ——
// 早先设置过这两种的话，点一下按钮就会回到列表循环。
export const MUSIC_TOGGLE_MODE_LIST = [
  MUSIC_TOGGLE_MODE.listLoop,
  MUSIC_TOGGLE_MODE.singleLoop,
  MUSIC_TOGGLE_MODE.random,
] as const

export const DEFAULT_SETTING = {
  leaderboard: {
    source: 'kw' as LX.OnlineSource,
    boardId: 'kw__16',
  },

  songList: {
    source: 'kw' as LX.OnlineSource,
    sortId: 'new',
    tagName: '',
    tagId: '',
  },

  search: {
    temp_source: 'kw' as LX.OnlineSource,
    source: 'all' as LX.OnlineSource | 'all',
    type: 'music' as SearchType,
  },

  viewPrevState: {
    id: 'nav_home' as NAV_ID_Type,
    // query: {},
  },
}
