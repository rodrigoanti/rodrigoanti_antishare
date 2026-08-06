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
import {
  ArrowDown,
  ArrowUp,
  Folder,
  FolderPlus,
  LayoutGrid,
  List,
  Monitor,
  Moon,
  Radio,
  RefreshCw,
  Settings,
  Sun
} from 'lucide-react'
import { PEER_STALE_MS, type DirEntry, type Peer, type ShareStatus } from '../../../shared/types'
import { getApi, isNetworkReachabilityError, mapIpcError } from '../api'
import {
  beginInternalFileDrag,
  endInternalFileDrag,
  getInternalDragSourceParent,
  getInternalDragSourcePath,
  isInternalFileDragActive,
  isOsDropAlreadyInFolder,
  isOsFileDrag,
  isSharePathInsideOrEqual,
  markInternalDrag,
  osDropPaths,
  osDropSingleDirectoryPath
} from '../osDrop'
import { useShareStatus } from '../shareStatus'
import { applyTheme, type Theme } from '../theme'
import { Button, ContextMenu, Input, LockBadge, Modal, toast } from '../ui'
import { FolderItem, type FinderViewMode } from '../ui/FolderItem'
import { fileGlyphKind, FolderIcon } from '../ui/FolderIcon'
import { lanHostsFromShareUrls, PeerReachabilityAlert } from './PeerReachabilityAlert'

const ICON_STROKE = 1.75
const ICON_TOOL = 15
const ICON_SIDE = 16

const VIEW_KEY = 'antishare.finderView'

type SortKey = 'name' | 'date' | 'size' | 'type'
type SortDir = 'asc' | 'desc'
type SortPref = { key: SortKey; dir: SortDir }

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Nombre',
  date: 'Fecha',
  size: 'Tamaño',
  type: 'Tipo'
}

type Nav =
  | { kind: 'root' }
  | { kind: 'local'; path: string }
  | { kind: 'peer'; peer: Peer; path: string; token?: string }

function navId(n: Nav): string {
  if (n.kind === 'peer') return `peer:${n.peer.baseUrl}:${n.path}`
  if (n.kind === 'local') return `local:${n.path}`
  return 'root'
}

function sortStorageKey(nav: Nav): string {
  if (nav.kind === 'root') return 'antishare.sort:root:.'
  if (nav.kind === 'local') return `antishare.sort:local:${nav.path || '.'}`
  return `antishare.sort:${nav.peer.baseUrl}:${nav.path || '.'}`
}

function isSortKey(v: unknown): v is SortKey {
  return v === 'name' || v === 'date' || v === 'size' || v === 'type'
}

function isSortDir(v: unknown): v is SortDir {
  return v === 'asc' || v === 'desc'
}

function normalizeSortPref(raw: unknown): SortPref | null {
  if (!raw || typeof raw !== 'object') return null
  const pref = raw as { key?: unknown; dir?: unknown }
  const keyRaw = pref.key === 'mtime' ? 'date' : pref.key
  if (!isSortKey(keyRaw) || !isSortDir(pref.dir)) return null
  return { key: keyRaw, dir: pref.dir }
}

function readSortPref(nav: Nav): SortPref {
  try {
    const raw = localStorage.getItem(sortStorageKey(nav))
    if (raw) {
      const pref = normalizeSortPref(JSON.parse(raw) as unknown)
      if (pref) return pref
    }
  } catch {
    /* ignore */
  }
  return { key: 'name', dir: 'asc' }
}

function writeSortPref(nav: Nav, pref: SortPref): void {
  try {
    localStorage.setItem(sortStorageKey(nav), JSON.stringify(pref))
  } catch {
    /* ignore quota / private mode */
  }
}

function compareEntries(a: DirEntry, b: DirEntry, key: SortKey, dir: SortDir): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  let cmp = 0
  switch (key) {
    case 'name':
      cmp = a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
      break
    case 'date':
      cmp = a.mtime - b.mtime
      break
    case 'size':
      cmp = a.size - b.size
      break
    case 'type': {
      cmp = fileGlyphKind(a.name, a.isDir).localeCompare(fileGlyphKind(b.name, b.isDir), 'es')
      if (cmp === 0) cmp = a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
      break
    }
  }
  return dir === 'asc' ? cmp : -cmp
}

