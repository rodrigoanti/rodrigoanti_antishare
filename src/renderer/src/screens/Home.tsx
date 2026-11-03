import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactElement
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FolderPlus,
  FolderSync,
  LayoutGrid,
  List,
  Lock,
  Moon,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  Users
} from 'lucide-react'
import type { DirEntry, DiscoveredGroup, GroupView } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
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
import { useGroups } from '../groups'
import { applyTheme, type Theme } from '../theme'
import { Button, ContextMenu, Modal, SidePanel, toast } from '../ui'
import { FolderItem, type FinderViewMode } from '../ui/FolderItem'
import { fileGlyphKind, FolderIcon } from '../ui/FolderIcon'
import { CreateGroupModal, JoinGroupModal } from './GroupModals'
import { GroupPanel, NetworkPanel, syncSummary } from './GroupPanel'

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

type Nav = { kind: 'root' } | { kind: 'group'; groupId: string; path: string }

function navId(n: Nav): string {
  return n.kind === 'group' ? `group:${n.groupId}:${n.path}` : 'root'
}

function sortStorageKey(nav: Nav): string {
  if (nav.kind === 'root') return 'antishare.sort:root:.'
  return `antishare.sort:group:${nav.groupId}:${nav.path || '.'}`
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

/** "1 equipo conectado: PC-Ana" — other members online now (this device not counted). */
function membersLabel(members: string[]): string {
  if (members.length === 0) return 'Ningún otro equipo conectado'
  const count = members.length === 1 ? '1 equipo conectado' : `${members.length} equipos conectados`
  return `${count}: ${members.join(', ')}`
}

type JoinTarget = {
  id: string
  name: string
  members: string[]
  folder?: string | null
  locked?: boolean
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

export function Home(): ReactElement {
  const api = getApi()
  const { snapshot, refresh: refreshGroups } = useGroups()
  const [nav, setNav] = useState<Nav>({ kind: 'root' })
  const [contentScrolled, setContentScrolled] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createFolder, setCreateFolder] = useState<string | null>(null)
  const [joinTarget, setJoinTarget] = useState<JoinTarget | null>(null)
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const [viewMode, setViewMode] = useState<FinderViewMode>(readViewMode)
  const [sort, setSort] = useState<SortPref>(() => readSortPref({ kind: 'root' }))
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [listFailed, setListFailed] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
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
  const dropDepthRef = useRef(0)
  const renameCommitLock = useRef(false)
  const activeNavIdRef = useRef('')
  /** Groups this device just left on purpose: their disappearance needs no notice. */
  const leftOnPurpose = useRef(new Set<string>())
  const knownGroups = useRef<Map<string, string> | null>(null)

  const groups = useMemo(() => snapshot?.groups ?? [], [snapshot])
  const discovered = useMemo(() => snapshot?.discovered ?? [], [snapshot])
  const currentGroup: GroupView | null =
    nav.kind === 'group' ? (groups.find((g) => g.id === nav.groupId) ?? null) : null
  const groupId = nav.kind === 'group' ? nav.groupId : undefined
  const groupReady = currentGroup?.state === 'ok'

  // A group vanishing without our action was deleted (or renamed away) by another member.
  useEffect(() => {
    if (!snapshot) return
    const next = new Map(snapshot.groups.map((g) => [g.id, g.name]))
    const prev = knownGroups.current
    knownGroups.current = next
    if (!prev) return
    for (const [id, name] of prev) {
      if (next.has(id)) continue
      if (leftOnPurpose.current.delete(id)) continue
      toast.warning(`«${name}» fue eliminado por otro miembro. Tus archivos siguen en tu carpeta.`)
    }
  }, [snapshot])

  // Leave the explorer when its group is gone.
  useEffect(() => {
    if (nav.kind === 'group' && snapshot && !currentGroup) {
      setNav({ kind: 'root' })
      setSettingsOpen(false)
    }
  }, [nav, snapshot, currentGroup])

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

  const loadContents = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      const myNavId = navId(nav)
      if (nav.kind === 'root' || !groupReady) {
        if (activeNavIdRef.current !== myNavId) return false
        setEntries([])
        setLoading(false)
        setListFailed(false)
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
      }
      const result = await api.listLocal({ groupId: nav.groupId, path: nav.path || undefined })
      if (!result.ok) {
        if (activeNavIdRef.current !== myNavId) return false
        connectionUnstable.current = true
        if (!silent) {
          silentFailStreak.current = 0
          setEntries([])
          setListFailed(true)
          toast.error(mapIpcError(result.error, 'No se pudo listar el contenido.'))
        } else {
          silentFailStreak.current += 1
          if (silentFailStreak.current >= 2) setListFailed(true)
        }
        if (!silent) setLoading(false)
        return false
      }
      if (activeNavIdRef.current !== myNavId) return false
      setEntries(result.entries ?? [])
      setListFailed(false)
      silentFailStreak.current = 0
      connectionUnstable.current = false
      hasLoadedOnce.current = true
      if (!silent) setLoading(false)
      return true
    },
    [api, nav, groupReady]
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
    activeNavIdRef.current = navId(nav)

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

  const canGoUp = nav.kind === 'group' && nav.path !== ''

  /** Parent folder of the open one; at the group root there is nowhere to go. */
  function goUp(): void {
    if (nav.kind !== 'group' || !nav.path) return
    const cut = nav.path.lastIndexOf('/')
    const parent = cut <= 0 ? '' : nav.path.slice(0, cut)
    setSelectedKey(nav.path)
    setNav({ kind: 'group', groupId: nav.groupId, path: parent })
  }

  const crumbs = useMemo(() => {
    const items: { label: string; go: () => void }[] = []
    if (nav.kind !== 'group') return items
    const id = nav.groupId
    items.push({ label: currentGroup?.name ?? 'Grupo', go: () => setNav({ kind: 'group', groupId: id, path: '' }) })
    let acc = ''
    for (const part of nav.path.split('/').filter(Boolean)) {
      acc = joinPath(acc, part)
      const path = acc
      items.push({ label: part, go: () => setNav({ kind: 'group', groupId: id, path }) })
    }
    return items
  }, [nav, currentGroup?.name])

  useEffect(() => {
    if (nav.kind === 'root') return
    const onKey = (e: KeyboardEvent): void => {
      if (renameMode || pendingDelete || joinTarget || createFolder !== null || settingsOpen || opBusy) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // Finder: ⌘↑ · Explorer: Alt+↑ or Backspace.
      const upKey =
        (e.key === 'ArrowUp' && (e.metaKey || e.altKey)) ||
        (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey)
      if (upKey) {
        e.preventDefault()
        goUp()
        return
      }
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
  }, [nav, renameMode, pendingDelete, joinTarget, createFolder, settingsOpen, opBusy, entries, selectedKey])

  function openGroup(group: GroupView): void {
    setSelectedKey(null)
    if (group.state === 'locked') {
      setJoinTarget({ id: group.id, name: group.name, members: group.members, folder: group.folder, locked: true })
    }
    setNav({ kind: 'group', groupId: group.id, path: '' })
  }

  function askJoin(group: DiscoveredGroup): void {
    setJoinTarget({ id: group.id, name: group.name, members: group.members })
  }

  async function onGroupReady(group: GroupView): Promise<void> {
    setCreateFolder(null)
    setJoinTarget(null)
    await refreshGroups()
    setNav({ kind: 'group', groupId: group.id, path: '' })
  }

  function onLeftGroup(): void {
    if (groupId) leftOnPurpose.current.add(groupId)
    setSettingsOpen(false)
    setNav({ kind: 'root' })
    void refreshGroups()
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
      const result = creating
        ? await api.mkdirLocal({ groupId, path: nav.path || undefined, name })
        : await api.renameLocal({ groupId, path: renameMode.path, newName: name })
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
      const result = await api.removeLocal({ groupId, path: entry.path })
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
    if (nav.kind !== 'group') return
    if (entry.isDir) {
      setNav({ kind: 'group', groupId: nav.groupId, path: entry.path || joinPath(nav.path, entry.name) })
      return
    }
    // The file already lives in this device's folder: open it in place.
    setBusyFile(entry.path)
    const result = await api.openFile({ groupId: nav.groupId, path: entry.path })
    if (!result.ok) toast.error(mapIpcError(result.error, `No se pudo abrir «${entry.name}».`))
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
        groupId,
        destDir,
        items: [{ path: entry.path, isDir: entry.isDir }]
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
    return nav.kind === 'group' && isOsDropAlreadyInFolder(dt, currentGroup?.folder, nav.path || '')
  }

  /** Whether dest folder can accept the current drag (internal move or OS import). */
  function folderDropEffect(dest: DirEntry, e: DragEvent): 'move' | 'copy' | null {
    if (!dest.isDir || nav.kind === 'root' || !groupReady || importing || opBusy) return null

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
    if (isOsDropAlreadyInFolder(e.dataTransfer, currentGroup?.folder, dest.path)) {
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
      const result = await api.importLocal({ groupId, sources, destPath: destPath || undefined })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, 'No se pudo importar.'))
        return
      }
      toast.success(
        sources.length === 1
          ? `Importado en «${destName}»`
          : `${sources.length} importados en «${destName}»`
      )
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
      const result = await api.moveLocal({ groupId, path: srcPath, destPath: dest.path })
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
    if (nav.kind === 'root' || !groupReady) return false
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
      const result = await api.importLocal({ groupId, sources, destPath: nav.path || undefined })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, 'No se pudo importar.'))
        return
      }
      toast.success(sources.length === 1 ? 'Importado' : `${sources.length} importados`)
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

  function acceptWelcomeDrop(e: DragEvent): boolean {
    if (nav.kind !== 'root') return false
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
    if (nav.kind !== 'root') return
    e.preventDefault()
    dropDepthRef.current = 0
    setDropActive(false)
    if (isInternalFileDragActive()) return
    if (!isOsFileDrag(e.dataTransfer)) return
    const folder = osDropSingleDirectoryPath(e.dataTransfer)
    if (!folder) {
      toast.error('Suelta una sola carpeta.')
      return
    }
    setCreateFolder(folder)
  }

  useEffect(() => {
    setContentScrolled(false)
  }, [nav.kind])

  const showLoading = loading && !hasLoadedOnce.current && nav.kind !== 'root'

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
    return (
      <div
        className={`finder-empty finder-drop-target${dropActive ? ' active' : ''}`}
        onDragEnter={handleWelcomeDragEnter}
        onDragOver={handleWelcomeDragOver}
        onDragLeave={handleWelcomeDragLeave}
        onDrop={handleWelcomeDrop}
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
            {groups.length > 0 ? 'Elige un grupo' : 'Una carpeta en todos tus equipos'}
          </h2>
          <p className="finder-empty-sub">
            {groups.length > 0
              ? 'Abre un grupo en la barra lateral para ver sus archivos.'
              : 'Crea un grupo con una carpeta y una clave, o únete a uno de la red. Puedes arrastrar una carpeta aquí.'}
          </p>
          <Button variant="primary" size="sm" leftIcon={<Plus size={14} aria-hidden="true" />} onClick={() => setCreateFolder('')}>
            Crear grupo
          </Button>
          {discovered.length > 0 ? (
            <ul className="group-discover-list" aria-label="Grupos en la red">
              {discovered.map((g) => (
                <li key={g.id}>
                  <button type="button" className="group-discover-card" onClick={() => askJoin(g)}>
                    <span className="group-discover-icon" aria-hidden="true">
                      <Users size={ICON_SIDE} strokeWidth={ICON_STROKE} />
                    </span>
                    <span className="group-discover-text">
                      <span className="group-discover-name">{g.name}</span>
                      <span className="group-discover-meta">{g.members.join(', ')}</span>
                    </span>
                    <span className="group-discover-action">Unirse</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {snapshot?.serverError ? (
            <p className="form-error" role="alert">
              {snapshot.serverError}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  function renderLocked(group: GroupView): ReactElement {
    return (
      <div className="finder-empty">
        <div className="finder-empty-card">
          <span className="finder-empty-icon group-locked-icon" aria-hidden="true">
            <Lock size={40} strokeWidth={1.5} />
          </span>
          <h2 className="finder-empty-title">La clave cambió</h2>
          <p className="finder-empty-sub">
            Otro miembro cambió la clave de «{group.name}». La sincronización está en pausa hasta que la escribas.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setJoinTarget({ id: group.id, name: group.name, members: group.members, folder: group.folder, locked: true })
            }
          >
            Escribir clave nueva
          </Button>
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
      className={`finder${importing || opBusy ? ' finder-drag-busy' : ''}`}
      aria-label="Grupos"
      aria-busy={Boolean(importing || opBusy)}
      tabIndex={-1}
    >
      <header className={`finder-toolbar${contentScrolled ? ' scrolled' : ''}`}>
        <div className="finder-toolbar-actions" role="toolbar" aria-label="Navegación">
          {nav.kind === 'group' && groupReady ? (
            <button
              type="button"
              className="finder-tool-btn"
              aria-label="Carpeta superior"
              title={`Carpeta superior (${api.platform === 'darwin' ? '⌘↑' : 'Alt+↑'})`}
              disabled={!canGoUp}
              onClick={goUp}
            >
              <ArrowLeft size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          ) : null}
          {importing ? (
            <span className="finder-import-status" role="status" aria-live="polite">
              Importando…
            </span>
          ) : null}
        </div>

        <div className="finder-toolbar-view-cluster">
          {nav.kind !== 'root' && groupReady ? (
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
            {/* List view: column headers already flip the direction. */}
            {viewMode === 'icons' ? (
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
            ) : null}
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
            aria-label={currentGroup ? 'Ajustes del grupo' : 'Red local'}
            title={currentGroup ? 'Ajustes del grupo' : 'Red local'}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={ICON_TOOL} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="finder-body">
        <aside className="finder-sidebar" aria-label="Grupos">
          <div className="finder-sidebar-head">
            <span className="finder-sidebar-label">Mis grupos</span>
            <button
              type="button"
              className="finder-side-add"
              aria-label="Crear grupo"
              title="Crear grupo"
              onClick={() => setCreateFolder('')}
            >
              <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          </div>
          {groups.map((g) => {
            const sum = syncSummary(g)
            const active = nav.kind === 'group' && nav.groupId === g.id
            return (
              <button
                key={g.id}
                type="button"
                className={`finder-side-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => openGroup(g)}
                title={`${g.name} · ${membersLabel(g.members)} · ${sum.label}`}
              >
                <span className="finder-side-icon" aria-hidden="true">
                  <FolderSync size={ICON_SIDE} strokeWidth={ICON_STROKE} />
                </span>
                <span className="finder-side-name">{g.name}</span>
                <span className="finder-side-meta">
                  {g.members.length > 0 ? (
                    <span className="finder-side-count" aria-label={membersLabel(g.members)}>
                      <Users size={11} strokeWidth={2} aria-hidden="true" />
                      {g.members.length}
                    </span>
                  ) : null}
                  {g.state === 'locked' ? (
                    <Lock size={12} strokeWidth={ICON_STROKE} aria-label="Clave cambiada" />
                  ) : (
                    <span className={`finder-side-dot sync-${sum.tone}`} aria-hidden="true" />
                  )}
                </span>
              </button>
            )
          })}
          {groups.length === 0 ? <p className="finder-side-hint">Crea tu primer grupo con el +.</p> : null}

          <div className="finder-sidebar-label">En la red</div>
          {discovered.map((g) => (
            <button
              key={g.id}
              type="button"
              className="finder-side-item finder-side-item-discover"
              onClick={() => askJoin(g)}
              title={`Unirse a ${g.name} · ${g.members.join(', ')}`}
            >
              <span className="finder-side-icon" aria-hidden="true">
                <Users size={ICON_SIDE} strokeWidth={ICON_STROKE} />
              </span>
              <span className="finder-side-name">{g.name}</span>
              <span className="finder-side-meta">
                <span className="finder-side-join">Unirse</span>
              </span>
            </button>
          ))}
          {discovered.length === 0 ? (
            <p className="finder-side-hint">Los grupos de otros equipos aparecen aquí.</p>
          ) : null}
        </aside>

        <div className="finder-pane">
          <div
            className="finder-content"
            onScroll={(e) => setContentScrolled((e.currentTarget as HTMLDivElement).scrollTop > 4)}
          >
            {nav.kind === 'root' && renderWelcome()}

            {currentGroup?.state === 'locked' && renderLocked(currentGroup)}

            {nav.kind !== 'root' && groupReady && (
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
              Grupos
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
        {currentGroup ? (
          <span className="finder-sync-state" role="status" aria-live="polite">
            <span className={`finder-side-dot sync-${syncSummary(currentGroup).tone}`} aria-hidden="true" />
            {syncSummary(currentGroup).label}
            {currentGroup.members.length > 0
              ? ` · ${currentGroup.members.length} ${currentGroup.members.length === 1 ? 'equipo' : 'equipos'}`
              : ' · solo este equipo'}
          </span>
        ) : null}
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

      <CreateGroupModal
        open={createFolder !== null}
        initialFolder={createFolder ?? undefined}
        onClose={() => setCreateFolder(null)}
        onCreated={(g) => void onGroupReady(g)}
      />

      <JoinGroupModal
        target={joinTarget}
        onClose={() => setJoinTarget(null)}
        onJoined={(g) => void onGroupReady(g)}
      />

      <SidePanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={currentGroup ? currentGroup.name : 'Red local'}
        size="sm"
        side="right"
      >
        {currentGroup ? <GroupPanel group={currentGroup} onLeft={onLeftGroup} /> : <NetworkPanel />}
      </SidePanel>
    </section>
  )
}
