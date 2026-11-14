import { NativeModules } from 'react-native'

const { CryptoModule } = NativeModules
enum KEY_PREFIX {
  publicKeyStart = '-----BEGIN PUBLIC KEY-----',
  publicKeyEnd = '-----END PUBLIC KEY-----',
}

export enum RSA_PADDING {
  OAEPWithSHA1AndMGF1Padding = 'RSA/ECB/OAEPWithSHA1AndMGF1Padding', NoPadding = 'RSA/ECB/NoPadding',
}

export enum AES_MODE {
  CBC_128_PKCS7Padding = 'AES/CBC/PKCS7Padding', ECB_128_NoPadding = 'AES',
}

export const rsaEncryptSync = (text: string, key: string, padding: RSA_PADDING): string => {
  return CryptoModule.rsaEncryptSync(text, key
    .replace(KEY_PREFIX.publicKeyStart, '')
    .replace(KEY_PREFIX.publicKeyEnd, ''), padding)
}

export const aesEncryptSync = (text: string, key: string, vi: string, mode: AES_MODE): string => {
  return CryptoModule.aesEncryptSync(text, key, vi, mode)
}

export const hashSHA1 = async(text: any) => {
  try {
    return await CryptoModule.sha1(text)
  } catch (error) {
    console.error('生成SHA1出现问题:', error)
    throw error
  }
}
