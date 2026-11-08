import { createFetchData } from '@/utils/httpRequest'

export const fetchData = createFetchData({
  timeout: 13_000,
  defaults: { credentials: 'omit', cache: 'default' },
})
