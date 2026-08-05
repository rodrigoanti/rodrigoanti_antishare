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
import { PEER_STALE_MS, type DirEntry, type Peer, type ShareStatus } from '../../../shared/types'
import { getApi, isNetworkReachabilityError, mapIpcError } from '../api'
import { isOsFileDrag, markInternalDrag, osDropPaths } from '../osDrop'
import { Button, ContextMenu, Input, LockBadge, Modal, toast } from '../ui'
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
  return Date.now() - peer.lastSeen < PEER_STALE_MS
}

function joinPath(parent: string, name: string): string {
  if (!parent || parent === '/') return name
  return `${parent.replace(/\/+$/, '')}/${name}`
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
    return new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

function uniqueNewFolderName(entries: DirEntry[]): string {
  const used = new Set(entries.map((e) => e.name.toLowerCase()))
  if (!used.has('carpeta nueva')) return 'Carpeta nueva'
  let n = 2
  while (used.has(`carpeta nueva ${n}`)) n += 1
  return `Carpeta nueva ${n}`
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
  const [listFailed, setListFailed] = useState(false)
  const [errorRaw, setErrorRaw] = useState<string | null>(null)
  const [listUnreachable, setListUnreachable] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pendingPeer, setPendingPeer] = useState<Peer | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [dragBusyPath, setDragBusyPath] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [renameMode, setRenameMode] = useState<
    { kind: 'existing'; path: string; value: string } | { kind: 'create'; value: string } | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null)
  const [opBusy, setOpBusy] = useState(false)
  const hasLoadedOnce = useRef(false)
  const silentFailStreak = useRef(0)
  /** True while listing fails — poll every 2s until a success, then back to 5s. */
  const connectionUnstable = useRef(false)
  const tokenInputRef = useRef<HTMLInputElement>(null)
  /** Remote drag: absolute path from prepareDrag, keyed by entry.path */
  const preparedDragRef = useRef<Map<string, { promise: Promise<string | null>; filePath?: string }>>(
    new Map()
  )
  const dropDepthRef = useRef(0)
  const renameCommitLock = useRef(false)

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
        setListFailed(false)
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
        setListFailed(false)
        setErrorRaw(null)
        setListUnreachable(false)
      }
      let result: { ok: boolean; entries?: DirEntry[]; error?: string }
      if (nav.kind === 'local') {
        if (!running) {
          setEntries([])
          setListFailed(true)
          setErrorRaw(null)
          setListUnreachable(false)
          setLoading(false)
          connectionUnstable.current = true
          if (!silent) toast.error('Todavía no estás compartiendo.')
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
          setListFailed(true)
          if (!unreachable) {
            toast.error(mapIpcError(result.error, 'No se pudo listar el contenido.'))
          }
        } else {
          // Transient LAN / keep-alive races: keep last listing; surface panel after streaks.
          silentFailStreak.current += 1
          if (silentFailStreak.current >= 2) {
            setErrorRaw(result.error ?? null)
            setListUnreachable(unreachable)
            setListFailed(true)
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
      setListFailed(false)
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
    setRenameMode(null)
    setMenu(null)
    setPendingDelete(null)
    setListFailed(false)
    setListUnreachable(false)
    setErrorRaw(null)
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

  useEffect(() => {
    if (nav.kind === 'root') return
    const onKey = (e: KeyboardEvent): void => {
      if (renameMode || pendingDelete || pendingPeer || opBusy) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const entry = entries.find((en) => en.path === selectedKey)
      if (!entry) return
      if (e.key === 'Enter') {
        e.preventDefault()
        void openEntry(entry)
      } else if (e.key === 'F2') {
        e.preventDefault()
        beginRename(entry)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        setPendingDelete(entry)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav.kind, renameMode, pendingDelete, pendingPeer, opBusy, entries, selectedKey])

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

  function cancelRename(): void {
    renameCommitLock.current = false
    setRenameMode(null)
  }

  function beginRename(entry: DirEntry): void {
    renameCommitLock.current = false
    setMenu(null)
    setSelectedKey(entry.path)
    setRenameMode({ kind: 'existing', path: entry.path, value: entry.name })
  }

  function startNewFolder(): void {
    if (nav.kind === 'root' || opBusy) return
    renameCommitLock.current = false
    setMenu(null)
    setPendingDelete(null)
    setRenameMode({ kind: 'create', value: uniqueNewFolderName(entries) })
  }

  async function commitRename(): Promise<void> {
    if (!renameMode || renameCommitLock.current || nav.kind === 'root') return
    const name = renameMode.value.trim()
    if (!name) {
      cancelRename()
      return
    }
    if (renameMode.kind === 'existing') {
      const entry = entries.find((e) => e.path === renameMode.path)
      if (!entry || name === entry.name) {
        cancelRename()
        return
      }
    }
    renameCommitLock.current = true
    setOpBusy(true)
    const creating = renameMode.kind === 'create'
    try {
      const result =
        nav.kind === 'local'
          ? creating
            ? await api.mkdirLocal({ path: nav.path || undefined, name })
            : await api.renameLocal({ path: renameMode.path, newName: name })
          : creating
            ? await api.remoteMkdir({
                baseUrl: nav.peer.baseUrl,
                path: nav.path || undefined,
                name,
                token: nav.token
              })
            : await api.remoteRename({
                baseUrl: nav.peer.baseUrl,
                path: renameMode.path,
                newName: name,
                token: nav.token
              })
      if (!result.ok) {
        renameCommitLock.current = false
        toast.error(
          mapIpcError(result.error, creating ? 'No se pudo crear la carpeta.' : 'No se pudo renombrar.')
        )
        return
      }
      setRenameMode(null)
      setSelectedKey(joinPath(nav.path, name))
      await loadContents({ silent: true })
      toast.success(creating ? 'Carpeta creada' : 'Renombrado')
    } catch (err) {
      renameCommitLock.current = false
      toast.error(
        mapIpcError(
          err instanceof Error ? err.message : String(err),
          creating ? 'No se pudo crear la carpeta.' : 'No se pudo renombrar.'
        )
      )
    } finally {
      setOpBusy(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || nav.kind === 'root') return
    const entry = pendingDelete
    setOpBusy(true)
    try {
      const result =
        nav.kind === 'local'
          ? await api.removeLocal({ path: entry.path })
          : await api.remoteRemove({
              baseUrl: nav.peer.baseUrl,
              path: entry.path,
              token: nav.token
            })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, `No se pudo eliminar «${entry.name}».`))
        return
      }
      setPendingDelete(null)
      if (selectedKey === entry.path) setSelectedKey(null)
      await loadContents({ silent: true })
      toast.success('Eliminado')
    } catch (err) {
      toast.error(
        mapIpcError(
          err instanceof Error ? err.message : String(err),
          `No se pudo eliminar «${entry.name}».`
        )
      )
    } finally {
      setOpBusy(false)
    }
  }

  async function revealDownload(path: string): Promise<void> {
    const result = await api.showItemInFolder(path)
    if (!result.ok) {
      toast.error(mapIpcError(result.error, 'No se pudo mostrar el archivo.'))
    }
  }

  async function openEntry(entry: DirEntry): Promise<void> {
    setSelectedKey(entry.path)
    if (entry.isDir) {
      const nextPath = entry.path || joinPath(nav.kind === 'root' ? '' : nav.path, entry.name)
      if (nav.kind === 'local') setNav({ kind: 'local', path: nextPath })
      if (nav.kind === 'peer') setNav({ kind: 'peer', peer: nav.peer, path: nextPath, token: nav.token })
      return
    }
    setBusyFile(entry.path)
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
        toast.error(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
      } else if (result.destPath) {
        const destPath = result.destPath
        toast.success('Guardado en Descargas', {
          action: {
            label: 'Mostrar',
            onClick: () => void revealDownload(destPath)
          }
        })
      }
    } else if (nav.kind === 'peer') {
      const result = await api.remoteDownload({
        baseUrl: nav.peer.baseUrl,
        path: entry.path,
        token: nav.token
      })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, `No se pudo descargar «${entry.name}».`))
      } else if (result.destPath) {
        const destPath = result.destPath
        toast.success('Guardado en Descargas', {
          action: {
            label: 'Mostrar',
            onClick: () => void revealDownload(destPath)
          }
        })
      }
    }
    setBusyFile(null)
  }

  function prepareEntryDrag(entry: DirEntry): void {
    if (nav.kind === 'root') return
    const existing = preparedDragRef.current.get(entry.path)
    if (existing?.filePath || existing?.promise) return

    setDragBusyPath(entry.path)
    const promise = (async (): Promise<string | null> => {
      try {
        const result =
          nav.kind === 'local'
            ? await api.prepareDrag({
                kind: 'local',
                path: entry.path,
                isDir: entry.isDir
              })
            : await api.prepareDrag({
                kind: 'remote',
                baseUrl: nav.peer.baseUrl,
                path: entry.path,
                token: nav.token,
                isDir: entry.isDir
              })
        if (!result.ok || !result.filePath) {
          toast.error(
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
        toast.error(
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

  function handleEntryDragStart(entry: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    if (nav.kind === 'root') {
      e.preventDefault()
      return
    }
    const filePath =
      nav.kind === 'local' ? entry.path : preparedDragRef.current.get(entry.path)?.filePath
    if (!filePath) {
      e.preventDefault()
      return
    }
    markInternalDrag(e.dataTransfer)
    const result = api.startDragLocal(filePath, { isDir: entry.isDir })
    if (!result.ok) {
      e.preventDefault()
      toast.error(
        mapIpcError(result.error, `No se pudo arrastrar «${entry.name}» al Finder o Explorador.`)
      )
    }
  }

  useEffect(() => {
    dropDepthRef.current = 0
    setDropActive(false)
  }, [nav])

  function acceptOsDrop(e: DragEvent): boolean {
    if (nav.kind === 'root') return false
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
    if (nav.kind === 'root') return
    const sources = osDropPaths(dt)
    if (sources.length === 0) {
      toast.error('No se pudo leer la ruta local.')
      return
    }
    setImporting(true)
    try {
      if (nav.kind === 'local') {
        const result = await api.importLocal({ sources, destPath: nav.path || undefined })
        if (!result.ok) {
          toast.error(mapIpcError(result.error, 'No se pudo importar.'))
          return
        }
        toast.success(sources.length === 1 ? 'Importado' : `${sources.length} importados`)
      } else {
        const result = await api.importRemote({
          baseUrl: nav.peer.baseUrl,
          sources,
          destPath: nav.path || undefined,
          token: nav.token
        })
        if (!result.ok) {
          toast.error(mapIpcError(result.error, 'No se pudo subir al peer.'))
          return
        }
        toast.success(sources.length === 1 ? 'Subido' : `${sources.length} subidos`)
      }
      await loadContents({ silent: true })
    } catch (err) {
      toast.error(
        mapIpcError(err instanceof Error ? err.message : String(err), 'No se pudo importar.')
      )
    } finally {
      setImporting(false)
    }
  }

  function handleOsDrop(e: DragEvent): void {
    if (nav.kind === 'root') return
    e.preventDefault()
    dropDepthRef.current = 0
    setDropActive(false)
    if (!isOsFileDrag(e.dataTransfer) || importing) return
    void importOsDrop(e.dataTransfer)
  }

  const showLoading = loading && !hasLoadedOnce.current && nav.kind !== 'root'
  const localOnline = running

  return (
    <section
      className={`finder${dragBusyPath || importing ? ' finder-drag-busy' : ''}`}
      aria-label="Compartidos"
      aria-busy={Boolean(dragBusyPath || importing)}
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
          <div className="finder-title-actions">
            {importing ? (
              <span className="finder-import-status" role="status" aria-live="polite">
                Importando…
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={startNewFolder}
              disabled={opBusy || Boolean(renameMode)}
            >
              Nueva carpeta
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadContents({ silent: false })}>
              Actualizar
            </Button>
          </div>
        )}
      </div>

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
                badge={status?.tokenRequired ? <LockBadge /> : undefined}
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
                    badge={peer.tokenRequired ? <LockBadge /> : undefined}
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

      {nav.kind !== 'root' && (
        <div
          className={`finder-drop-target${dropActive ? ' active' : ''}`}
          onDragEnter={handleOsDragEnter}
          onDragOver={handleOsDragOver}
          onDragLeave={handleOsDragLeave}
          onDrop={handleOsDrop}
        >
          {showLoading && <div className="state-box">Cargando…</div>}
          {!showLoading && viewMode === 'list' && (entries.length > 0 || renameMode?.kind === 'create') && (
            <div className="finder-list-head" aria-hidden="true">
              <span />
              <span>Nombre</span>
              <span>Estado</span>
              <span>Modificado / tamaño</span>
              <span />
            </div>
          )}
          {!showLoading && entries.length === 0 && !listFailed && renameMode?.kind !== 'create' && (
            <div className="state-box empty">Esta carpeta está vacía.</div>
          )}
          {!showLoading && (entries.length > 0 || renameMode?.kind === 'create') && (
            <ul
              className={viewMode === 'icons' ? 'finder-icons' : 'finder-list'}
              aria-label="Contenido"
            >
              {renameMode?.kind === 'create' ? (
                <li>
                  <FolderItem
                    viewMode={viewMode}
                    name={renameMode.value}
                    kind="folder"
                    selected
                    renaming
                    renameValue={renameMode.value}
                    onRenameChange={(value) => setRenameMode({ kind: 'create', value })}
                    onRenameCommit={() => void commitRename()}
                    onRenameCancel={cancelRename}
                  />
                </li>
              ) : null}
              {entries.map((entry) => (
                <li key={entry.path}>
                  <FolderItem
                    viewMode={viewMode}
                    name={entry.isDir ? `${entry.name}` : entry.name}
                    kind={entry.isDir ? 'folder' : 'file'}
                    selected={selectedKey === entry.path}
                    renaming={renameMode?.kind === 'existing' && renameMode.path === entry.path}
                    renameValue={
                      renameMode?.kind === 'existing' && renameMode.path === entry.path
                        ? renameMode.value
                        : undefined
                    }
                    onRenameChange={(value) =>
                      setRenameMode({ kind: 'existing', path: entry.path, value })
                    }
                    onRenameCommit={() => void commitRename()}
                    onRenameCancel={cancelRename}
                    status={
                      dragBusyPath === entry.path
                        ? 'Preparando…'
                        : entry.isDir
                          ? 'Carpeta'
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
                    dragPreparing={dragBusyPath === entry.path}
                    onClick={() => {
                      if (renameMode) return
                      setSelectedKey(entry.path)
                    }}
                    onDoubleClick={() => {
                      if (renameMode) return
                      void openEntry(entry)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelectedKey(entry.path)
                      setMenu({ x: e.clientX, y: e.clientY, entry })
                    }}
                    onPointerDown={() => {
                      if (!renameMode) prepareEntryDrag(entry)
                    }}
                    onDragStart={(e) => handleEntryDragStart(entry, e)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {listUnreachable && nav.kind === 'peer' ? (
        <PeerReachabilityAlert
          host={nav.peer.host}
          baseUrl={nav.peer.baseUrl}
          hosts={nav.peer.hosts}
          localHosts={localLanHosts}
          detail={errorRaw}
          peerName={nav.peer.name}
          onRetry={() => loadContents({ silent: false })}
        />
      ) : null}

      <ContextMenu
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={
          menu
            ? [
                {
                  id: 'open',
                  label: 'Abrir',
                  onSelect: () => void openEntry(menu.entry)
                },
                {
                  id: 'rename',
                  label: 'Renombrar',
                  onSelect: () => beginRename(menu.entry)
                },
                {
                  id: 'delete',
                  label: 'Eliminar',
                  danger: true,
                  onSelect: () => setPendingDelete(menu.entry)
                }
              ]
            : []
        }
      />

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => {
          if (!opBusy) setPendingDelete(null)
        }}
        title="Eliminar"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setPendingDelete(null)} disabled={opBusy}>
              Cancelar
            </Button>
            <Button variant="danger" size="md" onClick={() => void confirmDelete()} loading={opBusy}>
              Eliminar
            </Button>
          </>
        }
      >
        <p className="panel-sub" style={{ margin: 0 }}>
          {pendingDelete ? `¿Eliminar «${pendingDelete.name}»?` : null}
        </p>
      </Modal>

      <Modal
        open={Boolean(pendingPeer)}
        onClose={() => {
          setPendingPeer(null)
          setTokenDraft('')
          setTokenError(null)
        }}
        title={pendingPeer?.name ?? 'Clave'}
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
          <Input
            ref={tokenInputRef}
            id="peer-token"
            type="password"
            autoComplete="off"
            aria-label="Clave"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          {tokenError ? (
            <p className="muted" role="alert" style={{ margin: 0 }}>
              {tokenError}
            </p>
          ) : null}
        </form>
      </Modal>
    </section>
  )
}
