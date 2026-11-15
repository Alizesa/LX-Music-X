/**
 * @format
 */
import './shim'
import './src/app'
import { AppRegistry } from 'react-native'

AppRegistry.registerHeadlessTask('LXDownloadQueue', () => async data => {
  const { runDownloadQueueDispatch } = await import('./src/core/downloadService')
  await runDownloadQueueDispatch(data)
})
