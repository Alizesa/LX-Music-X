import { memo, useCallback, useMemo, useRef } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { createStyle } from '@/utils/tools'
import { setApiSource, setApiSourceOrder } from '@/core/apiSource'
import { parseApiSourceOrder } from '@/utils/apiSourceOrder'
import { useI18n } from '@/lang'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import { useSettingValue } from '@/store/setting/hook'
import { useStatus, useUserApiList } from '@/store/userApi'
import Button from '../../components/Button'
import IconButton from '@/components/common/Button'
import { IconIonicons } from '@/components/common/Icon'
import { scaleSizeW } from '@/utils/pixelRatio'
import UserApiEditModal, { type UserApiEditModalType } from './UserApiEditModal'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
// import { importUserApi, removeUserApi } from '@/core/userApi'

const apiSourceList = apiSourceInfo.map(api => ({
  id: api.id,
  name: api.name,
  disabled: api.disabled,
}))

const useActive = (id: string) => {
  const activeLangId = useSettingValue('common.apiSource')
  const sourceOrder = useSettingValue('common.apiSourceOrder')
  const isActive = useMemo(() => id.startsWith('user_api')
    ? parseApiSourceOrder(sourceOrder, activeLangId).includes(id)
    : activeLangId == id, [activeLangId, id, sourceOrder])
  return isActive
}

const Item = ({ id, name, desc, statusLabel, change, priority = -1, total = 0, move }: {
  id: string
  name: string
  desc?: string
  statusLabel?: string
  change: (id: string) => void
  priority?: number
  total?: number
  move?: (id: string, offset: number) => void
}) => {
  const isActive = useActive(id)
  const theme = useTheme()
  const t = useI18n()
  // const [toggleCheckBox, setToggleCheckBox] = useState(false)
  return (
    <View style={styles.sourceRow}>
      <View style={styles.sourceInfo}>
        <CheckBox marginBottom={5} check={isActive} onChange={() => { change(id) }}>
          <Text style={styles.sourceLabel}>
            {priority >= 0 ? `${priority + 1}. ` : ''}{name}
            {
              desc ? <Text style={styles.sourceDesc} color={theme['c-500']} size={13}>  {desc}</Text> : null
            }
            {
              statusLabel ? <Text style={styles.sourceStatus} size={13}>  {statusLabel}</Text> : null
            }
          </Text>
        </CheckBox>
      </View>
      {priority >= 0 && move ? <View style={styles.sourceActions}>
        <IconButton style={styles.sourceAction} disabled={priority == 0} onPress={() => { move(id, -1) }}
          accessibilityRole="button" accessibilityLabel={t('source_priority_up')} accessibilityState={{ disabled: priority == 0 }}>
          <IconIonicons name="arrow-up" size={scaleSizeW(18)} color={theme['c-font-label']} />
        </IconButton>
        <IconButton style={styles.sourceAction} disabled={priority == total - 1} onPress={() => { move(id, 1) }}
          accessibilityRole="button" accessibilityLabel={t('source_priority_down')} accessibilityState={{ disabled: priority == total - 1 }}>
          <IconIonicons name="arrow-down" size={scaleSizeW(18)} color={theme['c-font-label']} />
        </IconButton>
      </View> : null}
    </View>
  )
}

export default memo(() => {
  const t = useI18n()
  const list = useMemo(() => apiSourceList.map(s => ({
    // @ts-expect-error
    name: t(`setting_basic_source_${s.id}`) || s.name,
    id: s.id,
  })), [t])
  const userApiListRaw = useUserApiList()
  const apiStatus = useStatus()
  const apiSourceSetting = useSettingValue('common.apiSource')
  const sourceOrderSetting = useSettingValue('common.apiSourceOrder')
  const sourceOrder = useMemo(() => parseApiSourceOrder(sourceOrderSetting, apiSourceSetting)
    .filter(id => userApiListRaw.some(api => api.id == id)), [sourceOrderSetting, apiSourceSetting, userApiListRaw])
  const setApiSourceId = useCallback((id: string) => {
    if (!id.startsWith('user_api')) { setApiSource(id); return }
    setApiSourceOrder(sourceOrder.includes(id) ? sourceOrder.filter(item => item != id) : [...sourceOrder, id])
  }, [sourceOrder])
  const moveSource = (id: string, offset: number) => {
    const order = [...sourceOrder]
    const index = order.indexOf(id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    setApiSourceOrder(order)
  }
  const userApiList = useMemo(() => {
    const getApiStatus = () => {
      let status
      if (apiStatus.status) status = t('setting_basic_source_status_success')
      else if (apiStatus.message == 'initing') status = t('setting_basic_source_status_initing')
      else status = t('setting_basic_source_status_failed')

      return status
    }
    const orderedApis = [...sourceOrder.map(id => userApiListRaw.find(api => api.id == id)!), ...userApiListRaw.filter(api => !sourceOrder.includes(api.id))]
    return orderedApis.map(api => {
      const statusLabel = api.id == apiSourceSetting ? `[${getApiStatus()}]` : ''
      return {
        id: api.id,
        name: api.name,
        label: `${api.name}${statusLabel}`,
        desc: [/^\d/.test(api.version) ? `v${api.version}` : api.version].filter(Boolean).join(', '),
        statusLabel,
        // status: apiStatus.status,
        // message: apiStatus.message,
        // disabled: false,
      }
    })
  }, [userApiListRaw, apiStatus, apiSourceSetting, sourceOrder, t])

  const modalRef = useRef<UserApiEditModalType>(null)
  const handleShow = () => {
    modalRef.current?.show()
  }

  return (
    <SubTitle title={t('setting_basic_source')}>
      <Text size={12}>{t('source_priority_tip')}</Text>
      <View style={styles.list}>
        {
          list.map(({ id, name }) => <Item name={name} id={id} key={id} change={setApiSourceId} />)
        }
        {
          userApiList.map(({ id, name, desc, statusLabel }) => <Item name={name} desc={desc} statusLabel={statusLabel} id={id} key={id} change={setApiSourceId}
            priority={sourceOrder.indexOf(id)} total={sourceOrder.length} move={moveSource} />)
        }
      </View>
      <View style={styles.btn}>
        <Button onPress={handleShow}>{t('setting_basic_source_user_api_btn')}</Button>
      </View>
      <UserApiEditModal ref={modalRef} />
    </SubTitle>
  )
})

const styles = createStyle({
  sourceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  sourceInfo: { flex: 1 },
  sourceActions: { flexShrink: 0, marginLeft: 4 },
  sourceAction: {
    width: scaleSizeW(30),
    height: scaleSizeW(30),
    borderRadius: scaleSizeW(15),
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  list: {
    flexGrow: 0,
    flexShrink: 1,
    // flexDirection: 'row',
    // flexWrap: 'wrap',
  },
  btn: {
    marginTop: 10,
    flexDirection: 'row',
  },
  sourceLabel: {

  },
  sourceDesc: {

  },
  sourceStatus: {

  },
})
