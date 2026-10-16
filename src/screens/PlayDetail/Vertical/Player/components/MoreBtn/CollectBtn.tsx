import { usePlayerMusicInfo } from '@/store/player/hook'
import { collectMusic, uncollectMusic } from '@/core/player/player'
import { useQQMusicLiked } from '@/core/qqMusicFavorite'
import LikedHeart from '@/components/common/LikedHeart'
import { strongIconShadow } from '@/screens/PlayDetail/components/iconStyle'
import Btn from './Btn'

// 播放详情页底部的红心。QQ 的歌且已登录时直接写账号的「我喜欢」，其余情况按 core 里的分流走。
// 已收藏的标识跟列表行菜单那颗心一致（主题色 + 右下角一个小勾），见 components/common/LikedHeart。
export default () => {
  const musicInfo = usePlayerMusicInfo()
  const liked = useQQMusicLiked(musicInfo.id)

  return (
    <Btn onPress={() => { if (liked) uncollectMusic(); else collectMusic() }}>
      {/* 爱心这个字形在同一个 em 框里画得比别人满，按默认的 24 会显得偏大，单独调小 */}
      <LikedHeart liked={liked} size={21} style={strongIconShadow} />
    </Btn>
  )
}
