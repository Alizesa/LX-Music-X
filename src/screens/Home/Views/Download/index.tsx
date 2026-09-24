import { useEffect, useState } from 'react'
import { Alert, type AlertButton, FlatList, TouchableOpacity, View } from 'react-native'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { createStyle, toast } from '@/utils/tools'
import { getDownloadPath } from '@/utils/data'
import { pauseAllTasks, pauseTask, removeTasks, resumeAllTasks, retryTask, setDownloadDirectory } from '@/core/download'
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

const DownloadItem = ({ task, isSelected, isMultiSelect, onPress, onLongPress, onToggle }: {
  task: LX.Download.DownloadTask
  isSelected: boolean
  isMultiSelect: boolean
  onPress: () => void
  onLongPress: () => void
  onToggle: () => void
}) => {
  const theme = useTheme()
  const canToggle = task.status != 'completed' && task.status != 'finalizing'
  const toggleIcon = task.status == 'run' || task.status == 'waiting' || task.status == 'resolving' ? 'pause' : 'play-outline'
  return (
    <View style={{ ...styles.item, borderBottomColor: theme['c-border-background'], backgroundColor: isSelected ? theme['c-primary-background-hover'] : 'rgba(0,0,0,0)' }}>
      <TouchableOpacity style={styles.itemBody} activeOpacity={0.7} onPress={onPress} onLongPress={onLongPress}>
        <Text numberOfLines={1}>{task.musicInfo.name}</Text>
        <Text size={12} color={theme['c-font-label']} numberOfLines={1}>{task.musicInfo.singer} · {task.quality}</Text>
        <Text size={12} color={task.status == 'error' ? theme['c-600'] : theme['c-font-label']} numberOfLines={1}>{statusText(task)}</Text>
      </TouchableOpacity>
      {canToggle && !isMultiSelect ? <TouchableOpacity style={styles.action} onPress={onToggle}><Icon name={toggleIcon} color={theme['c-button-font']} /></TouchableOpacity> : null}
    </View>
  )
}

export default () => {
  const theme = useTheme()
  const tasks = useDownloadTasks()
  const [directory, setDirectory] = useState<LX.Download.DownloadDirectory | null>(null)
  const [isMultiSelect, setIsMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())

  useEffect(() => { void getDownloadPath().then(setDirectory) }, [])

  // 任务被删光后没有可操作的对象了，顺手退出多选，免得留下一条空栏
  useEffect(() => {
    if (!tasks.length && isMultiSelect) {
      setIsMultiSelect(false)
      setSelectedIds(new Set())
    }
  }, [tasks.length, isMultiSelect])

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

  const exitSelect = () => {
    setIsMultiSelect(false)
    setSelectedIds(new Set())
  }

  const enterSelect = (id: string) => {
    setIsMultiSelect(true)
    setSelectedIds(new Set([id]))
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 从 tasks 派生计数，而不是直接用 selectedIds.size：任务可能在别处被移除
  // （例如在本地音乐列表删歌会连带移除下载记录），集合里会残留已不存在的 id，
  // 直接用 size 会把它们也算进去
  const selectedCount = tasks.reduce((count, task) => selectedIds.has(task.id) ? count + 1 : count, 0)

  const handleSelectAll = () => {
    if (tasks.length && selectedCount == tasks.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(tasks.map(task => task.id)))
  }

  const handleDelete = () => {
    const selected = tasks.filter(task => selectedIds.has(task.id))
    if (!selected.length) return
    const ids = selected.map(task => task.id)
    const hasCompleted = selected.some(task => task.status == 'completed')
    const doRemove = (deleteFile: boolean) => {
      void removeTasks(ids, deleteFile).catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), 'long')
      })
      exitSelect()
    }
    const buttons: AlertButton[] = [
      { text: global.i18n.t('cancel'), style: 'cancel' },
      { text: global.i18n.t('download_remove_record'), onPress: () => { doRemove(false) } },
    ]
    // 只有已完成的任务才有文件可删，没选中这类任务时不给出这个选项
    if (hasCompleted) buttons.push({ text: global.i18n.t('download_remove_file'), style: 'destructive', onPress: () => { doRemove(true) } })
    Alert.alert(
      global.i18n.t('download_remove_title'),
      global.i18n.t('download_remove_message', { num: ids.length }),
      buttons,
    )
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
    // 同上：不刷不透明底色，否则会盖住 PageContent 的背景图
    <View style={styles.container}>
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
        renderItem={({ item }) => (
          <DownloadItem
            task={item}
            isSelected={selectedIds.has(item.id)}
            isMultiSelect={isMultiSelect}
            onPress={() => { if (isMultiSelect) toggleSelect(item.id) }}
            onLongPress={() => { if (!isMultiSelect) enterSelect(item.id) }}
            onToggle={() => { handleToggle(item) }}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty} color={theme['c-font-label']}>{global.i18n.t('download_empty')}</Text>}
      />
      {isMultiSelect
        ? <View style={{ ...styles.selectBar, borderTopColor: theme['c-border-background'], backgroundColor: theme['c-content-background'] }}>
            <TouchableOpacity style={styles.selectBarButton} onPress={handleSelectAll}>
              <Text size={13}>{global.i18n.t(selectedCount && selectedCount == tasks.length ? 'list_select_unall' : 'list_select_all')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectBarButton} disabled={!selectedCount} onPress={handleDelete}>
              <Text size={13} color={selectedCount ? theme['c-600'] : theme['c-font-label']}>{`${global.i18n.t('delete')} (${selectedCount})`}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectBarButton} onPress={exitSelect}>
              <Text size={13}>{global.i18n.t('list_select_cancel')}</Text>
            </TouchableOpacity>
          </View>
        : null}
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
  itemBody: { flex: 1, paddingRight: 8, justifyContent: 'center' },
  action: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingTop: 30 },
  selectBar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, paddingVertical: 4 },
  selectBarButton: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
})
