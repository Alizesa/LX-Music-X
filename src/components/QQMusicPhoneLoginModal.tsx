import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'
import Modal, { type ModalType } from '@/components/common/Modal'
import Input from '@/components/common/Input'
import Button from '@/components/common/Button'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import WebView, { type WebViewNavigation } from 'react-native-webview'
import CookieManager from '@react-native-cookies/cookies'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { QQ_USER_AGENT, saveQQMusicSession } from '@/core/qqMusic'
import {
  QQMusicSecurityRequiredError,
  loginQQMusicByPhone,
  sendQQMusicPhoneCaptcha,
} from '@/core/qqMusicLogin'
import { mergeQQMusicCookies, parseQQMusicCookie } from '@/core/qqMusicCookie'
import { createStyle, toast } from '@/utils/tools'

const WebViewComponent = WebView as any
const DEFAULT_COUNTRY_CODE = '86'
const RESEND_SECONDS = 60

export interface QQMusicPhoneLoginModalType {
  show: () => void
}

interface SecurityContext {
  url: string
  cookie: string
  action: 'send' | 'login'
  phone: string
  countryCode: string
  code: string
}

const cookieTargets = (url: string) => {
  const host = (/^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? '').toLowerCase()
  if (host === 'qq.com' || host.endsWith('.qq.com')) {
    return Array.from(new Set([url, 'https://c.y.qq.com/', 'https://y.qq.com/']))
  }
  return [url]
}

// 把 challenge 的种子 Cookie 写进 WebView 的 CookieManager，验证页才能认出当前会话
const seedCookies = async(url: string, cookie: string) => {
  const values = parseQQMusicCookie(cookie)
  if (!Object.keys(values).length) return
  await Promise.all(cookieTargets(url).map(async target => {
    for (const [name, value] of Object.entries(values)) {
      await CookieManager.set(target, { name, value, path: '/', secure: true }, true).catch(() => {})
    }
  }))
  await CookieManager.flush().catch(() => {})
}

const readSecurityCookie = async(url: string, currentUrl: string, seed: string) => {
  await CookieManager.flush().catch(() => {})
  const targets = Array.from(new Set([
    url,
    currentUrl,
    'https://y.qq.com/',
    'https://c.y.qq.com/',
    'https://u.y.qq.com/',
    ...cookieTargets(url),
  ].filter(Boolean)))
  let cookie = seed
  for (const target of targets) {
    try {
      const cookies = await CookieManager.get(target, true)
      const header = Object.values(cookies)
        .filter(item => item?.name && item.value != null && item.value !== '')
        .map(item => `${item.name}=${item.value}`)
        .join('; ')
      cookie = mergeQQMusicCookies(cookie, header)
    } catch {}
  }
  return cookie
}

