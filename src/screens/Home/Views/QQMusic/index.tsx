import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, FlatList, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import Button from '@/components/common/Button'
import QQMusicLoginModal, { type QQMusicLoginModalType } from '@/components/QQMusicLoginModal'
import QQMusicCookieModal, { type QQMusicCookieModalType } from '@/components/QQMusicCookieModal'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { clearQQMusicSession, getQQMusicDailyRecommendations, getQQMusicPlaylistSongs, getQQMusicPlaylists, getQQMusicSession } from '@/core/qqMusic'
import { createList, setTempList } from '@/core/list'
import { playList } from '@/core/player/player'
import { LIST_IDS } from '@/config/constant'
import { useI18n } from '@/lang'

type LoadState = 'idle' | 'loading' | 'error'

const ActionButton = ({ icon, label, onPress, disabled = false }: { icon: string, label: string, onPress: () => void, disabled?: boolean }) => {
  const theme = useTheme()
  return (
    <TouchableOpacity disabled={disabled} style={{ ...styles.actionButton, backgroundColor: theme['c-button-background'], opacity: disabled ? 0.45 : 1 }} onPress={onPress}>
      <Icon name={icon} color={theme['c-button-font']} size={16} />
      <Text color={theme['c-button-font']} style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  )
}

export default () => {
  const theme = useTheme()
  const t = useI18n()
  const loginRef = useRef<QQMusicLoginModalType>(null)
  const cookieLoginRef = useRef<QQMusicCookieModalType>(null)
  const [cookie, setCookie] = useState('')
  const [user, setUser] = useState<LX.QQMusic.UserInfo | null>(null)
  const [playlists, setPlaylists] = useState<LX.QQMusic.PlaylistInfo[]>([])
  const [recommendations, setRecommendations] = useState<LX.Music.MusicInfoOnline[]>([])
  const [playlistState, setPlaylistState] = useState<LoadState>('idle')
  const [recommendState, setRecommendState] = useState<LoadState>('idle')

  useEffect(() => {
    void getQQMusicSession().then(session => {
      setCookie(session.cookie)
      setUser(session.user)
    })
    const handleAccountUpdate = (nextUser: LX.QQMusic.UserInfo | null) => {
      setUser(nextUser)
      void getQQMusicSession().then(session => { setCookie(session.cookie) })
    }
    global.app_event.on('qqMusicAccountUpdated', handleAccountUpdate)
    return () => { global.app_event.off('qqMusicAccountUpdated', handleAccountUpdate) }
  }, [])

  const ensureLogin = useCallback(() => {
    if (cookie && user) return true
    loginRef.current?.show()
    return false
  }, [cookie, user])

  const loadPlaylists = useCallback(async() => {
    if (!ensureLogin()) return
    setPlaylistState('loading')
    try {
      setPlaylists(await getQQMusicPlaylists(cookie))
      setPlaylistState('idle')
    } catch (error: unknown) {
      setPlaylistState('error')
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    }
  }, [cookie, ensureLogin, t])

  const loadRecommendations = useCallback(async() => {
    if (!ensureLogin()) return
    setRecommendState('loading')
    try {
      setRecommendations(await getQQMusicDailyRecommendations(cookie))
      setRecommendState('idle')
    } catch (error: unknown) {
      setRecommendState('error')
      toast(error instanceof Error ? error.message : t('qq_load_failed'), 'long')
    }
  }, [cookie, ensureLogin, t])

  const importPlaylist = async(info: LX.QQMusic.PlaylistInfo) => {
    if (!ensureLogin()) return
    try {
      let songs = await getQQMusicPlaylistSongs(cookie, info.id)
      if (!songs.length) throw new Error('empty')
      await createList({ name: `QQ · ${info.name}`, source: 'tx', sourceListId: info.id, list: songs })
      toast(t('qq_import_success'))
    } catch {
      toast(t('qq_import_failed'), 'long')
    }
  }

  const importRecommendations = async() => {
    if (!recommendations.length) return
    await createList({ name: `QQ · ${t('qq_daily_recommend')}`, source: 'tx', list: recommendations })
    toast(t('qq_import_success'))
  }

  const playRecommendations = async(index: number) => {
    if (!recommendations.length) return
    await setTempList('qq_daily_recommend', recommendations)
    void playList(LIST_IDS.TEMP, index)
  }

  const logout = () => {
    Alert.alert(t('qq_logout_title'), t('qq_logout_message'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('confirm'), style: 'destructive', onPress: () => { void clearQQMusicSession().then(() => { setCookie(''); setUser(null); setPlaylists([]); setRecommendations([]); global.app_event.qqMusicAccountUpdated(null) }) } },
    ])
  }

  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'] }}>
      <View style={styles.header}>
        <View style={styles.accountInfo}>
          <Text size={17}>{user ? user.nickname : t('qq_not_logged_in')}</Text>
          {user ? <Text size={12} color={theme['c-font-label']}>{user.uin ? `QQ ${user.uin}` : t('qq_logged_in')}</Text> : null}
        </View>
        {!user ? <ActionButton icon="setting" label={t('qq_cookie_login')} onPress={() => cookieLoginRef.current?.show()} /> : null}
        <ActionButton icon={user ? 'exit' : 'play-outline'} label={user ? t('qq_logout') : t('qq_login')} onPress={user ? logout : () => loginRef.current?.show()} />
      </View>
      <View style={styles.toolbar}>
        <ActionButton icon="available_updates" label={t('qq_daily_recommend')} onPress={() => { void loadRecommendations() }} disabled={!user || recommendState == 'loading'} />
        <ActionButton icon="album" label={t('qq_my_playlists')} onPress={() => { void loadPlaylists() }} disabled={!user || playlistState == 'loading'} />
      </View>
      {recommendations.length
        ? <View style={styles.section}>
            <View style={styles.sectionHeader}><Text size={16}>{t('qq_daily_recommend')}</Text><Button onPress={() => { void importRecommendations() }}><Text color={theme['c-primary-font']}>{t('qq_import_local')}</Text></Button></View>
            <FlatList
              data={recommendations}
              keyExtractor={item => item.id}
              style={styles.songList}
              renderItem={({ item, index }) => <TouchableOpacity style={styles.songItem} onPress={() => { void playRecommendations(index) }}><Text style={styles.songIndex} color={theme['c-font-label']}>{index + 1}</Text><View style={styles.songInfo}><Text numberOfLines={1}>{item.name}</Text><Text size={12} color={theme['c-font-label']} numberOfLines={1}>{item.singer}</Text></View></TouchableOpacity>}
            />
          </View>
        : null}
      <FlatList
        data={playlists}
        keyExtractor={item => item.id}
        style={styles.playlist}
        renderItem={({ item }) => <View style={styles.playlistItem}><View style={styles.playlistInfo}><Text numberOfLines={1}>{item.name}</Text><Text size={12} color={theme['c-font-label']}>{`${t(item.subscribed ? 'qq_playlist_collected' : 'qq_playlist_created')} · ${item.trackCount ? `${item.trackCount} ${t('qq_songs')}` : t('qq_playlist')}`}</Text></View><TouchableOpacity onPress={() => { void importPlaylist(item) }} style={styles.importButton}><Icon name="add-music" color={theme['c-primary-font']} size={18} /></TouchableOpacity></View>}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{user ? t('qq_load_hint') : t('qq_login_hint')}</Text>}
      />
      <QQMusicLoginModal ref={loginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
      <QQMusicCookieModal ref={cookieLoginRef} onLoggedIn={nextUser => { setUser(nextUser); void getQQMusicSession().then(session => { setCookie(session.cookie) }) }} />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  accountInfo: { flex: 1 },
  toolbar: { flexDirection: 'row', paddingHorizontal: 14, paddingBottom: 10 },
  actionButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4, marginRight: 8 },
  actionLabel: { marginLeft: 5 },
  section: { flex: 1, minHeight: 200 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 8 },
  songList: { flex: 1 },
  songItem: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingHorizontal: 14 },
  songIndex: { width: 28, textAlign: 'center' },
  songInfo: { flex: 1, paddingLeft: 8 },
  playlist: { flex: 1 },
  playlistItem: { flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingHorizontal: 14, borderBottomWidth: 1 },
  playlistInfo: { flex: 1 },
  importButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', padding: 28 },
})
