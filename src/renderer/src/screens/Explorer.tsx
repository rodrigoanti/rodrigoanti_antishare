import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type { DirEntry } from '../../../shared/types'
import { getApi, isNetworkReachabilityError, mapIpcError } from '../api'
import { isOsFileDrag, markInternalDrag, osDropPaths } from '../osDrop'
import { Alert, Button, Input } from '../ui'
import { PeerReachabilityAlert } from './PeerReachabilityAlert'

export interface ExplorerTarget {
  label: string
  baseUrl: string
  host?: string
  hosts?: string[]
  localHosts?: string[]
  tokenRequired?: boolean
  initialToken?: string
}

interface ExplorerProps {
  target: ExplorerTarget | null
  onBack: () => void
}

function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatMtime(ms: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString('es', {
      dateStyle: 'short',
      timeStyle: 'short'
    })
  } catch {
    return '—'
  }
}

export function Explorer({ target, onBack }: ExplorerProps): ReactElement {
  const api = getApi()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorRaw, setErrorRaw] = useState<string | null>(null)
  const [listUnreachable, setListUnreachable] = useState(false)
  const [token, setToken] = useState('')
  const [tokenReady, setTokenReady] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [savedDownload, setSavedDownload] = useState<{ path: string; name: string } | null>(null)
  const hasLoadedOnce = useRef(false)
  const silentFailStreak = useRef(0)
  /** True while listing fails — poll every 2s until a success, then back to 5s. */
  const connectionUnstable = useRef(false)
  const preparedDragRef = useRef<Map<string, { promise: Promise<string | null>; filePath?: string }>>(
    new Map()
  )
  const suppressClickRef = useRef(false)
  const dropDepthRef = useRef(0)

  useEffect(() => {
    setPath('')
    setEntries([])
    setError(null)
    setErrorRaw(null)
    setListUnreachable(false)
    hasLoadedOnce.current = false
    if (!target) {
      setToken('')
      setTokenReady(false)
      return
    }
    if (target.tokenRequired) {
      const initial = target.initialToken?.trim() ?? ''
      setToken(initial)
      setTokenReady(Boolean(initial))
    } else {
      setToken('')
      setTokenReady(true)
    }
  }, [target])

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
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!target || !tokenReady) return false
      const silent = opts?.silent === true
      if (!silent) {
        setLoading(true)
        setError(null)
        setErrorRaw(null)
        setListUnreachable(false)
      }
      const result = await api.remoteList({
        baseUrl: target.baseUrl,
        path: path || undefined,
        token: token.trim() || undefined
      })
      if (!result.ok) {
        connectionUnstable.current = true
        const unreachable = isNetworkReachabilityError(result.error)
        if (!silent) {
          silentFailStreak.current = 0
          setEntries([])
          setErrorRaw(result.error ?? null)
          setListUnreachable(unreachable)
          setError(mapIpcError(result.error, 'No se pudo listar el directorio.'))
        } else {
          silentFailStreak.current += 1
          if (silentFailStreak.current >= 2) {
            setErrorRaw(result.error ?? null)
            setListUnreachable(unreachable)
            setError(mapIpcError(result.error, 'No se pudo actualizar el directorio.'))
          }
        }
        if (!silent) setLoading(false)
        return false
      }
      const sorted = [...(result.entries ?? [])].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, 'es')
      })
      setEntries(sorted)
      setError(null)
      setErrorRaw(null)
      setListUnreachable(false)
      silentFailStreak.current = 0
      connectionUnstable.current = false
      hasLoadedOnce.current = true
      if (!silent) setLoading(false)
      return true
    },
    [api, path, target, token, tokenReady]
  )

  useEffect(() => {
    hasLoadedOnce.current = false
    silentFailStreak.current = 0
    connectionUnstable.current = false

    if (!target || !tokenReady) return

    let cancelled = false
    let timer: number | undefined

    const run = async (silent: boolean): Promise<void> => {
      if (cancelled) return
      await load({ silent })
      if (cancelled) return
      const delay = connectionUnstable.current ? 2_000 : 5_000
      timer = window.setTimeout(() => void run(true), delay)
    }

    void run(false)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [load, target, tokenReady])

  async function downloadFile(entry: DirEntry): Promise<void> {
    if (!target) return
    setBusyAction(entry.path)
    setError(null)
    setSavedDownload(null)
    const result = await api.remoteDownload({
      baseUrl: target.baseUrl,
      path: entry.path,
      token: token.trim() || undefined
    })
    if (!result.ok) {
      setError(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
    } else if (result.destPath) {
      setSavedDownload({ path: result.destPath, name: entry.name })
    }
    setBusyAction(null)
  }

  async function revealSavedDownload(): Promise<void> {
    if (!savedDownload) return
    const result = await api.showItemInFolder(savedDownload.path)
    if (!result.ok) {
      setError(mapIpcError(result.error, 'No se pudo mostrar el archivo en la carpeta.'))
    }
  }

  function prepareEntryDrag(entry: DirEntry): void {
    if (!target) return
    const existing = preparedDragRef.current.get(entry.path)
    if (existing?.filePath || existing?.promise) return

    setBusyAction(entry.path)
    setError(null)
    const promise = (async (): Promise<string | null> => {
      try {
        const result = await api.prepareDrag({
          kind: 'remote',
          baseUrl: target.baseUrl,
          path: entry.path,
          token: token.trim() || undefined,
          isDir: entry.isDir
        })
        if (!result.ok || !result.filePath) {
          setError(
            mapIpcError(result.error, `No se pudo preparar «${entry.name}» para arrastrar.`)
          )
          preparedDragRef.current.delete(entry.path)
          return null
        }
        const prev = preparedDragRef.current.get(entry.path)
        preparedDragRef.current.set(entry.path, {
          promise: prev?.promise ?? Promise.resolve(result.filePath),
          filePath: result.filePath
        })
        return result.filePath
      } catch (err) {
        setError(
          mapIpcError(
            err instanceof Error ? err.message : String(err),
            `No se pudo preparar «${entry.name}» para arrastrar.`
          )
        )
        preparedDragRef.current.delete(entry.path)
        return null
      } finally {
        setBusyAction((cur) => (cur === entry.path ? null : cur))
      }
    })()
    preparedDragRef.current.set(entry.path, { promise })
  }

  function handleEntryDragStart(entry: DirEntry, e: DragEvent<HTMLElement>): void {
    if (!target) {
      e.preventDefault()
      return
    }
    const filePath = preparedDragRef.current.get(entry.path)?.filePath
    if (!filePath) {
      e.preventDefault()
      return
    }
    suppressClickRef.current = true
    markInternalDrag(e.dataTransfer)
    setError(null)
    const result = api.startDragLocal(filePath, { isDir: entry.isDir })
    if (!result.ok) {
      e.preventDefault()
      suppressClickRef.current = false
      setError(
        mapIpcError(
          result.error,
          `No se pudo arrastrar «${entry.name}» al Finder o Explorador.`
        )
      )
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!target || !files || files.length === 0) return
    setBusyAction('upload')
    setError(null)
    for (const file of Array.from(files)) {
      const localPath = (file as File & { path?: string }).path
      if (!localPath) {
        setError('No se pudo obtener la ruta local del archivo. Usá el diálogo del sistema.')
        setBusyAction(null)
        return
      }
      const result = await api.remoteUpload({
        baseUrl: target.baseUrl,
        path: path || '',
        filePath: localPath,
        token: token.trim() || undefined
      })
      if (!result.ok) {
        setError(mapIpcError(result.error, `No se pudo subir «${file.name}».`))
        setBusyAction(null)
        return
      }
    }
    setBusyAction(null)
    await load({ silent: true })
  }

  useEffect(() => {
    dropDepthRef.current = 0
    setDropActive(false)
  }, [target, path, tokenReady])

  function acceptOsDrop(e: DragEvent): boolean {
    if (!target || !tokenReady) return false
    if (!isOsFileDrag(e.dataTransfer)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    return true
  }

  function handleOsDragEnter(e: DragEvent): void {
    if (!acceptOsDrop(e)) return
    dropDepthRef.current += 1
    setDropActive(true)
  }

  function handleOsDragOver(e: DragEvent): void {
    if (!acceptOsDrop(e)) return
    setDropActive(true)
  }

  function handleOsDragLeave(): void {
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) setDropActive(false)
  }

  async function importOsDrop(dt: DataTransfer): Promise<void> {
    if (!target) return
    const sources = osDropPaths(dt)
    if (sources.length === 0) {
      setError('No se pudo leer la ruta local. Arrastrá desde el Finder o el Explorador.')
      return
    }
    setImporting(true)
    setError(null)
    try {
      const result = await api.importRemote({
        baseUrl: target.baseUrl,
        sources,
        destPath: path || undefined,
        token: token.trim() || undefined
      })
      if (!result.ok) {
        setError(mapIpcError(result.error, 'No se pudo subir al peer.'))
        return
      }
      await load({ silent: true })
    } catch (err) {
      setError(
        mapIpcError(err instanceof Error ? err.message : String(err), 'No se pudo importar.')
      )
    } finally {
      setImporting(false)
    }
  }

  function handleOsDrop(e: DragEvent): void {
    if (!target || !tokenReady) return
    e.preventDefault()
    dropDepthRef.current = 0
    setDropActive(false)
    if (!isOsFileDrag(e.dataTransfer) || importing) return
    void importOsDrop(e.dataTransfer)
  }

  const showLoading = loading && !hasLoadedOnce.current

  if (!target) {
    return (
      <section className="panel" aria-labelledby="explorer-title">
        <div className="panel-head">
          <Button variant="ghost" size="md" onClick={onBack}>
            ← Volver
          </Button>
          <h1 id="explorer-title">Explorador</h1>
        </div>
        <div className="state-box empty">Elegí una máquina en la lista.</div>
      </section>
    )
  }

  return (
    <section className="panel" aria-labelledby="explorer-title">
      <div className="panel-head">
        <Button variant="ghost" size="md" onClick={onBack}>
          ← Volver
        </Button>
        <div>
          <h1 id="explorer-title">{target.label}</h1>
          <p className="panel-sub mono">{target.baseUrl}</p>
        </div>
      </div>

      {target.tokenRequired && !tokenReady && (
        <form
          className="token-prompt"
          onSubmit={(e) => {
            e.preventDefault()
            if (!token.trim()) {
              setError('Ingresá la clave para continuar.')
              return
            }
            setTokenReady(true)
            setError(null)
          }}
        >
          <label htmlFor="explorer-token">Este peer requiere clave</label>
          <div className="row">
            <Input
              id="explorer-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Clave de acceso"
            />
            <Button type="submit" variant="primary" size="md">
              Conectar
            </Button>
          </div>
        </form>
      )}

      {tokenReady && (
        <>
          <nav className="breadcrumb" aria-label="Ruta">
            {crumbs.map((crumb, i) => (
              <span key={crumb.path || 'root'}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button type="button" className="crumb" onClick={() => setPath(crumb.path)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>

          <div className="toolbar">
            <Button variant="ghost" size="sm" disabled={!path} onClick={() => setPath(parentPath(path))}>
              Subir nivel
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void load({ silent: false })} disabled={loading}>
              Actualizar
            </Button>
            {importing ? (
              <span className="finder-import-status" role="status" aria-live="polite">
                Importando…
              </span>
            ) : null}
            <Button
              variant="primary"
              size="md"
              disabled={busyAction === 'upload'}
              loading={busyAction === 'upload'}
              onClick={() => fileInputRef.current?.click()}
            >
              Subir archivos
            </Button>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              onChange={(e) => {
                void uploadFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          <div
            className={`finder-drop-target${dropActive ? ' active' : ''}`}
            onDragEnter={handleOsDragEnter}
            onDragOver={handleOsDragOver}
            onDragLeave={handleOsDragLeave}
            onDrop={handleOsDrop}
          >
          {showLoading && <div className="state-box">Cargando…</div>}

          {!showLoading && entries.length === 0 && !error && (
            <div className="state-box empty">Carpeta vacía.</div>
          )}

          {!showLoading && entries.length > 0 && (
            <div className="table-wrap">
              <table className="files">
                <thead>
                  <tr>
                    <th scope="col">Nombre</th>
                    <th scope="col">Tamaño</th>
                    <th scope="col">Modificado</th>
                    <th scope="col">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.path}>
                      <td>
                        {entry.isDir ? (
                          <button
                            type="button"
                            className="file-link dir file-drag"
                            draggable
                            onPointerDown={() => {
                              suppressClickRef.current = false
                              prepareEntryDrag(entry)
                            }}
                            onDragStart={(e) => handleEntryDragStart(entry, e)}
                            onClick={() => {
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false
                                return
                              }
                              setPath(entry.path || joinPath(path, entry.name))
                            }}
                          >
                            {entry.name}/
                            {busyAction === entry.path ? ' Preparando…' : ''}
                          </button>
                        ) : (
                          <span
                            className="file-drag"
                            draggable
                            onPointerDown={() => prepareEntryDrag(entry)}
                            onDragStart={(e) => handleEntryDragStart(entry, e)}
                          >
                            {entry.name}
                            {busyAction === entry.path ? '…' : ''}
                          </span>
                        )}
                      </td>
                      <td className="muted">{formatSize(entry.size, entry.isDir)}</td>
                      <td className="muted">{formatMtime(entry.mtime)}</td>
                      <td>
                        {!entry.isDir && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyAction === entry.path}
                            onClick={() => void downloadFile(entry)}
                          >
                            {busyAction === entry.path ? '…' : 'Descargar'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </>
      )}

      {savedDownload && (
        <div className="download-toast" role="status">
          <Alert variant="success" title="Guardado en Descargas">
            <p className="download-toast-path mono" title={savedDownload.path}>
              {savedDownload.path}
            </p>
            <div className="download-toast-actions">
              <Button variant="secondary" size="sm" onClick={() => void revealSavedDownload()}>
                Mostrar en carpeta
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSavedDownload(null)}>
                Cerrar
              </Button>
            </div>
          </Alert>
        </div>
      )}

      {error && listUnreachable && target ? (
        <PeerReachabilityAlert
          host={target.host || hostFromBaseUrl(target.baseUrl)}
          baseUrl={target.baseUrl}
          hosts={target.hosts}
          localHosts={target.localHosts}
          detail={errorRaw}
          peerName={target.label}
          onRetry={() => load({ silent: false })}
        />
      ) : error ? (
        <div className="state-box error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  )
}