const SecurityView = ({ url, seed, onDone, onCancel }: {
  url: string
  seed: string
  onDone: (cookie: string) => void
  onCancel: () => void
}) => {
  const theme = useTheme()
  const statusBarHeight = useStatusbarHeight()
  const currentUrlRef = useRef(url)
  const doneRef = useRef(false)
  // 种子 Cookie 写完再加载验证页：否则页面可能先于 Cookie 初始化完成，
  // 认不出当前会话，滑块做完了也无法通过
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    setReady(false)
    void seedCookies(url, seed).finally(() => { if (active) setReady(true) })
    return () => { active = false }
  }, [url, seed])

  const complete = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    void readSecurityCookie(url, currentUrlRef.current, seed).then(onDone)
  }, [onDone, seed, url])

  const handleShouldStartLoad = (request: WebViewNavigation) => {
    // 验证完成后 QQ 页面可能用 qqmusic://qq.com/.../closeWebView 或 finishWebView 通知宿主
    if (/^qqmusic:\/\/qq\.com\//i.test(request.url) && /(?:close|finish)webview/i.test(request.url)) {
      complete()
      return false
    }
    return /^https?:/i.test(request.url.slice(0, request.url.indexOf(':') + 1))
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme['c-content-background'] }}>
      <View style={{ height: 50 + statusBarHeight, paddingTop: statusBarHeight, flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity onPress={onCancel} style={{ width: 50, alignItems: 'center' }}>
          <Icon name="chevron-left" size={24} color={theme['c-font']} />
        </TouchableOpacity>
        <Text style={{ flex: 1 }} size={18}>{global.i18n.t('qq_security_verification')}</Text>
        <TouchableOpacity onPress={complete} disabled={!ready} style={{ paddingHorizontal: 14, opacity: ready ? 1 : 0.3 }}>
          <Text color={theme['c-primary-font']}>{global.i18n.t('confirm')}</Text>
        </TouchableOpacity>
      </View>
      <Text size={12} color={theme['c-font-label']} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        {global.i18n.t('qq_security_hint')}
      </Text>
      {
        ready
          ? <WebViewComponent
              source={{ uri: url }}
              style={{ flex: 1 }}
              userAgent={`${QQ_USER_AGENT} QQMUSIC/140200`}
              originWhitelist={['*']}
              javaScriptEnabled
              domStorageEnabled
              useWideViewPort
              loadWithOverviewMode
              setSupportMultipleWindows={false}
              thirdPartyCookiesEnabled
              sharedCookiesEnabled
              onShouldStartLoadWithRequest={handleShouldStartLoad}
              onNavigationStateChange={(state: WebViewNavigation) => { currentUrlRef.current = state.url }}
            />
          : <View style={{ flex: 1 }} />
      }
    </View>
  )
}

