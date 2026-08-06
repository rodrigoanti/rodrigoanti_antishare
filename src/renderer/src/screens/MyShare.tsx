import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { getApi, mapIpcError } from '../api'
import { useShareStatus } from '../shareStatus'
import { Alert, Button, Input, LockBadge, toast } from '../ui'
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
}

export function ShareSettings({ onOpenLocal }: ShareSettingsProps): ReactElement {
  const api = getApi()
  const { status, refreshStatus, setStatus } = useShareStatus()
  const [folder, setFolder] = useState('')
  const [token, setToken] = useState('')
  const [autoStart, setAutoStart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoredNote, setRestoredNote] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const skipNextSave = useRef(true)

  const loadPersisted = useCallback(async () => {
    try {
      const [settings, share] = await Promise.all([api.getSettings(), api.shareStatus()])
      skipNextSave.current = true
      setFolder(settings.folder ?? '')
      setToken(settings.token ?? '')
      setAutoStart(settings.autoStart)
      setStatus(share)
      if (share.running && settings.autoStart) {
        setRestoredNote(true)
      }
      setHydrated(true)
    } catch (e) {
      toast.error(
        mapIpcError(e instanceof Error ? e.message : String(e), 'No se pudo cargar la configuración.')
      )
      setHydrated(true)
    }
  }, [api, setStatus])

  useEffect(() => {
    void loadPersisted()
  }, [loadPersisted])

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
    const path = await api.selectFolder()
    if (path) {
      setFolder(path)
      setAutoStart(true)
    }
  }

  async function onStart(): Promise<void> {
    setBusy(true)
    if (!folder.trim()) {
      toast.error('Elige una carpeta para compartir.')
      setBusy(false)
      return
    }
    const result = await api.startShare({
      folder: folder.trim(),
      token: token.trim() || undefined
    })
    if (!result.ok) {
      toast.error(mapIpcError(result.error, 'No se pudo iniciar el share.'))
    } else {
      skipNextSave.current = true
      setAutoStart(true)
      setRestoredNote(false)
      toast.success('Compartiendo')
    }
    const next = await refreshStatus()
    if (!next) {
      toast.error('No se pudo leer el estado.')
    }
    setBusy(false)
  }

  async function onStop(): Promise<void> {
    setBusy(true)
    const result = await api.stopShare()
    if (!result.ok) {
      toast.error(mapIpcError(result.error, 'No se pudo detener el share.'))
    } else {
      skipNextSave.current = true
      setAutoStart(false)
      setRestoredNote(false)
      toast.success('Detenido')
    }
    const next = await refreshStatus()
    if (!next) {
      toast.error('No se pudo leer el estado.')
    }
    setBusy(false)
  }

  async function copyUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Copiado')
    } catch {
      toast.error('No se pudo copiar.')
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
              Revisa Wi‑Fi o Ethernet, el permiso de Red local en macOS, y que el diagnóstico de
              red vea una IP LAN.
            </Alert>
          )}

          {lanUrls.length > 0 && (
            <div className="url-group">
              <h3 className="url-group-title" id="lan-urls-title">
                En la red — para otras PCs
              </h3>
              <p className="url-group-hint">
                Comparte esta dirección con la otra máquina. 127.0.0.1 no sirve fuera de esta PC.
              </p>
              <ul className="url-list" aria-labelledby="lan-urls-title">
                {lanUrls.map((url) => (
                  <li key={url} className="url-item url-item-lan">
                    <span className="mono">{url}</span>
                    <Button variant="secondary" size="sm" onClick={() => void copyUrl(url)}>
                      Copiar
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
                Localhost y 127.0.0.1 solo abren aquí. Otras PCs no pueden usarlas.
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

      <NetworkStatus />
    </div>
  )
}

/** @deprecated Prefer ShareSettings — kept as alias for imports. */
export const MyShare = ShareSettings
