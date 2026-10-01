import { memo } from 'react'

import Section from '../../components/Section'
import IsShowLyric from './IsShowLyric'
import IsLockLyric from './IsLockLyric'
import IsShowToggleAnima from './IsShowToggleAnima'
import IsSingleLine from './IsSingleLine'
import Direction from './Direction'
import VerticalRotateLatin from './VerticalRotateLatin'
import TextSize from './TextSize'
import ViewWidth from './ViewWidth'
import MaxLineNum from './MaxLineNum'
import Background from './Background'
import BackgroundColor from './BackgroundColor'
import BackgroundOpacity from './BackgroundOpacity'
import TextOpacity from './TextOpacity'
import TextPositionX from './TextPositionX'
import TextPositionY from './TextPositionY'
import { useI18n } from '@/lang'
import Theme from './Theme'
// import { useTranslation } from '@/plugins/i18n'

export default memo(() => {
  const t = useI18n()

  return (
    <Section title={t('setting_lyric_desktop')}>
      <IsShowLyric />
      <IsLockLyric />
      <IsShowToggleAnima />
      <IsSingleLine />
      <Direction />
      <VerticalRotateLatin />
      <Theme />
      <TextSize />
      <ViewWidth />
      <MaxLineNum />
      <Background />
      <BackgroundColor />
      <BackgroundOpacity />
      <TextOpacity />
      <TextPositionX />
      <TextPositionY />
    </Section>
  )
})