export default forwardRef<QQMusicPhoneLoginModalType, { onLoggedIn?: (user: LX.QQMusic.UserInfo) => void }>(({ onLoggedIn }, ref) => {
  const modalRef = useRef<ModalType>(null)
  const [phone, setPhone] = useState('')
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE)
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [captchaCookie, setCaptchaCookie] = useState('')
  const [security, setSecurity] = useState<SecurityContext | null>(null)
  const theme = useTheme()

  useImperativeHandle(ref, () => ({
    show() {
      setPhone('')
      setCountryCode(DEFAULT_COUNTRY_CODE)
      setCode('')
      setSending(false)
      setLoggingIn(false)
      setCountdown(0)
      setCaptchaCookie('')
      setSecurity(null)
      modalRef.current?.setVisible(true)
    },
  }))

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => { setCountdown(value => Math.max(0, value - 1)) }, 1000)
    return () => { clearTimeout(timer) }
  }, [countdown])

  const close = () => modalRef.current?.setVisible(false)

  const handleError = (error: unknown, action: SecurityContext['action'], phoneValue: string, countryValue: string, codeValue: string) => {
    if (error instanceof QQMusicSecurityRequiredError) {
      setSecurity({
        url: error.url,
        cookie: error.cookie,
        action,
        phone: phoneValue,
        countryCode: countryValue,
        code: codeValue,
      })
      return
    }
    toast(error instanceof Error ? error.message : global.i18n.t('qq_login_failed'), 'long')
  }

  const sendCode = async(cookieSeed = '', phoneValue = phone, countryValue = countryCode) => {
    if (sending) return
    setSending(true)
    try {
      const result = await sendQQMusicPhoneCaptcha(phoneValue, countryValue, cookieSeed)
      setCaptchaCookie(result.cookie)
      setCountdown(RESEND_SECONDS)
      toast(result.message)
    } catch (error: unknown) {
      handleError(error, 'send', phoneValue, countryValue, code)
    } finally {
      setSending(false)
    }
  }

  const submit = async(cookieSeed = captchaCookie, phoneValue = phone, codeValue = code) => {
    if (loggingIn) return
    setLoggingIn(true)
    try {
      const credential = await loginQQMusicByPhone(phoneValue, codeValue, cookieSeed)
      // 登录回包里有昵称/头像就带进去：网页资料接口在手机号票据下可能只回兜底值
      const user = await saveQQMusicSession(credential.cookie, { nickname: credential.nickname, avatar: credential.avatar })
      global.app_event.qqMusicAccountUpdated(user)
      onLoggedIn?.(user)
      toast(global.i18n.t('qq_login_success'))
      close()
    } catch (error: unknown) {
      handleError(error, 'login', phoneValue, countryCode, codeValue)
    } finally {
      setLoggingIn(false)
    }
  }

  const handleSecurityDone = (cookie: string) => {
    if (!security) return
    const merged = mergeQQMusicCookies(security.cookie, cookie)
    const context = security
    setSecurity(null)
    if (context.action == 'send') void sendCode(merged, context.phone, context.countryCode)
    else void submit(merged, context.phone, context.code)
  }

  return (
    <Modal ref={modalRef} bgColor="rgba(0,0,0,.35)" bgHide={false} statusBarPadding={false}>
      {
        security
          ? <SecurityView url={security.url} seed={security.cookie} onDone={handleSecurityDone} onCancel={() => { setSecurity(null) }} />
          : <View style={styles.centered}>
              <View style={{ ...styles.dialog, backgroundColor: theme['c-content-background'] }}>
                <Text size={16} style={styles.title}>{global.i18n.t('qq_phone_login_title')}</Text>
                <View style={styles.row}>
                  <View style={{ ...styles.country, borderColor: theme['c-border-background'] }}>
                    <Text color={theme['c-font-label']}>+</Text>
                    <Input
                      value={countryCode}
                      onChangeText={value => { setCountryCode(value.replace(/\D/g, '').slice(0, 4)) }}
                      keyboardType="number-pad"
                      maxLength={4}
                      style={styles.countryInput}
                    />
                  </View>
                  <Input
                    value={phone}
                    onChangeText={value => { setPhone(value.replace(/\D/g, '').slice(0, 20)) }}
                    keyboardType="phone-pad"
                    maxLength={20}
                    placeholder={global.i18n.t('qq_phone_number_placeholder')}
                    style={{ ...styles.input, borderColor: theme['c-border-background'], marginLeft: 8 }}
                  />
                </View>
                <View style={{ ...styles.row, marginTop: 8 }}>
                  <Input
                    value={code}
                    onChangeText={value => { setCode(value.replace(/\D/g, '').slice(0, 10)) }}
                    keyboardType="number-pad"
                    maxLength={10}
                    placeholder={global.i18n.t('qq_code_placeholder')}
                    style={{ ...styles.input, borderColor: theme['c-border-background'] }}
                  />
                  <Button
                    style={{ ...styles.sendButton, borderColor: theme['c-border-background'] }}
                    disabled={sending || countdown > 0 || phone.length < 6}
                    onPress={() => { void sendCode() }}
                  >
                    <Text size={13} color={theme['c-primary-font']}>
                      {countdown > 0 ? global.i18n.t('qq_resend_code', { num: countdown }) : global.i18n.t('qq_send_code')}
                    </Text>
                  </Button>
                </View>
                <View style={styles.actions}>
                  <Button style={styles.button} onPress={close}><Text>{global.i18n.t('cancel')}</Text></Button>
                  <Button
                    style={styles.button}
                    disabled={loggingIn || phone.length < 6 || code.length < 4}
                    onPress={() => { void submit() }}
                  >
                    <Text color={theme['c-primary-font']}>{global.i18n.t('qq_login')}</Text>
                  </Button>
                </View>
              </View>
            </View>
      }
    </Modal>
  )
})

const styles = createStyle({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  dialog: { width: '100%', maxWidth: 520, borderRadius: 6, padding: 16 },
  title: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, height: 40, borderWidth: 1, borderRadius: 4, paddingHorizontal: 8 },
  country: { width: 88, height: 40, borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center' },
  countryInput: { flex: 1, height: 38, paddingLeft: 4 },
  sendButton: { minWidth: 104, height: 40, borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  button: { minWidth: 72, height: 38, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
})
