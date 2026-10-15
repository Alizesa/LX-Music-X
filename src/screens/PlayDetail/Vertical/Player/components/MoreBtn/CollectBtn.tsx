import { usePlayerMusicInfo } from '@/store/player/hook'
import { useTheme } from '@/store/theme/hook'
import { collectMusic, uncollectMusic } from '@/core/player/player'
import { useQQMusicLiked } from '@/core/qqMusicFavorite'
import Btn from './Btn'

// 播放详情页底部的红心。QQ 的歌且已登录时直接写账号的「我喜欢」，
// 其余情况（非 QQ 的歌、未登录）退到本地收藏列表 ——
// 分流在 core/player/player.ts 的 toggleCollect 里。
export default () => {
  const theme = useTheme()
  const musicInfo = usePlayerMusicInfo()
  const liked = useQQMusicLiked(musicInfo.id)

  return (
    <Btn
      icon="love"
      color={liked ? theme['c-primary-font'] : undefined}
      onPress={() => { if (liked) uncollectMusic(); else collectMusic() }}
    />
  )
}
