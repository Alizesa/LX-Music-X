// @flow

import { Navigation } from 'react-native-navigation'

import {
  Home,
  PlayDetail,
  SonglistDetail,
  SingerDetail,
  AlbumDetail,
  Comment,
  Search,
  Setting,
  Download,
  PlayHistory,
  QQPlaylist,
  LocalSongs,
} from '@/screens'
import { Provider } from '@/store/Provider'

import {
  HOME_SCREEN,
  PLAY_DETAIL_SCREEN,
  SONGLIST_DETAIL_SCREEN,
  SINGER_DETAIL_SCREEN,
  ALBUM_DETAIL_SCREEN,
  COMMENT_SCREEN,
  SEARCH_SCREEN,
  SETTING_SCREEN,
  DOWNLOAD_SCREEN,
  PLAY_HISTORY_SCREEN,
  QQ_PLAYLIST_SCREEN,
  LOCAL_SONGS_SCREEN,
  VERSION_MODAL,
  PACT_MODAL,
  // SETTING_SCREEN,
} from './screenNames'
import VersionModal from './components/VersionModal'
import PactModal from './components/PactModal'

function WrappedComponent(Component: any) {
  return function inject(props: Record<string, any>) {
    const EnhancedComponent = () => (
      <Provider>
        <Component
          {...props}
        />
      </Provider>
    )

    return <EnhancedComponent />
  }
}

export default () => {
  Navigation.registerComponent(HOME_SCREEN, () => WrappedComponent(Home))
  Navigation.registerComponent(PLAY_DETAIL_SCREEN, () => WrappedComponent(PlayDetail))
  Navigation.registerComponent(SONGLIST_DETAIL_SCREEN, () => WrappedComponent(SonglistDetail))
  Navigation.registerComponent(SINGER_DETAIL_SCREEN, () => WrappedComponent(SingerDetail))
  Navigation.registerComponent(ALBUM_DETAIL_SCREEN, () => WrappedComponent(AlbumDetail))
  Navigation.registerComponent(COMMENT_SCREEN, () => WrappedComponent(Comment))
  Navigation.registerComponent(SEARCH_SCREEN, () => WrappedComponent(Search))
  Navigation.registerComponent(SETTING_SCREEN, () => WrappedComponent(Setting))
  Navigation.registerComponent(DOWNLOAD_SCREEN, () => WrappedComponent(Download))
  Navigation.registerComponent(PLAY_HISTORY_SCREEN, () => WrappedComponent(PlayHistory))
  Navigation.registerComponent(QQ_PLAYLIST_SCREEN, () => WrappedComponent(QQPlaylist))
  Navigation.registerComponent(LOCAL_SONGS_SCREEN, () => WrappedComponent(LocalSongs))
  Navigation.registerComponent(VERSION_MODAL, () => WrappedComponent(VersionModal))
  Navigation.registerComponent(PACT_MODAL, () => WrappedComponent(PactModal))
  // Navigation.registerComponent(SETTING_SCREEN, () => WrappedComponent(Setting))

  console.info('All screens have been registered...')
}
