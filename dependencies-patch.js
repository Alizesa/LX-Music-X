// 修补依赖源码以使构建的依赖恢复正常工作

const fs = require('node:fs')
const path = require('node:path')

const rootPath = path.join(__dirname, './')

// 通知栏按钮：在「上一首」前面加一个播放模式切换、在「下一首」后面加一个桌面歌词开关。
// node_modules 不入库，只能每次装完依赖后按字符串打补丁；
// JS 侧在 src/plugins/player/utils.ts 的 updateOptions 里传 playModeButton / lyricButton
// 两个开关与对应图标，按钮行为在 src/plugins/player/service.ts 里接管。
const METADATA_MANAGER = path.join(rootPath, 'node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/metadata/MetadataManager.java')
const MEDIA_METADATA_DIR = path.join(rootPath, 'node_modules/react-native-local-media-metadata/android/src/main/java/com/localmediametadata')
const TRACK_PLAYER_DIR = path.join(rootPath, 'node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer')

const patchs = [
  [
    path.join(TRACK_PLAYER_DIR, 'module/MusicModule.java'),
    '    public void isCached(String url, final Promise callback) {',
    `    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, final Promise callback) {
        waitForConnection(() -> binder.getPlayback().preloadMusic(requestId, url, userAgent, maxBytes, callback));
    }

    @ReactMethod
    public void cancelPreloadMusic(String requestId) {
        waitForConnection(() -> binder.getPlayback().cancelPreloadMusic(requestId));
    }

    @ReactMethod
    public void isCached(String url, final Promise callback) {`,
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, final Promise callback) {',
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/ExoPlayback.java'),
    '    public abstract void isCached(String url, Promise promise);',
    `    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise) { promise.resolve(null); }

    public void cancelPreloadMusic(String requestId) {}

    public abstract void isCached(String url, Promise promise);`,
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise)',
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    '    private SimpleCache cache;',
    `    private SimpleCache cache;
    private AudioPreloader audioPreloader;`,
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    '            cache = new SimpleCache(cacheDir, new LeastRecentlyUsedCacheEvictor(cacheMaxSize), db);',
    `            AudioPreloader.awaitRelease();
            cache = new SimpleCache(cacheDir, new LeastRecentlyUsedCacheEvictor(cacheMaxSize), db);
            audioPreloader = new AudioPreloader(cache, cacheMaxSize);`,
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    '    public void isCached(String url, Promise promise) {',
    `    @Override
    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise) {
        if (audioPreloader == null) { promise.resolve(null); return; }
        audioPreloader.preload(requestId, url, userAgent, maxBytes, promise);
    }

    @Override
    public void cancelPreloadMusic(String requestId) {
        if (audioPreloader != null) audioPreloader.cancel(requestId);
    }

    public void isCached(String url, Promise promise) {`,
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise)',
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'module/MusicModule.java'),
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, final Promise callback) {',
    `    public void setPreloadDebugLogging(boolean enabled) {
        com.guichaguri.trackplayer.service.player.PlaybackDebugLogger.setEnabled(getReactApplicationContext(), enabled);
    }

    @ReactMethod
    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, final Promise callback) {`,
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'module/MusicModule.java'),
    '        waitForConnection(() -> binder.getPlayback().preloadMusic(requestId, url, userAgent, maxBytes, callback));',
    `        com.guichaguri.trackplayer.service.player.PlaybackDebugLogger.event(requestId, "received", "", 0, (long) maxBytes, 0);
        waitForConnection(() -> binder.getPlayback().preloadMusic(requestId, url, userAgent, maxBytes, callback));`,
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/ExoPlayback.java'),
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise) { promise.resolve(null); }',
    '    public void preloadMusic(String requestId, String url, String userAgent, double maxBytes, Promise promise) { PlaybackDebugLogger.event(requestId, "unavailable", "unsupported_playback", 0, (long) maxBytes, 0); promise.resolve(null); }',
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    '        if (audioPreloader == null) { promise.resolve(null); return; }',
    '        if (audioPreloader == null) { PlaybackDebugLogger.event(requestId, "unavailable", "cache_not_initialized", 0, (long) maxBytes, 0); promise.resolve(null); return; }',
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    '    public void clearCache(Promise promise) {',
    `    public void clearCache(Promise promise) {
        if (audioPreloader != null) { audioPreloader.clear(promise); return; }`,
  ],
  [
    path.join(TRACK_PLAYER_DIR, 'service/player/LocalPlayback.java'),
    `    public void destroy() {
        super.destroy();`,
    `    public void destroy() {
        super.destroy();
        if (audioPreloader != null) {
            audioPreloader.release();
            audioPreloader = null;
            cache = null;
        }`,
  ],
  [
    path.join(MEDIA_METADATA_DIR, 'MediaFile.java'),
    '      ParcelFileDescriptor parcelFileDescriptor = context.getContentResolver().openFileDescriptor(dFile.getUri(), isWrite ? "rw" : "r");',
    `      // LX: 必须保存到成员字段，closeFile 的 finally 才能及时关闭句柄。
      parcelFileDescriptor = context.getContentResolver().openFileDescriptor(dFile.getUri(), isWrite ? "rw" : "r");`,
  ],
  [
    path.join(MEDIA_METADATA_DIR, 'MediaFile.java'),
    `    } catch (Exception ignored) { closeFile(); }
    return createTempFile();`,
    `    } catch (Exception ignored) {}
    // LX: 权限检查未通过的正常回退同样要关闭句柄。
    closeFile();
    return createTempFile();`,
  ],
  [
    path.join(MEDIA_METADATA_DIR, 'LocalMediaMetadataModule.java'),
    `  @ReactMethod
  public void writeMetadata(String filePath, ReadableMap metadata, boolean isOverwrite, Promise promise) {`,
    `  @ReactMethod
  public void writeTags(String filePath, ReadableMap metadata, String picPath, String lyric, Promise promise) {
    android.os.Bundle values = Arguments.toBundle(metadata);
    AsyncTask.runTask(() -> {
      MetadataWriter.writeTags(reactContext, filePath, values, picPath, lyric);
      return null;
    }, promise);
  }

  @ReactMethod
  public void writeMetadata(String filePath, ReadableMap metadata, boolean isOverwrite, Promise promise) {`,
  ],
  // 1. 两个新按钮的字段 + 记住当前播放状态（updateOptions 重建按钮后要按它重装 mActions）
  [
    METADATA_MANAGER,
    '    private Action previousAction, rewindAction, playAction, pauseAction, stopAction, forwardAction, nextAction;',
    `    private Action previousAction, rewindAction, playAction, pauseAction, stopAction, forwardAction, nextAction;
    // LX: 通知栏的播放模式 / 桌面歌词两个额外按钮
    private Action playModeAction, lyricAction;
    // LX: updateOptions 只重建 Action 对象、不动 builder.mActions，
    // 所以这里记住最后一次 updatePlayback 收到的播放状态，重建后照着再装一遍
    private boolean isPlaying = false;`,
  ],
  // 2. 每次 updateOptions 都先清掉旧按钮，避免本次没开按钮时留着上一次的
  [
    METADATA_MANAGER,
    `        actions = 0;
        compactActions = 0;`,
    `        actions = 0;
        compactActions = 0;
        playModeAction = null;
        lyricAction = null;`,
  ],
  // 3. 按 JS 传来的开关创建这两个按钮。
  // 复用 ACTION_REWIND / ACTION_FAST_FORWARD 这两个媒体键通道（JS 侧收到
  // remote-jump-backward / remote-jump-forward），它们不走 notificationCapabilities，
  // 免得 RNTP 自带的 Rewind / Forward 两个按钮也跟着冒出来。
  [
    METADATA_MANAGER,
    `            nextAction = createAction(notification, PlaybackStateCompat.ACTION_SKIP_TO_NEXT, "Next",
                    getIcon(options, "nextIcon", R.drawable.next));

            // Update the action mask for the compact view`,
    `            nextAction = createAction(notification, PlaybackStateCompat.ACTION_SKIP_TO_NEXT, "Next",
                    getIcon(options, "nextIcon", R.drawable.next));

            // LX: 这两个按钮由下面的开关控制，不看 notificationCapabilities
            List<Integer> lxExtraCaps = new ArrayList<>();
            lxExtraCaps.add((int)PlaybackStateCompat.ACTION_REWIND);
            lxExtraCaps.add((int)PlaybackStateCompat.ACTION_FAST_FORWARD);
            if(options.getBoolean("playModeButton", false)) {
                playModeAction = createAction(lxExtraCaps, PlaybackStateCompat.ACTION_REWIND, "Play Mode",
                        getIcon(options, "playModeIcon", R.drawable.rewind));
            }
            if(options.getBoolean("lyricButton", false)) {
                lyricAction = createAction(lxExtraCaps, PlaybackStateCompat.ACTION_FAST_FORWARD, "Desktop Lyric",
                        getIcon(options, "lyricIcon", R.drawable.forward));
            }

            // Update the action mask for the compact view`,
  ],
  // 4. updateOptions 结尾重新装一遍按钮再刷通知。
  // 不重装的话，切播放模式 / 开关桌面歌词后通知栏里的图标不会变（builder.mActions 里还是旧的）
  [
    METADATA_MANAGER,
    `        session.setRatingType(ratingType);

        updateNotification();
    }`,
    `        session.setRatingType(ratingType);

        updatePlayback(isPlaying);

        updateNotification();
    }`,
  ],
  // 5. 摆放按钮：播放模式在「上一首」前面，并记住播放状态
  [
    METADATA_MANAGER,
    `    public void updatePlayback(boolean playing) {
        List<Integer> compact = new ArrayList<>();
        builder.mActions.clear();

        // Adds the media buttons to the notification

        addAction(previousAction, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS, compact);`,
    `    public void updatePlayback(boolean playing) {
        List<Integer> compact = new ArrayList<>();
        builder.mActions.clear();

        isPlaying = playing;

        // Adds the media buttons to the notification

        // LX: 播放模式按钮在「上一首」前面
        addAction(playModeAction, PlaybackStateCompat.ACTION_REWIND, compact);
        addAction(previousAction, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS, compact);`,
  ],
  // 6. 摆放按钮：桌面歌词开关在「下一首」后面
  [
    METADATA_MANAGER,
    `        addAction(nextAction, PlaybackStateCompat.ACTION_SKIP_TO_NEXT, compact);

        // Prevent the media style from being used in older Huawei devices`,
    `        addAction(nextAction, PlaybackStateCompat.ACTION_SKIP_TO_NEXT, compact);
        // LX: 桌面歌词开关在「下一首」后面
        addAction(lyricAction, PlaybackStateCompat.ACTION_FAST_FORWARD, compact);

        // Prevent the media style from being used in older Huawei devices`,
  ],
  // 6. 兼容已经打过「保留 Target」补丁的 node_modules：恢复成完成后置空。
  // 保留 Target 会让下一次换图时 rm.clear 回收上一张位图，而通知 Builder 仍可能
  // 引用它，Notification.build 缩放时就会抛
  // "cannot use a recycled source in createBitmap"
  [
    METADATA_MANAGER,
    `                        updateNotification();
                        // LX: 保留 Target，换图/销毁时统一 clear
                    }`,
    `                        updateNotification();
                        artworkTarget = null;
                    }`,
  ],
  // 7. 服务销毁时清掉封面请求和持有的位图，避免旧回调/位图继续存活
  [
    METADATA_MANAGER,
    `    public void destroy() {
        service.stopForeground(true);

        session.setActive(false);
        session.release();
    }`,
    `    public void destroy() {
        // LX: 清掉在途的封面请求与持有的位图，避免回调打到已销毁的 service
        if(artworkTarget != null) {
            Glide.with(service.getApplicationContext()).clear(artworkTarget);
            artworkTarget = null;
        }
        prevArtResource = null;
        prevArtwork = null;

        service.stopForeground(true);

        session.setActive(false);
        session.release();
    }`,
  ],
]

