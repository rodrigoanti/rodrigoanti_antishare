import type { AntishareApi } from '../../shared/types'

const stubError = (action: string): string =>
  `IPC no disponible (${action}). Espera a que el Backend exponga window.antishare.`

function createStub(): AntishareApi {
  const fail = (action: string) => async () => ({ ok: false, error: stubError(action) })
  return {
    platform: 'unknown',
    getPathForFile: () => '',
    selectFolder: async () => {
      console.warn(stubError('selectFolder'))
      return null
    },
    selectFiles: async () => {
      console.warn(stubError('selectFiles'))
      return []
    },
    listLocal: fail('listLocal'),
    diagnoseNetwork: async () => ({ checks: [], summaryEs: stubError('diagnoseNetwork') }),
    listGroups: async () => ({
      serverRunning: false,
      deviceName: '',
      groups: [],
      discovered: []
    }),
    createGroup: fail('createGroup'),
    joinGroup: fail('joinGroup'),
    updateGroup: fail('updateGroup'),
    leaveGroup: fail('leaveGroup'),
    onImportProgress: () => () => undefined,
    onExportProgress: () => () => undefined,
    importLocal: async () => ({ ok: false, imported: 0, error: stubError('importLocal') }),
    exportItems: async () => ({ ok: false, exported: 0, error: stubError('exportItems') }),
    mkdirLocal: fail('mkdirLocal'),
    renameLocal: fail('renameLocal'),
    moveLocal: fail('moveLocal'),
    removeLocal: fail('removeLocal'),
    openFile: fail('openFile'),
    revealFile: fail('revealFile'),
    showItemInFolder: fail('showItemInFolder')
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

/** Raw fetch/OS noise vs a classified HTTP/TCP failure to the peer share. */
export function isNetworkReachabilityError(raw: string | undefined): boolean {
  if (!raw) return false
  const lower = raw.toLowerCase()
  return (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('offline') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted') ||
    lower.includes('unreachable') ||
    lower.includes('inalcanzable') ||
    lower.includes('no responde') ||
    /tcp[:\s]?8765/.test(lower) ||
    (lower.includes('discovery') &&
      (lower.includes('http') || lower.includes('tcp') || lower.includes('8765')))
  )
}

/** Backend already sent a user-facing Spanish explanation — do not replace it. */
export function isClearBackendMessage(raw: string): boolean {
  const text = raw.trim()
  if (text.length < 12) return false
  if (/[áéíóúñ¿¡]/i.test(text)) return true
  return /\b(revisá|revisa|firewall|discovery|inalcanzable|no responde|red local|wi-?fi)\b/i.test(
    text
  )
}

export function mapIpcError(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  const lower = raw.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return 'Clave del grupo incorrecta.'
  }
  if (lower.includes('403') || lower.includes('permission') || lower.includes('eacces')) {
    return 'Sin permiso para acceder a este recurso.'
  }
  if (isClearBackendMessage(raw)) return raw
  if (isNetworkReachabilityError(raw)) {
    return 'Visible en la red, sin respuesta en TCP 8765.'
  }
  return raw
}
