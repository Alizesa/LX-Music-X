import { useEffect, useRef } from 'react'
// import { View } from 'react-native'

import Menu, { type MenuType, type MenuProps, type Menus } from './Menu'
import Button, { type BtnType, type BtnProps } from './Button'
import { useScreenVisible } from '@/utils/hooks/useScreenVisible'
// import { useLayout } from '@/utils/hooks'

export interface DorpDownMenuProps<T extends Menus> extends Omit<MenuProps<T>, 'width'> {
  children: React.ReactNode
  btnStyle?: BtnProps['style']
  disabled?: boolean
  accessibilityLabel?: BtnProps['accessibilityLabel']
}

export default <T extends Menus>({
  menus,
  onPress,
  height,
  fontSize,
  center,
  children,
  activeId,
  btnStyle,
  disabled = false,
  accessibilityLabel,
}: DorpDownMenuProps<T>) => {
  const buttonRef = useRef<BtnType>(null)
  const menuRef = useRef<MenuType>(null)
  const visible = useScreenVisible()
  const available = visible && !disabled
  const availableRef = useRef(available)
  availableRef.current = available
  const measurement = useRef<symbol | null>(null)

  useEffect(() => {
    availableRef.current = available
    if (!available) menuRef.current?.hide()
    return () => {
      availableRef.current = false
      measurement.current = null
    }
  }, [available])

  const showMenu = () => {
    if (!availableRef.current) return
    const request = Symbol('dropdown measurement')
    measurement.current = request
    buttonRef.current?.measure((fx, fy, width, height, px, py) => {
      if (!availableRef.current || request !== measurement.current) return
      // console.log(fx, fy, width, height, px, py)
      menuRef.current?.show({ x: Math.ceil(px), y: Math.ceil(py), w: Math.ceil(width), h: Math.ceil(height) }, {
        width,
        height,
      })
    })
  }

  return (
    <Button style={btnStyle} ref={buttonRef} onPress={showMenu} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}>
      {children}
      <Menu
        ref={menuRef}
        menus={menus}
        center={center}
        onPress={menu => { if (availableRef.current) onPress(menu) }}
        fontSize={fontSize}
        height={height}
        activeId={activeId}
      />
    </Button>
  )
}