// 换行统一成 LF：Windows 上检出的文件可能是 CRLF，而这里比的是整段代码
const toLF = str => str.replace(/\r\n/g, '\n')

;(async() => {
  let failed = false
  for (const [filePath, fromStr, toStr, installedMarker] of patchs) {
    const label = filePath.replace(rootPath, '')
    const from = toLF(fromStr)
    const to = toLF(toStr)
    try {
      const file = toLF(await fs.promises.readFile(filePath, 'utf8'))
      // 先看打过没：重复装依赖时会再打一次，覆盖内容里带着原代码，
      // 不先判重的话会一层层往上叠（字段、局部变量重复声明，直接编译不过）
      if (file.includes(to) || (installedMarker && file.includes(installedMarker))) {
        console.log(`Skipped ${label} (already patched)`)
        continue
      }
      if (!file.includes(from)) throw new Error('未找到要替换的代码，依赖版本可能变了')
      console.log(`Patching ${label}`)
      await fs.promises.writeFile(filePath, file.replace(from, to))
    } catch (err) {
      failed = true
      console.error(`Patch ${label} failed: ${err.message}`)
    }
  }
  if (failed) {
    // 打不上就让构建失败：不然出出来的包少了功能却一路绿灯，很难查
    process.exitCode = 1
    console.error('\nDependencies patch failed.\n')
    return
  }
  try {
    await fs.promises.copyFile(path.join(rootPath, 'patches/MetadataWriter.java'), path.join(MEDIA_METADATA_DIR, 'MetadataWriter.java'))
    await fs.promises.copyFile(path.join(rootPath, 'patches/AudioPreloader.java'), path.join(TRACK_PLAYER_DIR, 'service/player/AudioPreloader.java'))
    await fs.promises.copyFile(path.join(rootPath, 'patches/PlaybackDebugLogger.java'), path.join(TRACK_PLAYER_DIR, 'service/player/PlaybackDebugLogger.java'))
  } catch (error) {
    process.exitCode = 1
    console.error('Installing MetadataWriter failed:', error.message)
    return
  }
  console.log('\nDependencies patch finished.\n')
})()
