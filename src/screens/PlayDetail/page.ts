export const PLAY_DETAIL_PAGES = ['singer', 'cover', 'lyric'] as const
export type PlayDetailPage = typeof PLAY_DETAIL_PAGES[number]

export interface PlayDetailPagerProps {
  componentId: string
  initialPage: PlayDetailPage
  onPageChange: (page: PlayDetailPage) => void
}
