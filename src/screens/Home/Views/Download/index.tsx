import { useEffect, useState } from 'react'
import { Alert, FlatList, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { getDownloadPath } from '@/utils/data'
import { pauseAllTasks, pauseTask, removeTask, resumeAllTasks, retryTask, setDownloadDirectory } from '@/core/download'
import { useDownloadTasks } from '@/store/download/hook'
import { selectManagedFolder } from '@/utils/fs'

const formatBytes = (value: number) => {
  if (!value) return ''
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

const statusText = (task: LX.Download.DownloadTask) => {
  switch (task.status) {
    case 'completed': return global.i18n.t('download_status_completed')
    case 'error': return task.error ?? global.i18n.t('download_status_failed')
    case 'pause': return global.i18n.t('download_status_paused')
    case 'resolving': return global.i18n.t('download_status_resolving')
    case 'finalizing': return global.i18n.t('download_status_finalizing')
    case 'waiting': return global.i18n.t('download_status_waiting')
    default: {
      const progress = Math.round(task.progress.progress * 100)
      const size = task.progress.total ? `${formatBytes(task.progress.downloaded)} / ${formatBytes(task.progress.total)}` : formatBytes(task.progress.downloaded)
      return `${progress}%${size ? ` · ${size}` : ''}${task.progress.speed ? ` · ${task.progress.speed}` : ''}`
    }
  }
}

const DownloadItem = ({ task, onRemove, onToggle }: {
  task: LX.Download.DownloadTask
  onRemove: () => void
  onToggle: () => void
}) => {
  const theme = useTheme()
  const canToggle = task.status != 'completed' && task.status != 'finalizing'
  const toggleIcon = task.status == 'run' || task.status == 'waiting' || task.status == 'resolving' ? 'pause' : 'play-outline'
  return (
    <View style={{ ...styles.item, borderBottomColor: theme['c-border-background'] }}>
      <View style={styles.itemBody}>
        <Text numberOfLines={1}>{task.musicInfo.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{task.musicInfo.singer} · {task.quality}</Text>
        <Text size={12} color={task.status == 'error' ? theme['c-600'] : theme['c-font-label']} numberOfLines={1}>{statusText(task)}</Text>
      </View>
      {canToggle ? <TouchableOpacity style={styles.action} onPress={onToggle}><Icon name={toggleIcon} color={theme['c-button-font']} /></TouchableOpacity> : null}
      <TouchableOpacity style={styles.action} onPress={onRemove}><Icon name="remove" color={theme['c-button-font']} /></TouchableOpacity>
    </View>
  )
}

export default () => {
  const theme = useTheme()
  const tasks = useDownloadTasks()
  const [directory, setDirectory] = useState<LX.Download.DownloadDirectory | null>(null)

  useEffect(() => { void getDownloadPath().then(setDirectory) }, [])

  const chooseDownloadPath = async() => {
    try {
      const folder = await selectManagedFolder(true)
      if (!folder?.path) return
      const nextDirectory = { uri: folder.path, name: folder.name || folder.path }
      await setDownloadDirectory(nextDirectory)
      setDirectory(nextDirectory)
    } catch (error: unknown) {
      toast(error instanceof Error ? error.message : global.i18n.t('download_path_select_failed'), 'long')
    }
  }

  const handleRemove = (task: LX.Download.DownloadTask) => {
    if (task.status != 'completed') {
      void removeTask(task.id)
      return
    }
    Alert.alert(global.i18n.t('download_remove_title'), task.musicInfo.name, [
      { text: global.i18n.t('cancel'), style: 'cancel' },
      { text: global.i18n.t('download_remove_record'), onPress: () => { void removeTask(task.id) } },
      { text: global.i18n.t('download_remove_file'), style: 'destructive', onPress: () => { void removeTask(task.id, true) } },
    ])
  }

  const handleToggle = (task: LX.Download.DownloadTask) => {
    if (task.status == 'run' || task.status == 'waiting' || task.status == 'resolving') void pauseTask(task.id)
    else {
      void retryTask(task.id).catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), 'long')
      })
    }
  }

  return (
    <View style={{ ...styles.container, backgroundColor: theme['c-content-background'] }}>
      <View style={{ ...styles.pathRow, borderBottomColor: theme['c-border-background'] }}>
        <View style={styles.pathText}>
          <Text>{global.i18n.t('download_directory')}</Text>
          <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{directory?.name ?? global.i18n.t('download_directory_unset')}</Text>
        </View>
        <TouchableOpacity style={styles.pathButton} onPress={() => { void chooseDownloadPath() }}><Icon name="sd-card" color={theme['c-button-font']} size={18} /></TouchableOpacity>
      </View>
      <View style={styles.toolbar}>
        <TouchableOpacity style={styles.toolbarButton} onPress={() => { void pauseAllTasks() }}><Icon name="pause" color={theme['c-button-font']} size={17} /><Text size={13}>{global.i18n.t('download_pause_all')}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.toolbarButton} onPress={() => { void resumeAllTasks() }}><Icon name="play-outline" color={theme['c-button-font']} size={17} /><Text size={13}>{global.i18n.t('download_resume_all')}</Text></TouchableOpacity>
      </View>
      <FlatList
        data={tasks}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <DownloadItem task={item} onToggle={() => { handleToggle(item) }} onRemove={() => { handleRemove(item) }} />}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{global.i18n.t('download_empty')}</Text>}
      />
    </View>
  )
}

const styles = createStyle({
  container: { flex: 1 },
  pathRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  pathText: { flex: 1 },
  pathButton: { width: 42, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 4 },
  toolbar: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6 },
  toolbarButton: { height: 36, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' },
  item: { minHeight: 72, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  itemBody: { flex: 1, paddingRight: 8 },
  action: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingTop: 30 },
})
