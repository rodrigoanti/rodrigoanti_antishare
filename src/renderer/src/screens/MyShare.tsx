import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ShareStatus } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Alert, Button, Input, LockBadge } from '../ui'
import { NetworkStatus } from './NetworkStatus'

function isLoopbackShareUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return /(?:^|\/\/)(?:127\.0\.0\.1|localhost|\[::1\])/i.test(url)
  }
}

function splitShareUrls(urls: string[]): { lan: string[]; local: string[] } {
  const lan: string[] = []
  const local: string[] = []
  for (const url of urls) {
    if (isLoopbackShareUrl(url)) local.push(url)
    else lan.push(url)
  }
  return { lan, local }
}

interface ShareSettingsProps {
  onOpenLocal?: () => void
  onStatusChange?: (status: ShareStatus) => void
}

export function ShareSettings({ onOpenLocal, onStatusChange }: ShareSettingsProps): ReactElement {
  const api = getApi()
  const [folder, setFolder] = useState('')
  const [token, setToken] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [status, setStatus] = useState<ShareStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [restoredNote, setRestoredNote] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const skipNextSave = useRef(true)

  const applyStatus = useCallback(
    (next: ShareStatus) => {
      setStatus(next)
      onStatusChange?.(next)
    },
    [onStatusChange]
  )

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.shareStatus()
      applyStatus(next)
    } catch (e) {
      setError(mapIpcError(e instanceof Error ? e.message : String(e), 'No se pudo leer el estado.'))
    }
  }, [api, applyStatus])

  const loadPersisted = useCallback(async () => {
    try {
      const [settings, share] = await Promise.all([api.getSettings(), api.shareStatus()])
      skipNextSave.current = true
      setFolder(settings.folder ?? '')
      setToken(settings.token ?? '')
      setAutoStart(settings.autoStart)
      applyStatus(share)
      if (share.running && settings.autoStart) {
        setRestoredNote(true)
      }
      setHydrated(true)
    } catch (e) {
      setError(
        mapIpcError(e instanceof Error ? e.message : String(e), 'No se pudo cargar la configuración.')
      )
      setHydrated(true)
    }
  }, [api, applyStatus])

  useEffect(() => {
    void loadPersisted()
  }, [loadPersisted])

  useEffect(() => {
    const id = window.setInterval(() => void refreshStatus(), 2500)
    return () => window.clearInterval(id)
  }, [refreshStatus])

  useEffect(() => {
    if (!hydrated) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void api.setSettings({
        folder: folder.trim() || null,
        token: token.trim(),
        autoStart
      })
    }, 400)
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
    }
  }, [api, folder, token, autoStart, hydrated])

  async function pickFolder(): Promise<void> {
    setError(null)
    const path = await api.selectFolder()
    if (path) {
      setFolder(path)
      setAutoStart(true)
    }
  }

  async function onStart(): Promise<void> {
    setBusy(true)
    setError(null)
    if (!folder.trim()) {
      setError('Elegí una carpeta para compartir.')
      setBusy(false)
      return
    }
    const result = await api.startShare({
      folder: folder.trim(),
      token: token.trim() || undefined
    })
    if (!result.ok) {
      setError(mapIpcError(result.error, 'No se pudo iniciar el share.'))
    } else {
      skipNextSave.current = true
      setAutoStart(true)
      setRestoredNote(false)
    }
    await refreshStatus()
    setBusy(false)
  }

  async function onStop(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = await api.stopShare()
    if (!result.ok) {
      setError(mapIpcError(result.error, 'No se pudo detener el share.'))
    } else {
      skipNextSave.current = true
      setAutoStart(false)
      setRestoredNote(false)
    }
    await refreshStatus()
    setBusy(false)
  }

  async function copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      window.setTimeout(() => setCopied(null), 1600)
    } catch {
      setError('No se pudo copiar al portapapeles.')
    }
  }

  const running = status?.running ?? false
  const urls = status?.urls ?? []
  const { lan: lanUrls, local: localUrls } = useMemo(() => splitShareUrls(urls), [urls])
  const missingLan = running && lanUrls.length === 0

  return (
    <div className="settings-body">
      {restoredNote && running && (
        <p className="settings-note" role="status">
          Se reanudó automáticamente al iniciar.
        </p>
      )}

      <div className="form-grid">
        <div className="field">
          <label htmlFor="folder">Carpeta</label>
          <div className="row">
            <Input
              id="folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="/ruta/a/compartir"
              readOnly={running}
            />
            <Button variant="secondary" size="md" onClick={() => void pickFolder()} disabled={busy || running}>
              Elegir…
            </Button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="token">Clave (opcional)</label>
          <Input
            id="token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Vacío = sin autenticación"
            disabled={running}
          />
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => setAutoStart(e.target.checked)}
            disabled={!folder.trim()}
          />
          Reanudar al iniciar
        </label>

        <div className="row">
          {!running ? (
            <Button variant="primary" size="md" onClick={() => void onStart()} disabled={busy} loading={busy}>
              Iniciar
            </Button>
          ) : (
            <Button variant="danger" size="md" onClick={() => void onStop()} disabled={busy} loading={busy}>
              Detener
            </Button>
          )}
          {running && onOpenLocal && (
            <Button variant="ghost" size="md" onClick={onOpenLocal}>
              Abrir mi carpeta
            </Button>
          )}
        </div>
      </div>

      <div className="status-bar" role="status" aria-live="polite">
        <span className={`status-dot ${running ? 'on' : 'off'}`} aria-hidden="true" />
        <span className="status-label">{running ? 'En ejecución' : 'Detenido'}</span>
        {status?.tokenRequired ? <LockBadge /> : null}
      </div>

      {running && (
        <div className="url-groups">
          {missingLan && (
            <Alert variant="warning" title="Sin IP de red">
              Otras PCs no van a poder entrar: no hay una dirección LAN usable (solo localhost).
              Revisá Wi‑Fi o Ethernet, el permiso de Red local en macOS, y que el diagnóstico de
              red vea una IP LAN.
            </Alert>
          )}

          {lanUrls.length > 0 && (
            <div className="url-group">
              <h3 className="url-group-title" id="lan-urls-title">
                En la red — para otras PCs
              </h3>
              <p className="url-group-hint">
                Compartí esta dirección con la otra máquina. 127.0.0.1 no sirve fuera de esta PC.
              </p>
              <ul className="url-list" aria-labelledby="lan-urls-title">
                {lanUrls.map((url) => (
                  <li key={url} className="url-item url-item-lan">
                    <span className="mono">{url}</span>
                    <Button variant="secondary" size="sm" onClick={() => void copyUrl(url)}>
                      {copied === url ? 'Copiado' : 'Copiar'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {localUrls.length > 0 && (
            <div className="url-group">
              <h3 className="url-group-title" id="local-urls-title">
                Solo esta máquina
              </h3>
              <p className="url-group-hint">
                Localhost y 127.0.0.1 solo abren acá. Otras PCs no pueden usarlas.
              </p>
              <ul className="url-list" aria-labelledby="local-urls-title">
                {localUrls.map((url) => (
                  <li key={url} className="url-item url-item-local">
                    <span className="mono">{url}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="state-box error" role="alert">
          {error}
        </div>
      )}

      <NetworkStatus />
    </div>
  )
}

/** @deprecated Prefer ShareSettings — kept as alias for imports. */
export const MyShare = ShareSettings
