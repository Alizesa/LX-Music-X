import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import { View, TouchableOpacity } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import WebView, { type WebViewNavigation } from 'react-native-webview'
import CookieManager from '@react-native-cookies/cookies'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { isQQMusicCookie, saveQQMusicSession } from '@/core/qqMusic'
import { toast } from '@/utils/tools'

const LOGIN_URL = 'https://y.qq.com/portal/profile.html'
const COOKIE_URLS = [LOGIN_URL, 'https://qq.com/', 'https://c.y.qq.com/', 'https://u.y.qq.com/']
const WebViewComponent = WebView as any
const getErrorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export interface QQMusicLoginModalType {
  show: () => void
}

export default forwardRef<QQMusicLoginModalType, { onLoggedIn?: (user: LX.QQMusic.UserInfo) => void }>(({ onLoggedIn }, ref) => {
  const modalRef = useRef<ModalType>(null)
  const webViewRef = useRef<any>(null)
  const checkingRef = useRef(false)
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()

  useImperativeHandle(ref, () => ({
    show() {
      checkingRef.current = false
      modalRef.current?.setVisible(true)
    },
  }))

  const close = useCallback(() => modalRef.current?.setVisible(false), [])

  const readCookie = useCallback(async(url = LOGIN_URL, showError = false) => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      let cookie = ''
      try {
        const cookieMaps = await Promise.all(COOKIE_URLS.map(cookieUrl => CookieManager.get(cookieUrl, true)))
        cookie = cookieMaps.flatMap(cookies => Object.values(cookies)).map(item => `${item.name}=${item.value}`).filter((item, index, all) => all.indexOf(item) === index).join('; ')
      } catch {}
      if (!cookie) {
        webViewRef.current?.injectJavaScript('window.ReactNativeWebView.postMessage(document.cookie); true;')
        return
      }
      if (!isQQMusicCookie(cookie)) {
        if (showError) toast(global.i18n.t('qq_cookie_invalid'), 'long')
        return
      }
      const user = await saveQQMusicSession(cookie)
      global.app_event.qqMusicAccountUpdated(user)
      onLoggedIn?.(user)
      toast(global.i18n.t('qq_login_success'))
      close()
    } catch (error: unknown) {
      if (showError) toast(getErrorMessage(error, global.i18n.t('qq_login_failed')), 'long')
    } finally {
      checkingRef.current = false
    }
  }, [close, onLoggedIn])

  const handleMessage = useCallback(async(event: any) => {
    const cookie = String(event.nativeEvent.data ?? '').trim()
    if (!isQQMusicCookie(cookie)) return
    try {
      const user = await saveQQMusicSession(cookie)
      global.app_event.qqMusicAccountUpdated(user)
      onLoggedIn?.(user)
      toast(global.i18n.t('qq_login_success'))
      close()
    } catch (error: unknown) {
      toast(getErrorMessage(error, global.i18n.t('qq_login_failed')), 'long')
    }
  }, [close, onLoggedIn])

  const handleNavigationStateChange = (state: WebViewNavigation) => {
    if (state.url.includes('y.qq.com') && !state.url.includes('/login')) void readCookie(state.url)
  }

  const handleShouldStartLoad = (request: WebViewNavigation) => {
    return /^https?:$/i.test(request.url.slice(0, request.url.indexOf(':') + 1))
  }

  return (
    <Modal ref={modalRef} statusBarPadding={false} bgHide={false} onHide={() => { checkingRef.current = false }}>
      <View style={{ flex: 1, backgroundColor: theme['c-content-background'] }}>
        <View style={{ height: 50 + statusBarHeight, paddingTop: statusBarHeight, flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity onPress={close} style={{ width: 50, alignItems: 'center' }}>
            <Icon name="chevron-left" size={24} color={theme['c-font']} />
          </TouchableOpacity>
          <Text style={{ flex: 1 }} size={18}>{global.i18n.t('qq_login_title')}</Text>
          <TouchableOpacity onPress={() => { void readCookie(LOGIN_URL, true) }} style={{ paddingHorizontal: 14 }}>
            <Text color={theme['c-primary-font']}>{global.i18n.t('qq_login_done')}</Text>
          </TouchableOpacity>
        </View>
        <WebViewComponent
          ref={webViewRef}
          source={{ uri: LOGIN_URL }}
          onMessage={handleMessage}
          onNavigationStateChange={handleNavigationStateChange}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
        />
      </View>
    </Modal>
  )
})
