import type { AntishareApi } from '../shared/types'

declare global {
  interface Window {
    antishare: AntishareApi
  }
}

export {}
