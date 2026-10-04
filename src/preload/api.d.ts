import type { TorraApi } from '../preload/index'

declare global {
  interface Window {
    torra: TorraApi
  }
}

export {}
