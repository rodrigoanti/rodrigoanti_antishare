import type { AntishareApi, ShareSettings } from '../../shared/types'

const stubError = (action: string): string =>
  `IPC no disponible (${action}). Esperá a que el Backend exponga window.antishare.`

const emptySettings = (): ShareSettings => ({
  folder: null,
  autoStart: false
})

function createStub(): AntishareApi {
  return {
    selectFolder: async () => {
      console.warn(stubError('selectFolder'))
      return null
    },
    startShare: async () => ({ ok: false, urls: [], port: 0, error: stubError('startShare') }),
    stopShare: async () => ({ ok: false, error: stubError('stopShare') }),
    shareStatus: async () => ({
      running: false,
      folder: null,
      port: null,
      urls: [],
      tokenRequired: false
    }),
    listLocal: async () => ({ ok: false, error: stubError('listLocal') }),
    getSettings: async () => emptySettings(),
    setSettings: async (partial) => ({ ...emptySettings(), ...partial }),
    diagnoseNetwork: async () => ({
      checks: [],
      summaryEs: stubError('diagnoseNetwork')
    }),
    startDrag: async () => ({ ok: false, error: stubError('startDrag') }),
    prepareDrag: async () => ({ ok: false, error: stubError('prepareDrag') }),
    startDragLocal: async () => ({ ok: false, error: stubError('startDragLocal') }),
    listPeers: async () => [],
    onPeersUpdate: () => () => undefined,
    addManualPeer: async () => ({ ok: false, error: stubError('addManualPeer') }),
    removeManualPeer: async () => ({ ok: false }),
    remoteList: async () => ({ ok: false, error: stubError('remoteList') }),
    remoteDownload: async () => ({ ok: false, error: stubError('remoteDownload') }),
    remoteUpload: async () => ({ ok: false, error: stubError('remoteUpload') }),
    showItemInFolder: async () => ({ ok: false, error: stubError('showItemInFolder') })
  }
}

let cached: AntishareApi | null = null

export function getApi(): AntishareApi {
  if (cached) return cached
  if (typeof window !== 'undefined' && window.antishare) {
    cached = window.antishare
    return cached
  }
  cached = createStub()
  return cached
}

export function mapIpcError(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  const lower = raw.toLowerCase()
  if (lower.includes('401') || lower.includes('token') || lower.includes('unauthorized')) {
    return 'Token inválido o requerido. Revisá el token e intentá de nuevo.'
  }
  if (lower.includes('403') || lower.includes('permission') || lower.includes('eacces')) {
    return 'Sin permiso para acceder a este recurso.'
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('offline') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('aborted') ||
    lower.includes('unreachable')
  ) {
    return 'Peer fuera de línea o no alcanzable en la LAN.'
  }
  return raw
}
