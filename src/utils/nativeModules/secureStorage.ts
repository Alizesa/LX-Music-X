import { NativeModules, type NativeModule } from 'react-native'

interface SecureStorageNativeModule extends NativeModule {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

const SecureStorageModule = NativeModules.SecureStorageModule as SecureStorageNativeModule

export const getSecureItem = async(key: string) => SecureStorageModule.getItem(key)
export const setSecureItem = async(key: string, value: string) => SecureStorageModule.setItem(key, value)
export const removeSecureItem = async(key: string) => SecureStorageModule.removeItem(key)
