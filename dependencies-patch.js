// 修补依赖源码以使构建的依赖恢复正常工作

const fs = require('node:fs')
const path = require('node:path')

const rootPath = path.join(__dirname, './')

// 通知栏按钮：在「上一首」前面加一个播放模式切换、在「下一首」后面加一个桌面歌词开关。
// node_modules 不入库，只能每次装完依赖后按字符串打补丁；
// JS 侧在 src/plugins/player/utils.ts 的 updateOptions 里传 playModeButton / lyricButton
// 两个开关与对应图标，按钮行为在 src/plugins/player/service.ts 里接管。
const METADATA_MANAGER = path.join(rootPath, 'node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/metadata/MetadataManager.java')

const patchs = [
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
]

// 换行统一成 LF：Windows 上检出的文件可能是 CRLF，而这里比的是整段代码
const toLF = str => str.replace(/\r\n/g, '\n')

;(async() => {
  let failed = false
  for (const [filePath, fromStr, toStr] of patchs) {
    const label = filePath.replace(rootPath, '')
    const from = toLF(fromStr)
    const to = toLF(toStr)
    try {
      const file = toLF(await fs.promises.readFile(filePath, 'utf8'))
      // 先看打过没：重复装依赖时会再打一次，覆盖内容里带着原代码，
      // 不先判重的话会一层层往上叠（字段、局部变量重复声明，直接编译不过）
      if (file.includes(to)) {
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
  console.log('\nDependencies patch finished.\n')
})()
