import { useRef, useImperativeHandle, forwardRef, useState, useEffect, useCallback } from 'react'
import SearchTipList, { type SearchTipListProps as _SearchTipListProps, type SearchTipListType as _SearchTipListType } from '@/components/SearchTipList'
import Button from '@/components/common/Button'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { scaleSizeH } from '@/utils/pixelRatio'
import musicSdk from '@/utils/musicSdk'
import searchState from '@/store/search/state'
import { setSearchText, setTipList, setTipListInfo } from '@/core/search/search'
import { waitForPromise } from '@/utils/abortable'

const ITEM_HEIGHT_RAW = 36
export const ITEM_HEIGHT = scaleSizeH(ITEM_HEIGHT_RAW)

export type SearchTipListProps = _SearchTipListProps<string>
export type SearchTipListType = _SearchTipListType<string>

interface TipListProps {
  onSearch: (keyword: string) => void
}
export interface TipListType {
  search: (keyword: string, height: number) => void
  show: (height: number) => void
  hide: () => void
}

export default forwardRef<TipListType, TipListProps>(({ onSearch }, ref) => {
  const searchTipListRef = useRef<SearchTipListType>(null)
  const [visible, setVisible] = useState(false)
  const visibleListRef = useRef(false)
  const heightRef = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const cancel = useCallback(() => {
    generation.current++
    if (timer.current != null) clearTimeout(timer.current)
    timer.current = null
    request.current?.abort()
    request.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const handleSearch = useCallback((keyword: string, height: number) => {
    cancel()
    heightRef.current = height
    visibleListRef.current = true
    setVisible(true)
    setSearchText(keyword)
    const source = searchState.temp_source
    setTipListInfo(keyword, source)
    if (keyword) {
      const version = generation.current
      timer.current = setTimeout(() => {
        timer.current = null
        if (!visibleListRef.current || version !== generation.current) return
        const controller = request.current = new AbortController()
        void waitForPromise(musicSdk[source].tipSearch.search(keyword, controller.signal) as Promise<string[]>, controller.signal).then(list => {
          if (!visibleListRef.current || version !== generation.current || source !== searchState.temp_source) return
          setTipList(list)
          searchTipListRef.current?.setHeight(heightRef.current)
          searchTipListRef.current?.setList(list)
        }).catch(() => {}).finally(() => {
          if (request.current === controller) request.current = null
        })
      }, 200)
    } else {
      setTipList([])
      searchTipListRef.current?.setList([])
    }
  }, [cancel])

  const hide = useCallback(() => {
    visibleListRef.current = false
    cancel()
    searchTipListRef.current?.setList([])
    setVisible(false)
  }, [cancel])
  useEffect(() => {
    if (!visible) return
    searchTipListRef.current?.setHeight(heightRef.current)
    searchTipListRef.current?.setList(searchState.tipListInfo.list)
  }, [visible])

  useImperativeHandle(ref, () => ({
    search: handleSearch,
    show(height) {
      heightRef.current = height
      visibleListRef.current = true
      setVisible(true)
      searchTipListRef.current?.setHeight(height)
      searchTipListRef.current?.setList(searchState.tipListInfo.list)
    },
    hide,
  }), [handleSearch, hide])

  const renderItem: SearchTipListProps['renderItem'] = ({ item, index }) => {
    return (
      <Button style={styles.item} onPress={() => { onSearch(item) }} key={index}>
        <Text numberOfLines={1}>{item}</Text>
      </Button>
    )
  }
  const getkey: SearchTipListProps['keyExtractor'] = (item, index) => String(index)
  const getItemLayout: SearchTipListProps['getItemLayout'] = (data, index) => {
    return { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
  }

  return (
    visible
      ? <SearchTipList
          ref={searchTipListRef}
          renderItem={renderItem}
          onPressBg={hide}
          keyExtractor={getkey}
          getItemLayout={getItemLayout}
        />
      : null
  )
})


const styles = createStyle({
  item: {
    height: ITEM_HEIGHT_RAW,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 15,
    paddingRight: 15,
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
})

