import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { DirEntry, ShareStatus } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Button } from '../ui'

interface LocalFolderProps {
  status: ShareStatus | null
  onOpenSettings: () => void
}

function joinPath(parent: string, name: string): string {
  if (!parent || parent === '/') return name
  return `${parent.replace(/\/+$/, '')}/${name}`
}

function parentPath(path: string): string {
  if (!path || path === '/') return ''
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function listLocalPath(path: string) {
  const api = getApi()
  return api.listLocal({ path: path || undefined })
}

export function LocalFolder({ status, onOpenSettings }: LocalFolderProps): ReactElement {
  const api = getApi()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const hasLoadedOnce = useRef(false)

  const running = status?.running ?? false

  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean)
    const items: { label: string; path: string }[] = [{ label: 'Raíz', path: '' }]
    let acc = ''
    for (const part of parts) {
      acc = joinPath(acc, part)
      items.push({ label: part, path: acc })
    }
    return items
  }, [path])

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true
      if (!running) {
        setEntries([])
        setError(null)
        setLoading(false)
        hasLoadedOnce.current = false
        return
      }
      if (!silent) {
        setLoading(true)
        setError(null)
      }
      const result = await listLocalPath(path)
      if (!result.ok) {
        if (!silent) {
          setEntries([])
          setError(mapIpcError(result.error, 'No se pudo listar la carpeta.'))
        } else {
          setError(mapIpcError(result.error, 'No se pudo actualizar la carpeta.'))
        }
      } else {
        const sorted = [...(result.entries ?? [])].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name, 'es')
        })
        setEntries(sorted)
        setError(null)
        hasLoadedOnce.current = true
      }
      if (!silent) setLoading(false)
    },
    [path, running]
  )

  useEffect(() => {
    hasLoadedOnce.current = false
    void load({ silent: false })
  }, [load])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => void load({ silent: true }), 5000)
    return () => window.clearInterval(id)
  }, [running, load])

  useEffect(() => {
    if (!running) setPath('')
  }, [running])

  async function downloadFile(entry: DirEntry): Promise<void> {
    const baseUrl = status?.urls?.[0]?.replace(/\/+$/, '')
    if (!baseUrl) return
    setBusyFile(entry.path)
    setError(null)
    const settings = await api.getSettings()
    const result = await api.remoteDownload({
      baseUrl,
      path: entry.path,
      token: settings.token
    })
    if (!result.ok) {
      setError(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
    }
    setBusyFile(null)
  }

  const showLoading = loading && !hasLoadedOnce.current

  return (
    <section className="panel home-panel" aria-labelledby="local-title">
      <div className="panel-head">
        <h2 id="local-title">Mi carpeta</h2>
        {running && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load({ silent: false })}
            disabled={loading}
          >
            Actualizar
          </Button>
        )}
      </div>

      {!running && (
        <div className="state-box empty">
          <p>Todavía no estás compartiendo.</p>
          <Button variant="primary" size="md" onClick={onOpenSettings}>
            Configurar carpeta
          </Button>
        </div>
      )}

      {running && (
        <>
          <nav className="breadcrumb" aria-label="Ruta local">
            {crumbs.map((crumb, i) => (
              <span key={crumb.path || 'root'}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button type="button" className="crumb" onClick={() => setPath(crumb.path)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>

          {path && (
            <div className="toolbar">
              <Button variant="ghost" size="sm" onClick={() => setPath(parentPath(path))}>
                Subir nivel
              </Button>
            </div>
          )}

          {showLoading && <div className="state-box">Cargando…</div>}

          {!showLoading && entries.length === 0 && !error && (
            <div className="state-box empty">Esta carpeta está vacía.</div>
          )}

          {!showLoading && entries.length > 0 && (
            <ul className="file-list" aria-label="Archivos locales">
              {entries.map((entry) => (
                <li key={entry.path} className="file-row">
                  {entry.isDir ? (
                    <button
                      type="button"
                      className="file-link dir"
                      onClick={() => setPath(entry.path || joinPath(path, entry.name))}
                    >
                      {entry.name}/
                    </button>
                  ) : (
                    <span className="file-name">{entry.name}</span>
                  )}
                  <span className="file-meta muted">{formatSize(entry.size, entry.isDir)}</span>
                  {!entry.isDir && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyFile === entry.path}
                      onClick={() => void downloadFile(entry)}
                    >
                      {busyFile === entry.path ? '…' : 'Descargar'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <div className="state-box error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}
