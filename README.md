<p align="center"><a href="https://github.com/lyswhut/lx-music-mobile"><img width="200" src="https://github.com/lyswhut/lx-music-mobile/blob/master/doc/images/icon.png" alt="lx-music logo"></a></p>

<h1 align="center">LX Music X</h1>

<p align="center">LX Music 移动版的个人自用分支，仅构建 Android</p>

## 这是什么

[LX Music 移动版](https://github.com/lyswhut/lx-music-mobile) 的个人分支，按自己的使用习惯改的，只出 Android 包。

- 应用 ID `io.github.alizesa.lxmusicx`，可与官方 LX Music 共存
- 版本号跟随上游的 `package.json`（当前 1.9.0 / versionCode 77）
- 最低 Android 5（minSdk 21）

上游本身的功能、自定义源机制、数据同步等都与官方一致，这里只记录**本分支多出来的东西**。

## 与上游的差异

### 下载

上游没有下载功能，这里补了一套。

- 原生下载器（Android WorkManager），支持暂停 / 恢复 / 重试 / 移除记录
- **首次使用必须先授权目录**：进「下载管理」用系统文件选择器选一个公共目录，授予持久访问权限，否则无法开始下载
- **下载音质是独立设置**，在下载管理页顶部，默认 320k，与播放音质互不影响
  - 这样播放可以按流量情况随时调到 128k，下载仍是留档品质
  - 请求的音质歌曲没有时会逐级降级（flac24bit → flac → 320k → 128k），而不是失败
- 下载完成的文件会写入「本地音乐」列表，之后播放同一首歌时**优先用本地文件**，不再联网取址

### 播放队列

播放列表以队列形式呈现（底部播放栏的列表按钮），可排序、可移除。

### QQ 音乐

上游没有 QQ 音乐集成。

- **登录**：WebView 登录，或手动粘贴 Cookie 兜底。Cookie 存安全存储，不落明文
- **歌单**：自建 + 收藏，可一键导入为本地歌单；「我喜欢」这类虚拟歌单也支持
- **每日推荐**：点击即播，播到接近队列尾自动续下一批，不会卡在那 20 首循环
- **本地缓存**：歌单和每日推荐都持久缓存，进页面直接显示、点击即播，都不需要联网；页面只在点「刷新」时请求。播放过程中的自动续播会另行拉取下一批，这是连续播放本身的成本
- 登出或换号会清掉缓存，避免串号

### 播放逻辑

- 本地文件优先：下载/导入的本地文件命中后直接播放，不经过在线取址
- 同一首歌有多份本地文件时择优，而不是放弃本地回退到在线
- 取址失败后延迟重试，避免对音源连发请求

## 构建

### GitHub Actions（推荐）

- **推送到 `master`** 会自动构建签名 release APK，产物在 Actions 的 artifacts 里（名称为 `lx-music-x-android-r<构建号>`）
- **推送 `v*` 标签**会额外创建 GitHub Release，附带各 ABI APK、通用 APK 和 `SHA256SUMS.txt`
- 也可以在 Actions 页面手动触发

需要配置以下 Secrets，缺任何一个都会在构建开始时明确报出缺哪个：

| Secret | 说明 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | release keystore 的 base64 |
| `ANDROID_KEYSTORE_ALIAS` | keystore 别名 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

> 签名文件只应生成并保存一份。丢失后无法覆盖升级已发布的 APK，只能卸载重装。

构建产物包含 `armeabi-v7a`、`arm64-v8a`、`x86`、`x86_64` 四个 ABI 以及一个通用包。

### 本地构建

需要先按[源码使用方法](https://lyswhut.github.io/lx-music-doc/mobile/use-source-code)配好 React Native 环境，然后在 `android/keystore.properties` 里填好签名信息（`assembleRelease` 在签名未配置时会直接报错）。

```bash
npm ci
npm run pack          # 等价于 cd android && gradlew.bat assembleRelease
```

调试包用 `npm run dev`；其它脚本见 `package.json` 的 `scripts`。

### 发布

1. 改 `package.json` 的 `version` 与 `versionCode`
2. 更新 `CHANGELOG.md`
3. 打标签并推送：`git tag v1.9.0 && git push origin v1.9.0`

## 上游资料

- 桌面版：<https://github.com/lyswhut/lx-music-desktop>
- 常见问题：<https://lyswhut.github.io/lx-music-doc/mobile/faq>
- 播放列表机制：<https://lyswhut.github.io/lx-music-doc/mobile/faq/playlist>
- 数据同步服务：<https://github.com/lyswhut/lx-music-sync-server#readme>

上游的原始发布地址只有 [GitHub](https://github.com/lyswhut/lx-music-mobile/releases)，其他渠道均为第三方转载，与上游项目无关。

## 项目协议

本分支是 [LX Music 移动版](https://github.com/lyswhut/lx-music-mobile) 的分支，沿用其 [Apache License 2.0](https://github.com/lyswhut/lx-music-mobile/blob/master/LICENSE) 许可证，以及上游在许可证之上补充的以下协议（如有冲突，以补充协议为准）。以下内容原样来自上游，未作改动。

---

*词语约定：本协议中的“本项目”指 LX Music（洛雪音乐）移动版项目；“使用者”指签署本协议的使用者；“官方音乐平台”指对本项目内置的包括酷我、酷狗、咪咕等音乐源的官方平台统称；“版权数据”指包括但不限于图像、音频、名字等在内的他人拥有所属版权的数据。*

### 一、数据来源

1.1 本项目的各官方平台在线数据来源原理是从其公开服务器中拉取数据（与未登录状态在官方平台 APP 获取的数据相同），经过对数据简单地筛选与合并后进行展示，因此本项目不对数据的合法性、准确性负责。

1.2 本项目本身没有获取某个音频数据的能力，本项目使用的在线音频数据来源来自软件设置内“自定义源”设置所选择的“源”返回的在线链接。例如播放某首歌，本项目所做的只是将希望播放的歌曲名、艺术家等信息传递给“源”，若“源”返回了一个链接，则本项目将认为这就是该歌曲的音频数据而进行使用，至于这是不是正确的音频数据本项目无法校验其准确性，所以使用本项目的过程中可能会出现希望播放的音频与实际播放的音频不对应或者无法播放的问题。

1.3 本项目的非官方平台数据（例如“我的列表”内列表）来自使用者本地系统或者使用者连接的同步服务，本项目不对这些数据的合法性、准确性负责。

### 二、版权数据

2.1 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。

### 三、音乐平台别名

3.1 本项目内的官方音乐平台别名为本项目内对官方音乐平台的一个称呼，不包含恶意。如果官方音乐平台觉得不妥，可联系本项目更改或移除。

### 四、资源使用

4.1 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。

### 五、免责声明

5.1 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。

### 六、使用限制

6.1 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。本项目不对项目内的技术可能存在违反当地法律法规的行为作保证。

6.2 **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。

### 七、版权保护

7.1 音乐平台不易，请尊重版权，支持正版。

### 八、非商业性质

8.1 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。

### 九、接受协议

9.1 若你使用了本项目，即代表你接受本协议。
