import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { FlatList, Image, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import musicSdk from '@/utils/musicSdk'
import type { Source } from '@/store/search/music/state'

interface Singer { id: string | number, name: string, picUrl?: string | null, albumSize?: number }
export default forwardRef<{ loadList: (text: string, source: Source) => void }, {}>((props, ref) => {
  const theme = useTheme()
  const [list, setList] = useState<Singer[]>([])
  const textRef = useRef('')
  const pageRef = useRef(1)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  useImperativeHandle(ref, () => ({
    loadList(text) {
      textRef.current = text
      pageRef.current = 1
      hasMoreRef.current = true
      void load(true)
    },
  }))
  const load = async(refresh = false) => {
    if (loadingRef.current || (!refresh && !hasMoreRef.current)) return
    loadingRef.current = true
    try {
      const result = await musicSdk.tx.musicSearch.searchSinger(textRef.current, pageRef.current) as { list: Singer[], allPage: number }
      if (!result) return
      setList(current => refresh ? result.list : [...current, ...result.list])
      hasMoreRef.current = pageRef.current < result.allPage
      pageRef.current++
    } finally { loadingRef.current = false }
  }
  return <FlatList data={list} keyExtractor={item => String(item.id)} onEndReached={() => { void load() }} onEndReachedThreshold={0.5} renderItem={({ item }) => (
    <TouchableOpacity style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}>
      {item.picUrl ? <Image source={{ uri: item.picUrl }} style={styles.pic} /> : <View style={{ ...styles.pic, backgroundColor: theme['c-primary-background'] }} />}
      <View style={styles.info}><Text>{item.name}</Text><Text size={12} color={theme['c-font-label']}>{item.albumSize ? `${item.albumSize} albums` : ''}</Text></View>
    </TouchableOpacity>
  )} />
})
const styles = createStyle({ item: { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1 }, pic: { width: 48, height: 48, borderRadius: 24, marginRight: 10 }, info: { flex: 1 } })
