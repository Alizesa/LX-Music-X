# QQ 音乐接口说明

## 现有实现位置

- 核心会话、Cookie、用户资料、歌单和推荐：`src/core/qqMusic.ts`
- 推荐自动刷新和播放队列补充：`src/core/qqMusicRecommend.ts`
- 登录弹窗：`src/components/QQMusicLoginModal.tsx`
- Cookie 导入弹窗：`src/components/QQMusicCookieModal.tsx`
- 本地缓存读写：`src/utils/data.ts`

## 使用规则

### 已登录

通过 `getQQMusicSession()` 取得 Cookie 和用户信息。Cookie 有效时，请求携带 QQ Music 会话信息，首页显示个性化每日推荐和推荐歌单。

### 未登录

Cookie 为空或无效时，不阻塞首页渲染。使用 QQ 音乐游客/默认推荐，接口失败时显示缓存或空状态，并提供登录入口。

### Cookie 失效

遇到 QQ 返回登录失效状态时，不把异常直接显示为页面崩溃。应停止继续重试，清理或标记失效会话，提示用户重新登录，并允许继续使用游客推荐。

## 主要接口域名

- `https://u.y.qq.com/cgi-bin/musicu.fcg`
- `https://c.y.qq.com/...`
- `https://y.qq.com/...`

当前项目已封装请求头、Referer、User-Agent、Cookie 和返回数据归一化逻辑。UI 页面不得直接复制 URL、拼接签名或自行解析 Cookie。

## 数据缓存

现有缓存键包括：

- `@qq_music_cookie`
- `@qq_music_user`
- `@qq_music_daily_recommend`
- `@qq_music_recommend_playlists`
- `@qq_music_playlists`

推荐页面应遵循“缓存先展示、网络再刷新”的策略，避免网络慢时出现白屏。用户切换账号后必须使用现有会话保存和缓存清理逻辑，避免显示上一个账号的推荐内容。

### 进页面的请求闸门

首页和“我的”会被反复挂载（切 Tab、从旧功能页返回），不能每次挂载都回源。规则：

1. 先读缓存渲染，`shouldRefreshQQMusicViewData(key)` 为 false 时直接结束，一个请求都不发。
2. 闸门为 true 时并发取推荐歌单和每日推荐（不要串行），成功后 `markQQMusicViewDataRefreshed(key)`。
3. 失败不记时间，下次进页面还能重试；已经有缓存时静默降级，只在完全没有内容时才提示。
4. 下拉刷新不受闸门限制，是用户明确要求回源的手势。
5. 闸门是进程内时间戳（30 分钟），重启应用后会重新取一次。

### 临时列表 id

播放每日推荐时写入的 `tempListMeta.id` 必须是 `RECOMMEND_TEMP_LIST_ID`（`src/core/qqMusicRecommend.ts` 导出）。`qqMusicRecommend` 的自动续播只认这个 id，首页和 QQ 音乐页用了不同的 id 就会出现“某一页播完不补歌”。

## 页面适配数据

首页只依赖以下稳定字段：

- 歌曲：标题、歌手、专辑、封面、时长、可用音质、来源标识。
- 歌单：ID、名称、封面、简介、歌曲数量、作者、是否收藏。
- 用户：UIN、昵称、头像、登录状态。

接口返回字段发生变化时，优先修改 `src/core/qqMusic.ts` 的归一化函数，不修改页面组件中的字段兼容逻辑。

## 失败处理

| 情况 | 行为 |
| --- | --- |
| 首次加载超时（无缓存） | 显示“QQ 音乐数据加载失败”并 toast，列表区保留空状态；下拉刷新或重进页面即重试 |
| 有缓存、刷新失败 | 保留缓存静默降级，不打断浏览 |
| 未登录 | 使用默认推荐并显示登录入口（首页空状态提示登录，不显示“加载失败”） |
| Cookie 失效 | 提示重新登录，降级为默认推荐 |
| 返回空数组 | 显示空状态，不渲染空白占位列表 |
| 歌单接口失败 | “我的”页面两个歌单区显示加载失败文案，不沿用空歌单文案 |