interface HomeProps {
  status: ShareStatus | null
  settingsOpen?: boolean
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

export function Home({ status, settingsOpen = false, onOpenSettings }: HomeProps): ReactElement {
  const api = getApi()
  const { refreshStatus } = useShareStatus()
  const [nav, setNav] = useState<Nav>({ kind: 'root' })
  const [contentScrolled, setContentScrolled] = useState(false)
  const [shareStarting, setShareStarting] = useState(false)
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const [viewMode, setViewMode] = useState<FinderViewMode>(readViewMode)
  const [sort, setSort] = useState<SortPref>(() => readSortPref({ kind: 'root' }))
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
  const [importing, setImporting] = useState(false)
  const [importXfer, setImportXfer] = useState<{ copied: number; total: number } | null>(null)
  const [exportXfer, setExportXfer] = useState<{ copied: number; total: number } | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [folderDropPath, setFolderDropPath] = useState<string | null>(null)
  const [renameMode, setRenameMode] = useState<
    { kind: 'existing'; path: string; value: string } | { kind: 'create'; value: string } | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null)
  const [opBusy, setOpBusy] = useState(false)
  const hasLoadedOnce = useRef(false)
  const silentFailStreak = useRef(0)
  /** True while listing fails — used for unstable-connection UX; poll stays at 2s. */
  const connectionUnstable = useRef(false)
  const tokenInputRef = useRef<HTMLInputElement>(null)
  const dropDepthRef = useRef(0)
  const renameCommitLock = useRef(false)
  const activeNavIdRef = useRef('')
  /** Session-only peer tokens keyed by baseUrl — never persist to disk. */
  const peerTokenCache = useRef<Map<string, string>>(new Map())
  /** baseUrl already prompted for invalid token this episode — avoid poll wiping draft. */
  const tokenPromptedForRef = useRef<string | null>(null)

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
    let importClearTimer: number | undefined
    let exportClearTimer: number | undefined

    const unsubImport = api.onImportProgress((p) => {
      if (importClearTimer !== undefined) {
        window.clearTimeout(importClearTimer)
        importClearTimer = undefined
      }
      setImportXfer({ copied: p.copiedBytes, total: p.totalBytes })
      if (p.done || (p.totalBytes > 0 && p.copiedBytes >= p.totalBytes)) {
        importClearTimer = window.setTimeout(() => {
          setImportXfer(null)
          importClearTimer = undefined
        }, 600)
      }
    })

    const unsubExport = api.onExportProgress((p) => {
      if (exportClearTimer !== undefined) {
        window.clearTimeout(exportClearTimer)
        exportClearTimer = undefined
      }
      setExportXfer({ copied: p.copiedBytes, total: p.totalBytes })
      if (p.done || (p.totalBytes > 0 && p.copiedBytes >= p.totalBytes)) {
        exportClearTimer = window.setTimeout(() => {
          setExportXfer(null)
          exportClearTimer = undefined
        }, 600)
      }
    })

