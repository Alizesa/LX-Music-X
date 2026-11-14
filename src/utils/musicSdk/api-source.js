import settingState from '@/store/setting/state'

export const apis = source => {
  if (/^user_api/.test(settingState.setting['common.apiSource']) && global.lx.apis[source]) return global.lx.apis[source]
  throw new Error('Unsupported music source')
}
