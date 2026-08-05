import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactElement
} from 'react'
import type { DirEntry, Peer, ShareStatus } from '../../../shared/types'
import { getApi, isNetworkReachabilityError, mapIpcError } from '../api'
import { Alert, Button, Input, Modal } from '../ui'
import { FolderItem, type FinderViewMode } from '../ui/FolderItem'
import { lanHostsFromShareUrls, PeerReachabilityAlert } from './PeerReachabilityAlert'

const VIEW_KEY = 'antishare.finderView'

type Nav =
  | { kind: 'root' }
  | { kind: 'local'; path: string }
  | { kind: 'peer'; peer: Peer; path: string; token?: string }

interface HomeProps {
  status: ShareStatus | null
  onOpenSettings: () => void
}

function isFresh(peer: Peer): boolean {
  if (!peer.lastSeen) return true
  return Date.now() - peer.lastSeen < 30_000
}

function joinPath(parent: string, name: string): string {
  if (!parent || parent === '/') return name
  return `${parent.replace(/\/+$/, '')}/${name}`
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatMtime(ms: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

function readViewMode(): FinderViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'list' ? 'list' : 'icons'
  } catch {
    return 'icons'
  }
}

export function Home({ status, onOpenSettings }: HomeProps): ReactElement {
  const api = getApi()
  const [nav, setNav] = useState<Nav>({ kind: 'root' })
  const [viewMode, setViewMode] = useState<FinderViewMode>(readViewMode)
  const [peers, setPeers] = useState<Peer[]>([])
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorRaw, setErrorRaw] = useState<string | null>(null)
  const [listUnreachable, setListUnreachable] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pendingPeer, setPendingPeer] = useState<Peer | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [dragBusyPath, setDragBusyPath] = useState<string | null>(null)
  const [savedDownload, setSavedDownload] = useState<{ path: string; name: string } | null>(null)
  const hasLoadedOnce = useRef(false)
  const silentFailStreak = useRef(0)
  /** True while listing fails — poll every 2s until a success, then back to 5s. */
  const connectionUnstable = useRef(false)
  const tokenInputRef = useRef<HTMLInputElement>(null)
  /** Remote drag: absolute path from prepareDrag, keyed by entry.path */
  const preparedDragRef = useRef<Map<string, { promise: Promise<string | null>; filePath?: string }>>(
    new Map()
  )

  const running = status?.running ?? false
  const localLanHosts = useMemo(() => lanHostsFromShareUrls(status?.urls), [status?.urls])

  useEffect(() => {
    if (!pendingPeer) return
    const id = window.setTimeout(() => {
      requestAnimationFrame(() => {
        const el = tokenInputRef.current
        if (!el) return
        el.focus()
        el.select()
      })
    }, 0)
    return () => window.clearTimeout(id)
  }, [pendingPeer])

  useEffect(() => {
    try {
      if (sessionStorage.getItem('antishare.openLocal') !== '1') return
      if (!status?.running) return
      sessionStorage.removeItem('antishare.openLocal')
      setNav({ kind: 'local', path: '' })
    } catch {
      /* ignore */
    }
  }, [status?.running])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, viewMode)
    } catch {
      /* ignore */
    }
  }, [viewMode])

  useEffect(() => {
    let alive = true
    async function loadPeers(): Promise<void> {
      try {
        const list = await api.listPeers()
        if (alive) setPeers(list)
      } catch {
        /* ignore root peer errors; onUpdate will fill */
      }
    }
    void loadPeers()
    const unsub = api.onPeersUpdate((next) => {
      if (!alive) return
      setPeers(next)
      // Keep open explorer pointed at the live announce (IP can change on Wi‑Fi renew).
      setNav((prev) => {
        if (prev.kind !== 'peer') return prev
        const match = next.find(
          (p) =>
            p.baseUrl === prev.peer.baseUrl ||
            (p.port === prev.peer.port &&
              (p.name === prev.peer.name || p.host === prev.peer.host))
        )
        if (!match) return prev
        if (
          match.baseUrl === prev.peer.baseUrl &&
          match.host === prev.peer.host &&
          match.name === prev.peer.name &&
          match.tokenRequired === prev.peer.tokenRequired
        ) {
          return prev
        }
        return { ...prev, peer: match }
      })
    })
    return () => {
      alive = false
      unsub()
    }
  }, [api])

  const loadContents = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (nav.kind === 'root') {
        setEntries([])
        setLoading(false)
        setError(null)
        setErrorRaw(null)
        setListUnreachable(false)
        hasLoadedOnce.current = true
        silentFailStreak.current = 0
        connectionUnstable.current = false
        return true
      }
      const silent = opts?.silent === true
      if (!silent) {
        setLoading(true)
        setError(null)
        setErrorRaw(null)
        setListUnreachable(false)
      }
      let result: { ok: boolean; entries?: DirEntry[]; error?: string }
      if (nav.kind === 'local') {
        if (!running) {
          setEntries([])
          setError('Todavía no estás compartiendo.')
          setErrorRaw(null)
          setListUnreachable(false)
          setLoading(false)
          connectionUnstable.current = true
          return false
        }
        result = await api.listLocal({ path: nav.path || undefined })
      } else {
        result = await api.remoteList({
          baseUrl: nav.peer.baseUrl,
          path: nav.path || undefined,
          token: nav.token
        })
      }
      if (!result.ok) {
        connectionUnstable.current = true
        const unreachable = nav.kind === 'peer' && isNetworkReachabilityError(result.error)
        if (!silent) {
          silentFailStreak.current = 0
          setEntries([])
          setErrorRaw(result.error ?? null)
          setListUnreachable(unreachable)
          setError(mapIpcError(result.error, 'No se pudo listar el contenido.'))
        } else {
          // Transient LAN / keep-alive races: keep last listing; only surface after streaks.
          silentFailStreak.current += 1
          if (silentFailStreak.current >= 2) {
            setErrorRaw(result.error ?? null)
            setListUnreachable(unreachable)
            setError(mapIpcError(result.error, 'No se pudo actualizar.'))
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
    [api, nav, running]
  )

  useEffect(() => {
    hasLoadedOnce.current = false
    silentFailStreak.current = 0
    connectionUnstable.current = false
    setSelectedKey(null)
    preparedDragRef.current.clear()

    if (nav.kind === 'root') {
      void loadContents({ silent: false })
      return
    }

    let cancelled = false
    let timer: number | undefined

    const run = async (silent: boolean): Promise<void> => {
      if (cancelled) return
      await loadContents({ silent })
      if (cancelled) return
      const delay = connectionUnstable.current ? 2_000 : 5_000
      timer = window.setTimeout(() => void run(true), delay)
    }

    void run(false)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [loadContents, nav.kind])

  const crumbs = useMemo(() => {
    const items: { label: string; go: () => void }[] = [
      {
        label: 'Compartidos',
        go: () => setNav({ kind: 'root' })
      }
    ]
    if (nav.kind === 'local') {
      items.push({
        label: 'Mi carpeta',
        go: () => setNav({ kind: 'local', path: '' })
      })
      const parts = nav.path.split('/').filter(Boolean)
      let acc = ''
      for (const part of parts) {
        acc = joinPath(acc, part)
        const path = acc
        items.push({
          label: part,
          go: () => setNav({ kind: 'local', path })
        })
      }
    }
    if (nav.kind === 'peer') {
      const peer = nav.peer
      const token = nav.token
      items.push({
        label: peer.name,
        go: () => setNav({ kind: 'peer', peer, path: '', token })
      })
      const parts = nav.path.split('/').filter(Boolean)
      let acc = ''
      for (const part of parts) {
        acc = joinPath(acc, part)
        const path = acc
        items.push({
          label: part,
          go: () => setNav({ kind: 'peer', peer, path, token })
        })
      }
    }
    return items
  }, [nav])

  function openLocalRoot(): void {
    if (!running) {
      onOpenSettings()
      return
    }
    setNav({ kind: 'local', path: '' })
  }

  function openPeer(peer: Peer, token?: string): void {
    setNav({ kind: 'peer', peer, path: '', token })
  }

  function handlePeerClick(peer: Peer): void {
    setSelectedKey(`peer:${peer.baseUrl}`)
    if (peer.tokenRequired) {
      setPendingPeer(peer)
      setTokenDraft('')
      setTokenError(null)
      return
    }
    openPeer(peer)
  }

  function confirmToken(e: FormEvent): void {
    e.preventDefault()
    if (!pendingPeer) return
    const value = tokenDraft.trim()
    if (!value) {
      setTokenError('Ingresá la clave para continuar.')
      return
    }
    const peer = pendingPeer
    setPendingPeer(null)
    setTokenDraft('')
    setTokenError(null)
    openPeer(peer, value)
  }

  async function openEntry(entry: DirEntry): Promise<void> {
    setSelectedKey(entry.path)
    if (entry.isDir) {
      const nextPath = entry.path || joinPath(nav.kind === 'root' ? '' : nav.path, entry.name)
      if (nav.kind === 'local') setNav({ kind: 'local', path: nextPath })
      if (nav.kind === 'peer') setNav({ kind: 'peer', peer: nav.peer, path: nextPath, token: nav.token })
      return
    }
    // file download
    setBusyFile(entry.path)
    setError(null)
    setSavedDownload(null)
    if (nav.kind === 'local') {
      const baseUrl = status?.urls?.[0]?.replace(/\/+$/, '')
      if (!baseUrl) {
        setBusyFile(null)
        return
      }
      const settings = await api.getSettings()
      const result = await api.remoteDownload({
        baseUrl,
        path: entry.path,
        token: settings.token
      })
      if (!result.ok) {
        setError(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
      } else if (result.destPath) {
        setSavedDownload({ path: result.destPath, name: entry.name })
      }
    } else if (nav.kind === 'peer') {
      const result = await api.remoteDownload({
        baseUrl: nav.peer.baseUrl,
        path: entry.path,
        token: nav.token
      })
      if (!result.ok) {
        setError(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
      } else if (result.destPath) {
        setSavedDownload({ path: result.destPath, name: entry.name })
      }
    }
    setBusyFile(null)
  }

  async function revealSavedDownload(): Promise<void> {
    if (!savedDownload) return
    const result = await api.showItemInFolder(savedDownload.path)
    if (!result.ok) {
      setError(mapIpcError(result.error, 'No se pudo mostrar el archivo en la carpeta.'))
    }
  }

  function prepareRemoteDrag(entry: DirEntry): void {
    if (entry.isDir || nav.kind !== 'peer') return
    const existing = preparedDragRef.current.get(entry.path)
    if (existing?.filePath || existing?.promise) return

    setDragBusyPath(entry.path)
    setError(null)
    const promise = (async (): Promise<string | null> => {
      try {
        const result = await api.prepareDrag({
          kind: 'remote',
          baseUrl: nav.peer.baseUrl,
          path: entry.path,
          token: nav.token,
          isDir: false
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
        setDragBusyPath((cur) => (cur === entry.path ? null : cur))
      }
    })()
    preparedDragRef.current.set(entry.path, { promise })
  }

  function handleFileDragStart(entry: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    if (entry.isDir || nav.kind === 'root') {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', entry.name)
    setError(null)
    void (async () => {
      try {
        if (nav.kind === 'local') {
          const result = await api.startDrag({ kind: 'local', path: entry.path, isDir: false })
          if (!result.ok) {
            setError(
              mapIpcError(
                result.error,
                `No se pudo arrastrar «${entry.name}» al Finder o Explorador.`
              )
            )
          }
          return
        }

        // Remote: use prepared temp path (Windows-safe), prepare on the fly if needed
        let filePath = preparedDragRef.current.get(entry.path)?.filePath
        if (!filePath) {
          setDragBusyPath(entry.path)
          const pending = preparedDragRef.current.get(entry.path)?.promise
          if (pending) {
            filePath = (await pending) ?? undefined
          } else {
            const prepared = await api.prepareDrag({
              kind: 'remote',
              baseUrl: nav.peer.baseUrl,
              path: entry.path,
              token: nav.token,
              isDir: false
            })
            if (prepared.ok && prepared.filePath) {
              filePath = prepared.filePath
              preparedDragRef.current.set(entry.path, {
                promise: Promise.resolve(prepared.filePath),
                filePath: prepared.filePath
              })
            } else {
              setError(
                mapIpcError(
                  prepared.error,
                  `No se pudo preparar «${entry.name}» para arrastrar.`
                )
              )
              return
            }
          }
          setDragBusyPath(null)
        }

        if (!filePath) {
          setError(`No se pudo arrastrar «${entry.name}» al Finder o Explorador.`)
          return
        }

        const result = await api.startDragLocal(filePath)
        if (!result.ok) {
          setError(
            mapIpcError(
              result.error,
              `No se pudo arrastrar «${entry.name}» al Finder o Explorador.`
            )
          )
        }
      } catch (err) {
        setError(
          mapIpcError(
            err instanceof Error ? err.message : String(err),
            `No se pudo arrastrar «${entry.name}» al Finder o Explorador.`
          )
        )
      } finally {
        setDragBusyPath(null)
      }
    })()
  }

  const showLoading = loading && !hasLoadedOnce.current && nav.kind !== 'root'
  const localOnline = running

  return (
    <section
      className={`finder${dragBusyPath ? ' finder-drag-busy' : ''}`}
      aria-label="Compartidos"
      aria-busy={Boolean(dragBusyPath)}
    >
      <header className="finder-toolbar">
        <div className="finder-toolbar-left">
          <nav className="finder-crumbs" aria-label="Ruta">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="finder-crumb-wrap">
                {i > 0 && <span className="crumb-sep">›</span>}
                <button type="button" className="finder-crumb" onClick={c.go}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="finder-view-toggle" role="group" aria-label="Vista">
          <button
            type="button"
            className={viewMode === 'icons' ? 'finder-toggle on' : 'finder-toggle'}
            aria-pressed={viewMode === 'icons'}
            onClick={() => setViewMode('icons')}
          >
            Iconos
          </button>
          <button
            type="button"
            className={viewMode === 'list' ? 'finder-toggle on' : 'finder-toggle'}
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            Lista
          </button>
        </div>
      </header>

      <div className="finder-title-row">
        <h1 className="finder-title">
          {nav.kind === 'root'
            ? 'Compartidos'
            : nav.kind === 'local'
              ? 'Mi carpeta'
              : nav.peer.name}
        </h1>
        {nav.kind !== 'root' && (
          <Button variant="ghost" size="sm" onClick={() => void loadContents({ silent: false })}>
            Actualizar
          </Button>
        )}
      </div>

      {showLoading && <div className="state-box">Cargando…</div>}

      {nav.kind === 'root' && (
        <>
          {viewMode === 'list' && (
            <div className="finder-list-head" aria-hidden="true">
              <span />
              <span>Nombre</span>
              <span>Estado</span>
              <span>Detalle</span>
              <span />
            </div>
          )}
          <ul
            className={viewMode === 'icons' ? 'finder-icons' : 'finder-list'}
            aria-label="Carpetas compartidas"
          >
            <li>
              <FolderItem
                viewMode={viewMode}
                name="Mi carpeta"
                kind="folder"
                selected={selectedKey === 'local'}
                status={localOnline ? 'En línea' : 'Sin compartir'}
                badge={status?.tokenRequired ? 'Token' : undefined}
                meta={localOnline ? 'Esta máquina' : 'Configurá para compartir'}
                title={localOnline ? 'Abrir Mi carpeta' : 'Configurar carpeta'}
                onClick={() => {
                  setSelectedKey('local')
                  openLocalRoot()
                }}
              />
            </li>
            {peers.map((peer) => {
              const online = isFresh(peer)
              return (
                <li key={peer.baseUrl}>
                  <FolderItem
                    viewMode={viewMode}
                    name={peer.name}
                    kind="folder"
                    selected={selectedKey === `peer:${peer.baseUrl}`}
                    status={online ? 'En línea' : 'Inactivo'}
                    badge={peer.tokenRequired ? 'Token' : undefined}
                    meta={`${peer.host}:${peer.port}`}
                    onClick={() => handlePeerClick(peer)}
                  />
                </li>
              )
            })}
          </ul>
          {peers.length === 0 && (
            <p className="finder-empty-hint muted">
              Las demás máquinas aparecen acá cuando compartan en la misma red.
            </p>
          )}
        </>
      )}

      {nav.kind !== 'root' && !showLoading && (
        <>
          {viewMode === 'list' && entries.length > 0 && (
            <div className="finder-list-head" aria-hidden="true">
              <span />
              <span>Nombre</span>
              <span>Estado</span>
              <span>Modificado / tamaño</span>
              <span />
            </div>
          )}
          {entries.length === 0 && !error && (
            <div className="state-box empty">Esta carpeta está vacía.</div>
          )}
          {entries.length > 0 && (
            <ul
              className={viewMode === 'icons' ? 'finder-icons' : 'finder-list'}
              aria-label="Contenido"
            >
              {entries.map((entry) => (
                <li key={entry.path}>
                  <FolderItem
                    viewMode={viewMode}
                    name={entry.isDir ? `${entry.name}` : entry.name}
                    kind={entry.isDir ? 'folder' : 'file'}
                    selected={selectedKey === entry.path}
                    status={
                      entry.isDir
                        ? 'Carpeta'
                        : dragBusyPath === entry.path
                          ? 'Preparando…'
                          : busyFile === entry.path
                            ? '…'
                            : 'Archivo'
                    }
                    meta={
                      entry.isDir
                        ? formatMtime(entry.mtime)
                        : `${formatSize(entry.size, false)} · ${formatMtime(entry.mtime)}`
                    }
                    sizeLabel={formatSize(entry.size, entry.isDir)}
                    dragPreparing={!entry.isDir && dragBusyPath === entry.path}
                    onClick={() => void openEntry(entry)}
                    onPointerDown={
                      !entry.isDir && nav.kind === 'peer'
                        ? () => prepareRemoteDrag(entry)
                        : undefined
                    }
                    onDragStart={
                      entry.isDir ? undefined : (e) => handleFileDragStart(entry, e)
                    }
                  />
                </li>
              ))}
            </ul>
          )}
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

      {error && listUnreachable && nav.kind === 'peer' ? (
        <PeerReachabilityAlert
          host={nav.peer.host}
          baseUrl={nav.peer.baseUrl}
          hosts={nav.peer.hosts}
          localHosts={localLanHosts}
          detail={errorRaw}
        />
      ) : error ? (
        <div className="state-box error" role="alert">
          {error}
        </div>
      ) : null}

      <Modal
        open={Boolean(pendingPeer)}
        onClose={() => {
          setPendingPeer(null)
          setTokenDraft('')
          setTokenError(null)
        }}
        title="Clave requerida"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setPendingPeer(null)
                setTokenDraft('')
                setTokenError(null)
              }}
            >
              Cancelar
            </Button>
            <Button variant="primary" size="md" type="submit" form="peer-token-form">
              Abrir
            </Button>
          </>
        }
      >
        <form id="peer-token-form" className="form-grid" onSubmit={confirmToken}>
          <p className="panel-sub" style={{ margin: 0 }}>
            {pendingPeer ? `«${pendingPeer.name}» pide una clave para ver su carpeta.` : null}
          </p>
          <div className="field">
            <label htmlFor="peer-token">Clave / token</label>
            <Input
              ref={tokenInputRef}
              id="peer-token"
              type="password"
              autoComplete="off"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Ingresá la clave"
            />
          </div>
          {tokenError && (
            <div className="state-box error" role="alert">
              {tokenError}
            </div>
          )}
        </form>
      </Modal>
    </section>
  )
}
