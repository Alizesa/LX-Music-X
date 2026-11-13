import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Animated, PanResponder, View, type LayoutRectangle } from 'react-native'

import SubTitle from '../../components/SubTitle'
import CheckBox from '@/components/common/CheckBox'
import { createStyle } from '@/utils/tools'
import { getApiSourceOrder, setApiSource, setApiSourceOrder } from '@/core/apiSource'
import { parseApiSourceOrder } from '@/utils/apiSourceOrder'
import { useI18n } from '@/lang'
import apiSourceInfo from '@/utils/musicSdk/api-source-info'
import { useSettingValue } from '@/store/setting/hook'
import { useStatus, useUserApiList } from '@/store/userApi'
import Button from '../../components/Button'
import { Icon } from '@/components/common/Icon'
import UserApiEditModal, { type UserApiEditModalType } from './UserApiEditModal'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
// import { importUserApi, removeUserApi } from '@/core/userApi'

const apiSourceList = apiSourceInfo.map(api => ({
  id: api.id,
  name: api.name,
  disabled: api.disabled,
}))

const Item = memo(({ id, name, desc, statusLabel, active, visible, change, priority = -1, total = 0, orderKey = '', move, getDropIndex, onLayout }: {
  id: string
  name: string
  desc?: string
  statusLabel?: string
  active: boolean
  visible: boolean
  change: (id: string) => void
  priority?: number
  total?: number
  orderKey?: string
  move?: (id: string, index: number) => void
  getDropIndex?: (id: string, distance: number) => number
  onLayout?: (id: string, layout: LayoutRectangle | null) => void
}) => {
  const theme = useTheme()
  const t = useI18n()
  const translateY = useRef(new Animated.Value(0)).current
  const activeDrag = useRef(false)
  const [dragging, setDragging] = useState(false)
  const canDrag = visible && priority >= 0 && total > 1
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => canDrag,
    onMoveShouldSetPanResponder: (_, gesture) => canDrag && Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => { activeDrag.current = canDrag; setDragging(canDrag) },
    onPanResponderMove: (_, gesture) => { if (activeDrag.current) translateY.setValue(gesture.dy) },
    onPanResponderRelease: (_, gesture) => {
      const active = activeDrag.current
      activeDrag.current = false
      translateY.setValue(0)
      setDragging(false)
      if (!active) return
      const target = getDropIndex?.(id, gesture.dy) ?? priority
      if (target >= 0 && target !== priority) move?.(id, target)
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      activeDrag.current = false
      translateY.setValue(0)
      setDragging(false)
    },
  }), [canDrag, getDropIndex, id, move, priority, translateY])

  useEffect(() => {
    activeDrag.current = false
    translateY.setValue(0)
    setDragging(false)
    return () => { activeDrag.current = false }
  }, [orderKey, visible, translateY])
  useEffect(() => () => { onLayout?.(id, null) }, [id, onLayout])

  return (
    <Animated.View
      onLayout={event => { onLayout?.(id, event.nativeEvent.layout) }}
      style={{ ...styles.sourceRow, transform: [{ translateY }], zIndex: dragging ? 1 : 0, backgroundColor: dragging ? theme['c-primary-background-hover'] : 'transparent' }}
    >
      <View style={styles.sourceInfo}>
        <CheckBox marginBottom={5} check={active} onChange={() => { change(id) }}>
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
      {priority >= 0 && move ? <View
        style={{ ...styles.sourceHandle, opacity: canDrag ? 1 : 0.3 }}
        {...responder.panHandlers}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${t('source_priority_drag')} ${name}`}
        accessibilityState={{ disabled: !canDrag }}
        accessibilityValue={{ min: 1, max: total, now: priority + 1 }}
        accessibilityActions={canDrag ? [{ name: 'decrement', label: t('source_priority_up') }, { name: 'increment', label: t('source_priority_down') }] : []}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === 'decrement') move(id, priority - 1)
          else if (nativeEvent.actionName === 'increment') move(id, priority + 1)
        }}
      >
        <Icon name="menu" size={17} color={theme['c-font-label']} />
      </View> : null}
    </Animated.View>
  )
})

export default memo(() => {
  const t = useI18n()
  const visible = useScreenVisible()
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
  const orderKey = JSON.stringify(sourceOrder)
  const sourceOrderRef = useRef(sourceOrder)
  sourceOrderRef.current = sourceOrder
  const rowLayouts = useRef(new Map<string, LayoutRectangle>())
  const handleRowLayout = useCallback((id: string, layout: LayoutRectangle | null) => {
    if (layout) rowLayouts.current.set(id, layout)
    else rowLayouts.current.delete(id)
  }, [])
  const setApiSourceId = useCallback((id: string) => {
    if (!id.startsWith('user_api')) { setApiSource(id); return }
    const order = getApiSourceOrder()
    setApiSourceOrder(order.includes(id) ? order.filter(item => item != id) : [...order, id])
  }, [])
  const moveSource = useCallback((id: string, target: number) => {
    const order = getApiSourceOrder()
    const displayed = sourceOrderRef.current
    // 配置先更新、React 后渲染；旧布局的拖拽不能覆盖期间发生的勾选或排序。
    if (order.length !== displayed.length || order.some((id, index) => id !== displayed[index])) return
    const index = order.indexOf(id)
    if (index < 0 || target < 0 || target >= order.length || target === index) return
    order.splice(index, 1)
    order.splice(target, 0, id)
    setApiSourceOrder(order)
  }, [])
  const getDropIndex = useCallback((id: string, distance: number) => {
    const order = sourceOrderRef.current
    const row = rowLayouts.current.get(id)
    let target = order.indexOf(id)
    if (!row || target < 0 || !Number.isFinite(distance)) return target
    const center = row.y + row.height / 2 + distance
    let nearest = Infinity
    // 音源名称、版本和状态可能换行，按实际行位置落下，不假设所有行等高。
    order.forEach((sourceId, index) => {
      const layout = rowLayouts.current.get(sourceId)
      if (!layout) return
      const delta = Math.abs(center - layout.y - layout.height / 2)
      if (delta < nearest) { nearest = delta; target = index }
    })
    return target
  }, [])
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
          list.map(({ id, name }) => <Item name={name} id={id} key={id} active={apiSourceSetting === id} visible={visible} change={setApiSourceId} />)
        }
        {
          userApiList.map(({ id, name, desc, statusLabel }) => <Item name={name} desc={desc} statusLabel={statusLabel} id={id} key={id} active={sourceOrder.includes(id)} visible={visible} change={setApiSourceId}
            priority={sourceOrder.indexOf(id)} total={sourceOrder.length} orderKey={orderKey} move={moveSource} getDropIndex={getDropIndex} onLayout={handleRowLayout} />)
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
  sourceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, minHeight: 44, borderRadius: 4 },
  sourceInfo: { flex: 1 },
  sourceHandle: {
    width: 42,
    alignSelf: 'stretch',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
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
