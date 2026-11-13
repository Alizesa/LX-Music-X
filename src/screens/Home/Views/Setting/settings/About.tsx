import { memo } from 'react'
import { View, TouchableOpacity } from 'react-native'

import Section from '../components/Section'
// import Button from './components/Button'

import { createStyle, openUrl } from '@/utils/tools'
// import { showPactModal } from '@/navigation'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'
import { showPactModal } from '@/core/common'

const repositoryUrl = 'https://github.com/Alizesa/LX-Music-X'

// const qqGroupUrl = 'mqqopensdkapi://bizAgent/qm/qr?url=http%3A%2F%2Fqm.qq.com%2Fcgi-bin%2Fqm%2Fqr%3Ffrom%3Dapp%26p%3Dandroid%26jump_from%3Dwebapi%26k%3Du1zyxek8roQAwic44nOkBXtG9CfbAxFw'
// const qqGroupUrl2 = 'mqqopensdkapi://bizAgent/qm/qr?url=http%3A%2F%2Fqm.qq.com%2Fcgi-bin%2Fqm%2Fqr%3Ffrom%3Dapp%26p%3Dandroid%26jump_from%3Dwebapi%26k%3D-l4kNZ2bPQAuvfCQFFhl1UoibvF5wcrQ'
// const qqGroupWebUrl = 'https://qm.qq.com/cgi-bin/qm/qr?k=jRZkyFSZ4FmUuTHA3P_RAXbbUO_Rrn5e&jump_from=webapi'
// const qqGroupWebUrl2 = 'https://qm.qq.com/cgi-bin/qm/qr?k=HPNJEfrZpBZ9T8szYWbe2d5JrAAeOt_l&jump_from=webapi'

export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const openHomePage = () => {
    void openUrl('https://github.com/lyswhut/lx-music-mobile#readme')
  }
  const openForkPage = () => {
    void openUrl(repositoryUrl)
  }
  const openIssuePage = () => {
    void openUrl(`${repositoryUrl}/issues`)
  }
  const openGHReleasePage = () => {
    void openUrl(`${repositoryUrl}/releases`)
  }
  const openFAQPage = () => {
    void openUrl('https://lyswhut.github.io/lx-music-doc/mobile/faq')
  }
  const openPactModal = () => {
    showPactModal()
  }
  const openPartPage = () => {
    void openUrl('https://github.com/lyswhut/lx-music-mobile#%E9%A1%B9%E7%9B%AE%E5%8D%8F%E8%AE%AE')
  }

  // const goToQQGroup = () => {
  //   openUrl(qqGroupUrl).catch(() => {
  //     void openUrl(qqGroupWebUrl)
  //   })
  // }
  // const goToQQGroup2 = () => {
  //   openUrl(qqGroupUrl2).catch(() => {
  //     void openUrl(qqGroupWebUrl2)
  //   })
  // }

  const textLinkStyle = {
    ...styles.text,
    textDecorationLine: 'underline',
    color: theme['c-primary-font'],
    // fontSize: 14,
  } as const


  return (
    <Section title={t('setting_about')}>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_fork')}</Text>
        <TouchableOpacity onPress={openForkPage}>
          <Text style={textLinkStyle}>Alizesa/LX-Music-X</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_updates')}</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_source')}</Text>
        <TouchableOpacity onPress={openForkPage}>
          <Text style={textLinkStyle}>{repositoryUrl}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_upstream')}</Text>
        <TouchableOpacity onPress={openHomePage}>
          <Text style={textLinkStyle}>https://github.com/lyswhut/lx-music-mobile</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_download')}</Text>
        <TouchableOpacity onPress={openGHReleasePage}>
          <Text style={textLinkStyle}>GitHub Releases</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={styles.text} >软件的常见问题可转至：</Text>
        <TouchableOpacity onPress={openFAQPage}>
          <Text style={textLinkStyle}>移动版常见问题</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}><Text style={styles.boldText}>本软件没有客服</Text>，但我们整理了一些常见的使用问题。<Text style={styles.boldText} >仔细、仔细、仔细</Text>地阅读常见问题后，</Text>
        <Text style={styles.text}>仍有问题可到 GitHub </Text>
        <TouchableOpacity onPress={openIssuePage}>
          <Text style={textLinkStyle}>提交 Issue</Text>
        </TouchableOpacity>
        <Text style={styles.text}>。</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>由于软件开发的初衷仅是为了对新技术的学习与研究，因此软件直至停止维护都将会一直保持纯净。</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>目前本项目的原始发布地址<Text style={styles.boldText}>只有 GitHub</Text>，其他渠道均为第三方转载发布，可信度请自行鉴别。</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}><Text style={styles.boldText}>本项目没有微信公众号之类的所谓「官方账号」，也未在小米、华为、vivo 等应用商店发布同名应用，谨防被骗！</Text></Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>若你使用过程中遇到<Text style={styles.boldText}>广告</Text>或者<Text style={styles.boldText}>引流</Text>（如需要加群、关注公众号之类才能使用或者升级）的信息，则表明你当前运行的软件是「第三方修改版」。</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_upgrade')}</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>你已签署本软件的</Text>
        <TouchableOpacity onPress={openPactModal}><Text style={styles.text} color={theme['c-primary-font']}>许可协议</Text></TouchableOpacity>
        <Text style={styles.text}>，协议的在线版本在</Text>
        <TouchableOpacity onPress={openPartPage}><Text style={textLinkStyle}>这里</Text></TouchableOpacity>
        <Text style={styles.text}>。</Text>
      </View>
      <View style={styles.part}>
        <Text style={styles.text}>{t('setting_about_upstream_author')}</Text>
        <Text style={styles.text}>落雪无痕</Text>
      </View>
    </Section>
  )
})

const styles = createStyle({
  part: {
    marginLeft: 15,
    marginRight: 15,
    marginBottom: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  text: {
    fontSize: 14,
    textAlignVertical: 'bottom',
  },
  boldText: {
    fontSize: 14,
    fontWeight: 'bold',
    textAlignVertical: 'bottom',
  },
  throughText: {
    fontSize: 14,
    textDecorationLine: 'line-through',
    textAlignVertical: 'bottom',
  },
  btn: {
    flexDirection: 'row',
  },
})
