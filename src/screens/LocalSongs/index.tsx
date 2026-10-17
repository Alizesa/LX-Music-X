import { useCallback, useEffect, useState } from 'react'
import { FlatList, TouchableOpacity, View } from 'react-native'
import PageContent from '@/components/PageContent'
import StatusBar from '@/components/common/StatusBar'
import SimpleHeader from '@/components/SimpleHeader'
import PlayerBar from '@/components/player/PlayerBar'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS, LIST_IDS } from '@/config/constant'
import { addListMusics, getListMusics } from '@/core/list'
import { releaseLocalList, retainLocalList } from '@/core/localList'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { scanAudioFiles, readMetadata } from '@/utils/localMediaMetadata'
import { selectManagedFolder } from '@/utils/fs'
import { buildLocalMusicInfo, buildLocalMusicInfoByFilePath } from '@/utils/music'
import settingState from '@/store/setting/state'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'

// 一次并行读多少个文件的元数据。读一个文件的开销不小，全量 Promise.all 在几百首的
// 目录上会把内存顶上去，分批更稳
const READ_BATCH = 8

// 本地歌曲。内容是 LIST_IDS.LOCAL 这个列表：下载完成的歌也会写进来
// （见 core/download.ts 的 finalizeTask），所以这里同时也是「已下载」的入口。
// 页面上的导入按钮用来把设备里已有的音频文件收进来。
export default ({ componentId }: { componentId: string }) => {
  const t = useI18n()
  const theme = useTheme()
  const [list, setList] = useState<LX.Music.MusicInfoLocal[]>([])
  const [importing, setImporting] = useState(false)

  const load = useCallback(async() => {
    setList((await getListMusics(LIST_IDS.LOCAL)) as LX.Music.MusicInfoLocal[])
  }, [])

  useEffect(() => {
    setComponentId(COMPONENT_IDS.localSongs, componentId)
    // 页面打开期间持有完整列表；离开后交给 core/localList 判断是否释放
    void retainLocalList('screen:localSongs').then(list => { setList(list as LX.Music.MusicInfoLocal[]) })
    return () => { releaseLocalList('screen:localSongs') }
  }, [componentId])

  const importSongs = useCallback(async() => {
    if (importing) return
    let folderPath = ''
    try {
      const folder = await selectManagedFolder(true)
      folderPath = folder?.path ?? ''
    } catch {
      toast(t('local_songs_import_failed'), 'long')
      return
    }
    if (!folderPath) return
    setImporting(true)
    try {
      const files = await scanAudioFiles(folderPath)
      if (!files.length) {
        toast(t('local_songs_empty'), 'long')
        return
      }
      const infos: LX.Music.MusicInfoLocal[] = []
      for (let index = 0; index < files.length; index += READ_BATCH) {
        const batch = files.slice(index, index + READ_BATCH)
        const read = await Promise.all(batch.map(async file =>
          readMetadata(file.path).catch(() => null),
        ))
        batch.forEach((file, offset) => {
          const metadata = read[offset]
          infos.push(metadata ? buildLocalMusicInfo(file.path, metadata) : buildLocalMusicInfoByFilePath(file))
        })
      }
      await addListMusics(LIST_IDS.LOCAL, infos, settingState.setting['list.addMusicLocationType'])
      await load()
      toast(t('local_songs_imported', { num: infos.length }))
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : t('local_songs_import_failed'), 'long')
    } finally {
      setImporting(false)
    }
  }, [importing, load, t])

  return (
    <PageContent>
      <StatusBar />
      <SimpleHeader
        componentId={componentId}
        title={t('mine_local_songs')}
        right={
          <TouchableOpacity style={styles.importBtn} disabled={importing} onPress={() => { void importSongs() }}>
            <Text size={13} color={importing ? theme['c-font-label'] : theme['c-primary-font']}>
              {t(importing ? 'local_songs_importing' : 'local_songs_import')}
            </Text>
          </TouchableOpacity>
        }
      />
      <FlatList
        style={styles.list}
        data={list}
        keyExtractor={item => item.id}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{t('local_songs_empty')}</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}
            activeOpacity={0.7}
            onPress={() => { addTempPlayList([{ listId: null, musicInfo: item, isTop: true }]) }}
          >
            {item.meta.picUrl
              ? <Image url={item.meta.picUrl} style={styles.pic} />
              : <View style={{ ...styles.pic, backgroundColor: theme['c-primary-background'] }} />}
            <View style={styles.info}>
              <Text numberOfLines={1}>{item.name}</Text>
              <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{item.singer}</Text>
            </View>
          </TouchableOpacity>
        )}
      />
      <PlayerBar />
    </PageContent>
  )
}

const styles = createStyle({
  importBtn: { paddingHorizontal: 14, paddingVertical: 8 },
  list: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  pic: { width: 44, height: 44, borderRadius: 3 },
  info: { flex: 1, paddingLeft: 10 },
  empty: { textAlign: 'center', paddingVertical: 40 },
})
