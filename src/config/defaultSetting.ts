const defaultSetting: LX.AppSetting = {
  version: '2.0',
  // 默认关闭：检查的是上游官方发布，与本分支构建无关（详见「关于」里的说明）
  'version.autoCheckUpdate': false,
  'common.isAutoTheme': false,
  'common.langId': null,
  'common.apiSource': '',
  'common.sourceNameType': 'alias',
  'common.shareType': 'system',
  'common.isAgreePact': false,
  'common.autoHidePlayBar': true,
  'common.drawerLayoutPosition': 'left',
  'common.homePageScroll': true,
  // 默认关闭：不用底栏拖进度时，那一行整行都可以点开播放详情（见 PlayInfo.tsx）
  'common.allowProgressBarSeek': false,
  'common.showBackBtn': false,
  'common.showExitBtn': true,
  'common.useSystemFileSelector': true,
  'common.alwaysKeepStatusbarHeight': false,

  'player.startupAutoPlay': false,
  'player.startupPushPlayDetailScreen': false,
  'player.togglePlayMethod': 'listLoop',
  'player.playQuality': '128k',
  'player.isSavePlayTime': false,
  'player.isSavePlayHistory': true,
  'player.playHistoryMaxCount': 300,
  'player.volume': 1,
  'player.playbackRate': 1,
  'player.cacheSize': '1024',
  'player.timeoutExit': '',
  'player.timeoutExitPlayed': true,
  'player.isAutoCleanPlayedList': false,
  'player.isHandleAudioFocus': true,
  'player.isEnableAudioOffload': true,
  'player.isShowLyricTranslation': false,
  'player.isShowLyricRoma': false,
  'player.isShowNotificationImage': true,
  'player.isS2t': false,
  'player.isShowBluetoothLyric': false,
  'player.isShowBluetoothFullLyric': false,

  // 'playDetail.isZoomActiveLrc': false,
  // 'playDetail.isShowLyricProgressSetting': false,
  'playDetail.style.align': 'left',
  // 歌词颜色两项：null = 跟随主题（跟改之前一模一样）。自定义背景图把歌词盖住时，
  // 可以在播放器设置里换成固定颜色
  'playDetail.style.lyricColor': null,
  'playDetail.style.lyricActiveColor': null,
  // 未播放歌词的不透明度，60 就是以前写死的那档
  'playDetail.style.lyricOpacity': 60,
  'playDetail.vertical.style.lrcFontSize': 210,
  'playDetail.horizontal.style.lrcFontSize': 220,
  'playDetail.isShowLyricProgressSetting': false,

  'desktopLyric.enable': false,
  'desktopLyric.isLock': false,
  'desktopLyric.width': 100,
  'desktopLyric.maxLineNum': 5,
  'desktopLyric.isSingleLine': false,
  // 竖向显示：每个字上下堆叠成一列，窗口变成窄而高的一条
  'desktopLyric.isVertical': false,
  // 竖排时英文横倒 90°：默认关，关着就是每个字母正着占一行（英文歌建议打开）
  'desktopLyric.verticalRotateLatin': false,
  'desktopLyric.showToggleAnima': true,
  // 默认不画背景框（黑底太扎眼），要的话在设置里选「贴合歌词」
  'desktopLyric.background': 'none',
  'desktopLyric.background.color': 'rgba(0, 0, 0, 1)',
  'desktopLyric.backgroundOpacity': 35,
  'desktopLyric.position.x': 0,
  'desktopLyric.position.y': 0,
  'desktopLyric.textPosition.x': 'left',
  'desktopLyric.textPosition.y': 'top',
  'desktopLyric.style.fontSize': 180,
  'desktopLyric.style.opacity': 50,
  // 上面这项默认值调整的一次性迁移标记（见 config/setting.ts），界面上没有这一项
  'desktopLyric.style.migrated': false,
  'desktopLyric.style.lyricUnplayColor': 'rgba(255, 255, 255, 1)',
  'desktopLyric.style.lyricPlayedColor': 'rgba(7, 197, 86, 1)',
  'desktopLyric.style.lyricShadowColor': 'rgba(0, 0, 0, 0.6)',

  'search.isShowHotSearch': false,
  'search.isShowHistorySearch': false,

  'list.isClickPlayList': false,
  'list.isShowSource': true,
  'list.isShowAlbumName': false,
  'list.isShowInterval': true,
  'list.isSaveScrollLocation': true,
  'list.addMusicLocationType': 'top',

  'download.fileName': '歌名 - 歌手',
  // 独立于 player.playQuality：后者默认 128k，而下载是留档行为
  'download.quality': '320k',

  'sync.enable': false,

  // 'theme.id': 'blue_plus',
  'theme.id': 'green',
  'theme.lightId': 'green',
  'theme.darkId': 'black',
  'theme.hideBgDark': false,
  'theme.dynamicBg': false,
  'theme.fontShadow': false,
  // 自定义背景图（本地路径，空表示没设置）
  'theme.customBgImage': '',
  // 背景遮罩不透明度：动态背景和自定义背景共用，默认与原来写死的 0.76 一致
  'theme.bgOpacity': 0.76,
}


// 使用新年皮肤
if (new Date().getMonth() < 2) {
  defaultSetting['theme.id'] = 'happy_new_year'
  defaultSetting['desktopLyric.style.lyricPlayedColor'] = 'rgba(255, 18, 34, 1)'
}

export default defaultSetting