    return () => {
      unsubImport()
      unsubExport()
      if (importClearTimer !== undefined) window.clearTimeout(importClearTimer)
      if (exportClearTimer !== undefined) window.clearTimeout(exportClearTimer)
    }
  }, [api])

  const transfer = useMemo(() => {
    const parts = [importXfer, exportXfer].filter(
      (t): t is { copied: number; total: number } => t != null
    )
    if (parts.length === 0) return null
    return {
      copied: parts.reduce((s, t) => s + t.copied, 0),
      total: parts.reduce((s, t) => s + t.total, 0)
    }
  }, [importXfer, exportXfer])

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, viewMode)
    } catch {
      /* ignore */
    }
  }, [viewMode])

  useEffect(() => {
    setSort(readSortPref(nav))
  }, [nav])

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => compareEntries(a, b, sort.key, sort.dir)),
    [entries, sort.key, sort.dir]
  )

  function setSortKey(key: SortKey): void {
    setSort((prev) => {
      if (prev.key === key) return prev
      const next: SortPref = {
        key,
        dir: key === 'date' || key === 'size' ? 'desc' : 'asc'
      }
      writeSortPref(nav, next)
      return next
    })
  }

  function toggleSortDir(): void {
    setSort((prev) => {
      const next: SortPref = { ...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      writeSortPref(nav, next)
      return next
    })
  }

  function cycleSortColumn(key: SortKey): void {
    setSort((prev) => {
      const next: SortPref =
        prev.key === key
          ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'date' || key === 'size' ? 'desc' : 'asc' }
      writeSortPref(nav, next)
      return next
    })
  }

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
      const myNavId = navId(nav)
      if (nav.kind === 'root') {
        if (activeNavIdRef.current !== myNavId) return false
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
        if (activeNavIdRef.current !== myNavId) return false
        setLoading(true)
        setListFailed(false)
        setErrorRaw(null)
        setListUnreachable(false)
      }
      let result: { ok: boolean; entries?: DirEntry[]; error?: string }
      if (nav.kind === 'local') {
        if (!running) {
          if (activeNavIdRef.current !== myNavId) return false
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
        if (activeNavIdRef.current !== myNavId) return false
        connectionUnstable.current = true
        const unreachable = nav.kind === 'peer' && isNetworkReachabilityError(result.error)
        if (
          nav.kind === 'peer' &&
          /401|unauthorized/i.test(result.error ?? '') &&
          tokenPromptedForRef.current !== nav.peer.baseUrl
        ) {
          tokenPromptedForRef.current = nav.peer.baseUrl
          peerTokenCache.current.delete(nav.peer.baseUrl)
          setPendingPeer(nav.peer)
          setTokenDraft('')
          setTokenError('La clave guardada ya no es válida. Ingrésala de nuevo.')
        }
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
      if (activeNavIdRef.current !== myNavId) return false
      setEntries(result.entries ?? [])
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
    activeNavIdRef.current = navId(nav)
    tokenPromptedForRef.current = null

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
      const delay = 2_000
      timer = window.setTimeout(() => void run(true), delay)
    }

    void run(false)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [loadContents, nav.kind])

  const crumbs = useMemo(() => {
    const items: { label: string; go: () => void }[] = []
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

  function selectLocalShare(): void {
    setSelectedKey('local')
    openLocalRoot()
  }

  function selectPeerShare(peer: Peer): void {
    handlePeerClick(peer)
  }

  function openPeer(peer: Peer, token?: string): void {
    setNav({ kind: 'peer', peer, path: '', token })
  }

  function handlePeerClick(peer: Peer): void {
    setSelectedKey(`peer:${peer.baseUrl}`)
    if (peer.tokenRequired) {
      const cached = peerTokenCache.current.get(peer.baseUrl)
      if (cached) {
        openPeer(peer, cached)
        return
      }
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
      setTokenError('Ingresa la clave para continuar.')
      return
    }
    const peer = pendingPeer
    setPendingPeer(null)
    setTokenDraft('')
    setTokenError(null)
    peerTokenCache.current.set(peer.baseUrl, value)
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
      toast.success(creating ? 'Carpeta creada' : 'Renombrado')
      const refreshed = await loadContents({ silent: true })
      if (!refreshed) toast.error('No se pudo actualizar el listado.')
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
      toast.success('Eliminado')
      const refreshed = await loadContents({ silent: true })
      if (!refreshed) toast.error('No se pudo actualizar el listado.')
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

  /** HTML5 internal drag only — never starts native OS startDrag (no Finder/Explorer drag-out). */
  function handleEntryDragStart(entry: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    if (nav.kind === 'root') {
      e.preventDefault()
      return
    }
    markInternalDrag(e.dataTransfer)
    beginInternalFileDrag(nav.path || '', entry.path)
  }

  async function saveEntryAs(entry: DirEntry): Promise<void> {
    if (nav.kind === 'root' || opBusy) return
    const destDir = await api.selectFolder()
    if (!destDir) return
    setOpBusy(true)
    try {
      const result = await api.exportItems({
        destDir,
        items:
          nav.kind === 'local'
            ? [{ kind: 'local', path: entry.path, isDir: entry.isDir }]
            : [
                {
                  kind: 'remote',
                  path: entry.path,
                  isDir: entry.isDir,
                  baseUrl: nav.peer.baseUrl,
                  token: nav.token
                }
              ]
      })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, `No se pudo guardar «${entry.name}».`))
        return
      }
      const first = result.destPaths?.[0]
      toast.success(
        result.exported === 1 ? `«${entry.name}» guardado.` : `${result.exported} ítems guardados.`,
        first
          ? {
              action: {
                label: 'Mostrar',
                onClick: () => void revealDownload(first)
              }
            }
          : undefined
      )
    } catch (err) {
      toast.error(
        mapIpcError(
          err instanceof Error ? err.message : String(err),
          `No se pudo guardar «${entry.name}».`
        )
      )
    } finally {
      setOpBusy(false)
    }
  }

  useEffect(() => {
    const restoreRendererFocus = (): void => {
      try {
        window.focus()
        const active = document.activeElement
        if (
          active instanceof HTMLElement &&
          (active === document.body || active === document.documentElement)
        ) {
          const finder = document.querySelector('.finder') as HTMLElement | null
          finder?.focus({ preventScroll: true })
        }
      } catch {
        /* ignore */
      }
    }
    const end = (): void => {
      endInternalFileDrag()
      setFolderDropPath(null)
      restoreRendererFocus()
    }
    // dragend: capture. drop: bubble so pane handlers see the flag first.
    window.addEventListener('dragend', end, true)
    window.addEventListener('drop', end, false)
    return () => {
      window.removeEventListener('dragend', end, true)
      window.removeEventListener('drop', end, false)
    }
  }, [])

  useEffect(() => {
    dropDepthRef.current = 0
    setDropActive(false)
    setFolderDropPath(null)
  }, [nav])

  /** Internal drag whose source parent is the folder currently open. */
  function isInternalSameFolderDrag(): boolean {
    if (!isInternalFileDragActive()) return false
    if (nav.kind === 'root') return false
    const sourceParent = getInternalDragSourceParent()
    if (sourceParent === null) return true
    return sourceParent === (nav.path || '')
  }

  function isOsSameFolderDrop(dt: DataTransfer): boolean {
    return nav.kind === 'local' && isOsDropAlreadyInFolder(dt, status?.folder, nav.path || '')
  }

  /** Whether dest folder can accept the current drag (internal move or OS import). */
  function folderDropEffect(dest: DirEntry, e: DragEvent): 'move' | 'copy' | null {
    if (!dest.isDir || nav.kind === 'root' || importing || opBusy) return null

    if (isInternalFileDragActive()) {
      const srcPath = getInternalDragSourcePath()
      if (!srcPath) return null
      if (srcPath === dest.path) return null
      if (isSharePathInsideOrEqual(srcPath, dest.path)) return null
      const srcParent = getInternalDragSourceParent()
      if (srcParent !== null && srcParent === dest.path) return null
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      return 'move'
    }

    if (!isOsFileDrag(e.dataTransfer)) return null
    if (nav.kind === 'local' && isOsDropAlreadyInFolder(e.dataTransfer, status?.folder, dest.path)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
      return null
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    return 'copy'
  }

  function handleFolderDragOver(dest: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    e.stopPropagation()
    const effect = folderDropEffect(dest, e)
    if (!effect) {
      setFolderDropPath(null)
      e.dataTransfer.dropEffect = 'none'
      return
    }
    setFolderDropPath(dest.path)
    setDropActive(false)
  }

  function handleFolderDragLeave(dest: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    e.stopPropagation()
    const related = e.relatedTarget
    if (related instanceof Node && e.currentTarget.contains(related)) return
    setFolderDropPath((cur) => (cur === dest.path ? null : cur))
  }

  async function importOsDropTo(dt: DataTransfer, destPath: string, destName: string): Promise<void> {
    if (nav.kind === 'root') return
    const sources = osDropPaths(dt)
    if (sources.length === 0) {
      toast.error('No se pudo leer la ruta local.')
      return
    }
    setImporting(true)
    try {
      if (nav.kind === 'local') {
        const result = await api.importLocal({ sources, destPath: destPath || undefined })
        if (!result.ok) {
          toast.error(mapIpcError(result.error, 'No se pudo importar.'))
          return
        }
        toast.success(
          sources.length === 1
            ? `Importado en «${destName}»`
            : `${sources.length} importados en «${destName}»`
        )
      } else {
        const result = await api.importRemote({
          baseUrl: nav.peer.baseUrl,
          sources,
          destPath: destPath || undefined,
          token: nav.token
        })
        if (!result.ok) {
          toast.error(mapIpcError(result.error, 'No se pudo subir al peer.'))
          return
        }
        toast.success(
          sources.length === 1
            ? `Subido a «${destName}»`
            : `${sources.length} subidos a «${destName}»`
        )
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

  async function moveInternalToFolder(dest: DirEntry): Promise<void> {
    if (nav.kind === 'root') return
    const srcPath = getInternalDragSourcePath()
    if (!srcPath) return
    const srcName = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath
    setOpBusy(true)
    try {
      const result =
        nav.kind === 'local'
          ? await api.moveLocal({ path: srcPath, destPath: dest.path })
          : await api.remoteMove({
              baseUrl: nav.peer.baseUrl,
              path: srcPath,
              destPath: dest.path,
              token: nav.token
            })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, `No se pudo mover «${srcName}».`))
        return
      }
      if (selectedKey === srcPath) setSelectedKey(null)
      toast.success(`Movido a «${dest.name}»`)
      await loadContents({ silent: true })
    } catch (err) {
      toast.error(
        mapIpcError(err instanceof Error ? err.message : String(err), `No se pudo mover «${srcName}».`)
      )
    } finally {
      setOpBusy(false)
    }
  }

  function handleFolderDrop(dest: DirEntry, e: DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const effect = folderDropEffect(dest, e)
    const dt = e.dataTransfer
    dropDepthRef.current = 0
    setDropActive(false)
    setFolderDropPath(null)

    if (!effect) return

    if (effect === 'move') {
      void moveInternalToFolder(dest)
      return
    }
    if (importing || !dt) return
    void importOsDropTo(dt, dest.path, dest.name)
  }

  function rejectDropVisual(e: DragEvent): void {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
    setDropActive(false)
  }

  function acceptOsDrop(e: DragEvent): boolean {
    if (nav.kind === 'root') return false
    // AntiShare→AntiShare: never allow import; same-folder shows not-allowed cursor.
    if (isInternalFileDragActive()) {
      rejectDropVisual(e)
      return false
    }
    if (!isOsFileDrag(e.dataTransfer)) return false
    if (isOsSameFolderDrop(e.dataTransfer)) {
      rejectDropVisual(e)
      return false
    }
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
    setFolderDropPath(null)
    if (isInternalFileDragActive()) {
      if (isInternalSameFolderDrag()) {
        // Same folder: no import, no toast spam — drop is a no-op.
        try {
          window.focus()
        } catch {
          /* ignore */
        }
        return
      }
      toast.error('Suelta el ítem sobre una carpeta para moverlo.')
      return
    }
    if (isOsSameFolderDrop(e.dataTransfer)) {
      toast.error('Ya está en esta carpeta.')
      return
    }
    if (!isOsFileDrag(e.dataTransfer) || importing) return
    void importOsDrop(e.dataTransfer)
  }

  async function startShareFromFolder(folder: string): Promise<void> {
    setShareStarting(true)
    try {
      const result = await api.startShare({ folder })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, 'No se pudo iniciar el share.'))
        return
      }
      await refreshStatus()
      toast.success('Compartiendo')
      setNav({ kind: 'local', path: '' })
    } catch (err) {
      toast.error(
        mapIpcError(err instanceof Error ? err.message : String(err), 'No se pudo iniciar el share.')
      )
    } finally {
      setShareStarting(false)
    }
  }

  async function quickSharePick(): Promise<void> {
    if (shareStarting || running) return
    const path = await api.selectFolder()
    if (!path) return
    await startShareFromFolder(path)
  }

  function acceptWelcomeDrop(e: DragEvent): boolean {
    if (nav.kind !== 'root' || running || shareStarting) return false
    if (isInternalFileDragActive()) return false
    if (!isOsFileDrag(e.dataTransfer)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    return true
  }

  function handleWelcomeDragEnter(e: DragEvent): void {
    if (!acceptWelcomeDrop(e)) return
    dropDepthRef.current += 1
    setDropActive(true)
  }

  function handleWelcomeDragOver(e: DragEvent): void {
    if (!acceptWelcomeDrop(e)) return
    setDropActive(true)
  }

  function handleWelcomeDragLeave(): void {
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1)
    if (dropDepthRef.current === 0) setDropActive(false)
  }

  function handleWelcomeDrop(e: DragEvent): void {
    if (nav.kind !== 'root' || running) return
    e.preventDefault()
    dropDepthRef.current = 0
    setDropActive(false)
    if (isInternalFileDragActive()) return
    if (!isOsFileDrag(e.dataTransfer) || shareStarting) return
    const folder = osDropSingleDirectoryPath(e.dataTransfer)
    if (!folder) {
      toast.error('Suelta una sola carpeta.')
      return
    }
    void startShareFromFolder(folder)
  }

  useEffect(() => {
    setContentScrolled(false)
  }, [nav.kind])

  const showLoading = loading && !hasLoadedOnce.current && nav.kind !== 'root'
  const localOnline = running
  const sidebarLocalActive = nav.kind === 'local'
  const sidebarPeerActive = nav.kind === 'peer' ? nav.peer.baseUrl : null

  function renderEmptyFolder(): ReactElement {
    return (
      <div className="finder-empty">
        <div className="finder-empty-card">
          <span className="finder-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 96 80" width="72" height="60">
              <path
                d="M8 18c0-4.4 3.6-8 8-8h18.5c2.1 0 4.1.8 5.6 2.3L46 18.2c1.5 1.5 3.5 2.3 5.6 2.3H80c4.4 0 8 3.6 8 8V62c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V18z"
                fill="#5AC8FA"
              />
              <path d="M8 28h80v34c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V28z" fill="#007AFF" />
            </svg>
          </span>
          <h2 className="finder-empty-title">Esta carpeta está vacía</h2>
          <p className="finder-empty-sub">
            Arrastra archivos aquí o crea una carpeta nueva para empezar.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={startNewFolder}
            disabled={opBusy || Boolean(renameMode)}
          >
            Nueva carpeta
          </Button>
        </div>
      </div>
    )
  }

  function renderWelcome(): ReactElement {
    const canQuickShare = !localOnline
    return (
      <div
        className={`finder-empty${canQuickShare ? ' finder-drop-target' : ''}${
          canQuickShare && dropActive ? ' active' : ''
        }`}
        onDragEnter={canQuickShare ? handleWelcomeDragEnter : undefined}
        onDragOver={canQuickShare ? handleWelcomeDragOver : undefined}
        onDragLeave={canQuickShare ? handleWelcomeDragLeave : undefined}
        onDrop={canQuickShare ? handleWelcomeDrop : undefined}
      >
        <div className="finder-empty-card">
          <span className="finder-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 96 80" width="72" height="60">
              <path
                d="M8 18c0-4.4 3.6-8 8-8h18.5c2.1 0 4.1.8 5.6 2.3L46 18.2c1.5 1.5 3.5 2.3 5.6 2.3H80c4.4 0 8 3.6 8 8V62c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V18z"
                fill="#5AC8FA"
              />
              <path d="M8 28h80v34c0 4.4-3.6 8-8 8H16c-4.4 0-8-3.6-8-8V28z" fill="#007AFF" />
            </svg>
          </span>
          <h2 className="finder-empty-title">
            {localOnline ? 'Elige una carpeta' : 'Comparte una carpeta'}
          </h2>
          <p className="finder-empty-sub">
            {localOnline
              ? 'Abre Mi carpeta o un peer desde la barra lateral para explorar archivos.'
              : 'Elige o arrastra una carpeta para empezar a compartir en la red local.'}
          </p>
          {localOnline ? (
            <Button variant="primary" size="sm" onClick={selectLocalShare}>
              Abrir Mi carpeta
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void quickSharePick()}
                loading={shareStarting}
                disabled={shareStarting}
              >
                Compartir una carpeta…
              </Button>
              <button type="button" className="finder-empty-link" onClick={onOpenSettings}>
                Opciones avanzadas (clave, inicio automático)
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const transferPct =
    transfer && transfer.total > 0
      ? Math.min(100, Math.round((transfer.copied / transfer.total) * 100))
      : null

  return (
    <section
      className={`finder${importing || shareStarting || opBusy ? ' finder-drag-busy' : ''}`}
      aria-label="Compartidos"
      aria-busy={Boolean(importing || shareStarting || opBusy)}
      tabIndex={-1}
    >
      <header className={`finder-toolbar${contentScrolled ? ' scrolled' : ''}`}>
        <div className="finder-toolbar-actions" role="toolbar" aria-label="Navegación">
          {importing ? (
            <span className="finder-import-status" role="status" aria-live="polite">
              Importando…
            </span>
          ) : null}
        </div>

        <div className="finder-toolbar-view-cluster">
          {nav.kind !== 'root' ? (
            <div className="finder-toolbar-ops" role="toolbar" aria-label="Carpeta">
              <button
                type="button"
                className="finder-tool-btn"
                aria-label="Nueva carpeta"
                title="Nueva carpeta"
                disabled={opBusy || Boolean(renameMode)}
                onClick={startNewFolder}
              >
                <FolderPlus size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="finder-tool-btn"
                aria-label="Actualizar"
                title="Actualizar"
                onClick={() => void loadContents({ silent: false })}
              >
                <RefreshCw size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <div className="finder-sort" role="group" aria-label="Orden">
            <label className="finder-sort-label" htmlFor="finder-sort-key">
              Orden
            </label>
            <select
              id="finder-sort-key"
              className="finder-sort-select"
              value={sort.key}
              aria-label="Criterio de orden"
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="finder-tool-btn"
              aria-label={sort.dir === 'asc' ? 'Orden ascendente' : 'Orden descendente'}
              title={sort.dir === 'asc' ? 'Ascendente' : 'Descendente'}
              onClick={toggleSortDir}
            >
              {sort.dir === 'asc' ? (
                <ArrowUp size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <ArrowDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="finder-view-toggle" role="group" aria-label="Vista">
            <button
              type="button"
              className={viewMode === 'icons' ? 'finder-toggle on' : 'finder-toggle'}
              aria-pressed={viewMode === 'icons'}
              aria-label="Vista de iconos"
              title="Iconos"
              onClick={() => setViewMode('icons')}
            >
              <LayoutGrid size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={viewMode === 'list' ? 'finder-toggle on' : 'finder-toggle'}
              aria-pressed={viewMode === 'list'}
              aria-label="Vista de lista"
              title="Lista"
              onClick={() => setViewMode('list')}
            >
              <List size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="finder-toolbar-end">
          <button
            type="button"
            className="finder-tool-btn"
            aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
            onClick={() => {
              const next: Theme = theme === 'dark' ? 'light' : 'dark'
              applyTheme(next)
              setTheme(next)
            }}
          >
            {theme === 'dark' ? (
              <Sun size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <Moon size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="finder-tool-btn"
            aria-label="Configurar"
            title="Configurar"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={onOpenSettings}
          >
            <Settings size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="finder-body">
        <aside className="finder-sidebar" aria-label="Ubicaciones">
          <div className="finder-sidebar-label">Compartidos</div>
          <button
            type="button"
            className={`finder-side-item${sidebarLocalActive ? ' active' : ''}`}
            onClick={selectLocalShare}
          >
            <span className="finder-side-icon" aria-hidden="true">
              <Folder size={ICON_SIDE} strokeWidth={ICON_STROKE} />
            </span>
            <span className="finder-side-name">Mi carpeta</span>
            <span className="finder-side-meta">
              {status?.tokenRequired ? <LockBadge /> : null}
              <span className={`finder-side-dot${localOnline ? ' on' : ''}`} aria-hidden="true" />
            </span>
          </button>
          <div className="finder-sidebar-label">En la red</div>
          {peers.map((peer) => {
            const online = isFresh(peer)
            return (
              <button
                key={peer.baseUrl}
                type="button"
                className={`finder-side-item${sidebarPeerActive === peer.baseUrl ? ' active' : ''}`}
                onClick={() => selectPeerShare(peer)}
                title={`${peer.host}:${peer.port}`}
              >
                <span className="finder-side-icon" aria-hidden="true">
                  <Monitor size={ICON_SIDE} strokeWidth={ICON_STROKE} />
                </span>
                <span className="finder-side-name">{peer.name}</span>
                <span className="finder-side-meta">
                  {peer.tokenRequired ? <LockBadge /> : null}
                  <span className={`finder-side-dot${online ? ' on' : ''}`} aria-hidden="true" />
                </span>
              </button>
            )
          })}
          {peers.length === 0 ? (
            <p className="finder-side-hint">Los peers de la red aparecen aquí.</p>
          ) : null}
        </aside>

        <div className="finder-pane">
          <div
            className="finder-content"
            onScroll={(e) => setContentScrolled((e.currentTarget as HTMLDivElement).scrollTop > 4)}
          >
            {nav.kind === 'root' && renderWelcome()}

            {nav.kind !== 'root' && (
              <div
                className={`finder-drop-target${dropActive ? ' active' : ''}`}
                onDragEnter={handleOsDragEnter}
                onDragOver={handleOsDragOver}
                onDragLeave={handleOsDragLeave}
                onDrop={handleOsDrop}
              >
                {showLoading && <div className="state-box">Cargando…</div>}
                {!showLoading &&
                  viewMode === 'list' &&
                  (sortedEntries.length > 0 || renameMode?.kind === 'create') && (
                    <div className="finder-list-head" role="row">
                      <span />
                      <button
                        type="button"
                        className={`finder-list-sort${sort.key === 'name' ? ' on' : ''}`}
                        aria-label={`Ordenar por nombre${sort.key === 'name' ? `, ${sort.dir === 'asc' ? 'ascendente' : 'descendente'}` : ''}`}
                        onClick={() => cycleSortColumn('name')}
                      >
                        Nombre
                        {sort.key === 'name' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                      <button
                        type="button"
                        className={`finder-list-sort${sort.key === 'type' ? ' on' : ''}`}
                        aria-label={`Ordenar por tipo${sort.key === 'type' ? `, ${sort.dir === 'asc' ? 'ascendente' : 'descendente'}` : ''}`}
                        onClick={() => cycleSortColumn('type')}
                      >
                        Estado
                        {sort.key === 'type' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                      <button
                        type="button"
                        className={`finder-list-sort${sort.key === 'date' || sort.key === 'size' ? ' on' : ''}`}
                        aria-label={`Ordenar por fecha${sort.key === 'date' ? `, ${sort.dir === 'asc' ? 'ascendente' : 'descendente'}` : ''}`}
                        onClick={() => cycleSortColumn('date')}
                      >
                        Modificado / tamaño
                        {sort.key === 'date' || sort.key === 'size'
                          ? sort.dir === 'asc'
                            ? ' ↑'
                            : ' ↓'
                          : ''}
                      </button>
                      <span />
                    </div>
                  )}
                {!showLoading &&
                  sortedEntries.length === 0 &&
                  !listFailed &&
                  renameMode?.kind !== 'create' &&
                  renderEmptyFolder()}
                {!showLoading && (sortedEntries.length > 0 || renameMode?.kind === 'create') && (
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
                    {sortedEntries.map((entry) => (
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
                            entry.isDir
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
                          dropActive={folderDropPath === entry.path}
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
                          onDragStart={(e) => handleEntryDragStart(entry, e)}
                          onDragEnter={
                            entry.isDir
                              ? (e) => {
                                  e.stopPropagation()
                                  if (folderDropEffect(entry, e)) {
                                    setFolderDropPath(entry.path)
                                    setDropActive(false)
                                  }
                                }
                              : undefined
                          }
                          onDragOver={
                            entry.isDir ? (e) => handleFolderDragOver(entry, e) : undefined
                          }
                          onDragLeave={
                            entry.isDir ? (e) => handleFolderDragLeave(entry, e) : undefined
                          }
                          onDrop={entry.isDir ? (e) => handleFolderDrop(entry, e) : undefined}
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
          </div>
        </div>
      </div>

      <footer className="finder-statusbar">
        {transfer && transferPct != null ? (
          <div
            className="transfer-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transferPct}
            aria-label={`Transferencia ${transferPct}%`}
          >
            <div className="transfer-progress-bar" style={{ width: `${transferPct}%` }} />
          </div>
        ) : null}
        <nav className="finder-crumbs" aria-label="Ruta">
          {crumbs.length === 0 ? (
            <span className="finder-crumb current">
              <span className="finder-crumb-icon">
                <FolderIcon size="sm" />
              </span>
              Compartidos
            </span>
          ) : (
            crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="finder-crumb-wrap">
                {i > 0 && <span className="crumb-sep">›</span>}
                <button
                  type="button"
                  className={`finder-crumb${i === crumbs.length - 1 ? ' current' : ''}`}
                  onClick={c.go}
                >
                  <span className="finder-crumb-icon">
                    <FolderIcon size="sm" />
                  </span>
                  {c.label}
                </button>
              </span>
            ))
          )}
        </nav>
        <span
          className={`finder-share-state${running ? ' on' : ''}`}
          role="status"
          aria-live="polite"
          aria-label={running ? 'Compartiendo' : 'Sin compartir'}
          title={running ? 'Compartiendo' : 'Sin compartir'}
        >
          <Radio size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span className={`finder-share-dot${running ? ' on' : ''}`} aria-hidden="true" />
        </span>
      </footer>

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
                  id: 'saveAs',
                  label: 'Guardar como…',
                  onSelect: () => void saveEntryAs(menu.entry)
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
        bare
        onClose={() => {
          setPendingPeer(null)
          setTokenDraft('')
          setTokenError(null)
        }}
        size="sm"
      >
        <form id="peer-token-form" className="form-grid" onSubmit={confirmToken}>
          <Input
            ref={tokenInputRef}
            id="peer-token"
            type="password"
            autoComplete="off"
            aria-label="Clave"
            placeholder="Clave"
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
