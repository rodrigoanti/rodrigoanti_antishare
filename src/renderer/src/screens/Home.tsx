import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import {
  ArrowLeft,
  FolderPlus,
  FolderSync,
  LayoutGrid,
  List,
  Lock,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Trash2,
  Users
} from 'lucide-react'
import type { DirEntry, DiscoveredGroup, GroupView, ImportLocalResult } from '../../../shared/types'
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
import { Button, ContextMenu, Input, Modal, SidePanel, toast, type ContextMenuItem } from '../ui'
import { FolderItem, type FinderViewMode } from '../ui/FolderItem'
import { fileGlyphKind, FolderIcon } from '../ui/FolderIcon'
import { CreateGroupModal, JoinGroupModal } from './GroupModals'
import { formatRelative, GroupPanel, lastSyncLabel, NetworkPanel, syncSummary, useNow } from './GroupPanel'

const ICON_STROKE = 1.75
const ICON_TOOL = 15
const ICON_SIDE = 16

const VIEW_KEY = 'antishare.finderView'

type SortKey = 'name' | 'date' | 'size' | 'type'
type SortDir = 'asc' | 'desc'
type SortPref = { key: SortKey; dir: SortDir }

type Nav = { kind: 'root' } | { kind: 'group'; groupId: string; path: string }
/** Drop target folder: a visible subfolder or a breadcrumb ('' = group root). */
type DropDest = { path: string; name: string }

function navId(n: Nav): string {
  return n.kind === 'group' ? `group:${n.groupId}:${n.path}` : 'root'
}

/** Case- and accent-insensitive key for the name filter («inf» matches «Informe»). */
function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
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

const REVEAL_LABEL = /mac/i.test(navigator.platform) ? 'Mostrar en Finder' : 'Mostrar en el Explorador'
const REVEAL_FOLDER_LABEL = /mac/i.test(navigator.platform)
  ? 'Mostrar carpeta en Finder'
  : 'Mostrar carpeta en el Explorador'

/** Where a delete lands: it goes to the Trash here and on every member that syncs it. */
function deleteReachLabel(others: number): string {
  if (others === 0) return 'Se moverá a la Papelera de este equipo.'
  return 'Se moverá a la Papelera en todos los equipos.'
}

function deleteTitle(targets: DirEntry[]): string {
  if (targets.length > 1) return `Eliminar ${targets.length} elementos`
  return targets[0]?.isDir ? 'Eliminar carpeta' : 'Eliminar archivo'
}

/** One entry is named; several are counted, noting folders take their contents with them. */
function deleteQuestion(targets: DirEntry[]): string {
  if (targets.length === 1) {
    const [entry] = targets
    return `¿Eliminar «${entry.name}»${entry.isDir ? ' y todo su contenido' : ''}?`
  }
  const folders = targets.filter((en) => en.isDir).length
  const suffix = folders > 0 ? ' Las carpetas se borran con todo su contenido.' : ''
  return `¿Eliminar estos ${targets.length} elementos?${suffix}`
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

type Xfer = { copied: number; total: number }

function xferPct(x: Xfer | null): number | null {
  if (!x || x.total <= 0) return null
  return Math.min(100, Math.floor((x.copied / x.total) * 100))
}

/** Texto visible: porcentaje exacto y, si se pide, los bytes copiados. */
function xferLabel(verb: string, x: Xfer | null, withSizes: boolean): string {
  const pct = xferPct(x)
  if (x == null || pct == null) return `${verb}…`
  const sizes = withSizes
    ? ` (${formatSize(x.copied, false)} de ${formatSize(x.total, false)})`
    : ''
  return `${verb}… ${pct} %${sizes}`
}

/** Texto para lector de pantalla: solo cambia cada 10 % para no saturar. */
function xferAnnouncement(verb: string, x: Xfer | null): string {
  const pct = xferPct(x)
  if (pct == null) return `${verb}…`
  return `${verb}… ${Math.floor(pct / 10) * 10} %`
}

function formatMtime(ms: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

/** «Modificado por PC-Ana · hace 5 min»; undefined when the device is unknown (date only). */
function modifiedByTitle(entry: DirEntry): string | undefined {
  if (!entry.modifiedByName || !entry.mtime) return undefined
  return `Modificado por ${entry.modifiedByName} · ${formatRelative(entry.mtime)}`
}

/** Footer sync line; owns its 30 s tick so Home does not re-render for the tooltip. */
function FooterSyncState({ group }: { group: GroupView }): ReactElement {
  const now = useNow()
  const summary = syncSummary(group)
  return (
    <span
      className="finder-sync-state"
      role="status"
      aria-live="polite"
      title={group.sync ? lastSyncLabel(group.sync, now) : undefined}
    >
      <span className={`finder-side-dot sync-${summary.tone}`} aria-hidden="true" />
      {summary.label}
      {group.members.length > 0
        ? ` · ${group.members.length} ${group.members.length === 1 ? 'equipo' : 'equipos'}`
        : ' · solo este equipo'}
    </span>
  )
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
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set())
  /** Last plainly or Cmd/Ctrl-clicked entry; Shift+click extends the range from here. */
  const selectionAnchorRef = useRef<string | null>(null)
  /** Entry paths carried by the internal drag in progress (one or the whole selection). */
  const dragPathsRef = useRef<string[]>([])
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importXfer, setImportXfer] = useState<{ copied: number; total: number } | null>(null)
  const [exportXfer, setExportXfer] = useState<{ copied: number; total: number } | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [folderDropPath, setFolderDropPath] = useState<string | null>(null)
  /** Breadcrumb under the pointer during a drag; label says what a drop would do. */
  const [crumbDrop, setCrumbDrop] = useState<{ path: string; label: string } | null>(null)
  const [renameMode, setRenameMode] = useState<
    { kind: 'existing'; path: string; value: string } | { kind: 'create'; value: string } | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DirEntry[] | null>(null)
  const [opBusy, setOpBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const filterInputRef = useRef<HTMLInputElement>(null)
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

  const filterQuery = filter.trim()
  const visibleEntries = useMemo(() => {
    if (!filterQuery) return sortedEntries
    const needle = foldName(filterQuery)
    return sortedEntries.filter((entry) => foldName(entry.name).includes(needle))
  }, [sortedEntries, filterQuery])

  useEffect(() => {
    setFilter('')
  }, [nav])

  /** Replaces the selection with a single entry (or clears it). */
  function selectOnly(key: string | null): void {
    selectionAnchorRef.current = key
    setSelectedKeys(key ? new Set([key]) : new Set())
  }

  /** Finder / Explorer: click selects one, Cmd/Ctrl toggles, Shift selects a range of what is visible. */
  function selectWithModifiers(entry: DirEntry, e: ReactMouseEvent): void {
    const additive = e.metaKey || e.ctrlKey
    if (e.shiftKey) {
      const order = visibleEntries.map((en) => en.path)
      const from = order.indexOf(selectionAnchorRef.current ?? '')
      const to = order.indexOf(entry.path)
      if (from < 0 || to < 0) {
        selectOnly(entry.path)
        return
      }
      const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
      setSelectedKeys((prev) => new Set(additive ? [...prev, ...range] : range))
      return
    }
    selectionAnchorRef.current = entry.path
    if (additive) {
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
      return
    }
    setSelectedKeys(new Set([entry.path]))
  }

  /** Selected entries in the order they are shown; drops paths no longer listed. */
  const selectedEntries = useMemo(
    () => sortedEntries.filter((en) => selectedKeys.has(en.path)),
    [sortedEntries, selectedKeys]
  )

  /** Entry path to scroll into view once the list renders it (e.g. right after an import). */
  const pendingRevealRef = useRef<string | null>(null)
  useEffect(() => {
    const path = pendingRevealRef.current
    if (!path) return
    const el = document.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`)
    if (!el) return
    pendingRevealRef.current = null
    el.scrollIntoView({ block: 'nearest' })
  }, [visibleEntries])

  /** After an import: warn about renamed duplicates and select the first imported item. */
  function afterImport(result: ImportLocalResult, destPath: string): void {
    const renamed = result.renamed ?? []
    if (renamed.length === 1) {
      toast.info(`Ya existía «${renamed[0].from}»; se guardó como «${renamed[0].to}»`)
    } else if (renamed.length > 1) {
      toast.info(`${renamed.length} archivos ya existían y se guardaron con otro nombre`)
    }
    const first = result.names?.[0]
    if (nav.kind === 'root' || !first || destPath !== nav.path) return
    if (filterQuery && !foldName(first).includes(foldName(filterQuery))) setFilter('')
    const key = joinPath(nav.path, first)
    pendingRevealRef.current = key
    selectOnly(key)
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
    selectOnly(null)
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
    selectOnly(nav.path)
    setNav({ kind: 'group', groupId: nav.groupId, path: parent })
  }

  const crumbs = useMemo(() => {
    const items: { label: string; path: string; go: () => void }[] = []
    if (nav.kind !== 'group') return items
    const id = nav.groupId
    items.push({
      label: currentGroup?.name ?? 'Grupo',
      path: '',
      go: () => setNav({ kind: 'group', groupId: id, path: '' })
    })
    let acc = ''
    for (const part of nav.path.split('/').filter(Boolean)) {
      acc = joinPath(acc, part)
      const path = acc
      items.push({ label: part, path, go: () => setNav({ kind: 'group', groupId: id, path }) })
    }
    return items
  }, [nav, currentGroup?.name])

  useEffect(() => {
    if (nav.kind === 'root') return
    const onKey = (e: KeyboardEvent): void => {
      if (renameMode || pendingDelete || joinTarget || createFolder !== null || settingsOpen || opBusy) return
      // Finder / Explorer: ⌘F · Ctrl+F focuses the name filter, even from another field.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        const input = filterInputRef.current
        if (input) {
          e.preventDefault()
          input.focus()
          input.select()
        }
        return
      }
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
      if (e.key === 'Delete' && selectedEntries.length > 0) {
        e.preventDefault()
        setPendingDelete(selectedEntries)
        return
      }
      if (selectedEntries.length !== 1) return
      const entry = selectedEntries[0]
      if (e.key === 'Enter') {
        e.preventDefault()
        void openEntry(entry)
      } else if (e.key === 'F2') {
        e.preventDefault()
        beginRename(entry)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav, renameMode, pendingDelete, joinTarget, createFolder, settingsOpen, opBusy, selectedEntries])

  function openGroup(group: GroupView): void {
    selectOnly(null)
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
    selectOnly(entry.path)
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
      selectOnly(joinPath(nav.path, name))
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

  /** Removes the pending entries one by one; stops at the first failure and keeps the rest pending. */
  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || pendingDelete.length === 0 || nav.kind === 'root') return
    const targets = pendingDelete
    const removed = new Set<string>()
    setOpBusy(true)
    try {
      for (const entry of targets) {
        let error: string | undefined
        try {
          const result = await api.removeLocal({ groupId, path: entry.path })
          if (!result.ok) error = mapIpcError(result.error, `No se pudo eliminar «${entry.name}».`)
        } catch (err) {
          error = mapIpcError(
            err instanceof Error ? err.message : String(err),
            `No se pudo eliminar «${entry.name}».`
          )
        }
        if (error) {
          toast.error(error)
          break
        }
        removed.add(entry.path)
      }
      if (removed.size === 0) return
      const left = targets.filter((en) => !removed.has(en.path))
      setPendingDelete(left.length > 0 ? left : null)
      setSelectedKeys((prev) => new Set([...prev].filter((key) => !removed.has(key))))
      toast.success(removed.size === 1 ? 'Eliminado' : `${removed.size} elementos eliminados`)
      const refreshed = await loadContents({ silent: true })
      if (!refreshed) toast.error('No se pudo actualizar el listado.')
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

  async function revealEntry(entry: DirEntry): Promise<void> {
    if (nav.kind !== 'group') return
    const result = await api.revealFile({ groupId: nav.groupId, path: entry.path })
    if (!result.ok) toast.error(mapIpcError(result.error, `No se pudo mostrar «${entry.name}».`))
  }

  async function revealCurrentFolder(): Promise<void> {
    if (nav.kind !== 'group') return
    const result = await api.revealFile({ groupId: nav.groupId, path: nav.path })
    if (!result.ok) toast.error(mapIpcError(result.error, 'No se pudo mostrar la carpeta.'))
  }

  /** A click on empty space (not on an entry or a control) clears the selection. */
  function handleBackgroundClick(e: ReactMouseEvent<HTMLDivElement>): void {
    if (renameMode) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, a, [role="group"]')) return
    selectOnly(null)
  }

  function handleBackgroundContextMenu(e: ReactMouseEvent<HTMLDivElement>): void {
    // Items open their own menu and call preventDefault; only the empty area lands here.
    if (e.defaultPrevented || renameMode) return
    e.preventDefault()
    selectOnly(null)
    setMenu({ x: e.clientX, y: e.clientY, entry: null })
  }

  async function openEntry(entry: DirEntry): Promise<void> {
    selectOnly(entry.path)
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
    // Dragging part of a multi-selection carries all of it; any other entry drags alone.
    const carried =
      selectedKeys.has(entry.path) && selectedEntries.length > 1
        ? selectedEntries.map((en) => en.path)
        : [entry.path]
    if (carried.length === 1) selectOnly(entry.path)
    dragPathsRef.current = carried
    markInternalDrag(e.dataTransfer)
    beginInternalFileDrag(nav.path || '', entry.path)
  }

  /** Paths of the internal drag in progress; falls back to the single tracked source. */
  function internalDragPaths(): string[] {
    const srcPath = getInternalDragSourcePath()
    if (!srcPath) return []
    const carried = dragPathsRef.current
    return carried.includes(srcPath) ? carried : [srcPath]
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
      setCrumbDrop(null)
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
    setCrumbDrop(null)
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
  function folderDropEffect(dest: DropDest, e: DragEvent): 'move' | 'copy' | null {
    if (nav.kind === 'root' || !groupReady || importing || opBusy) return null

    if (isInternalFileDragActive()) {
      const srcPaths = internalDragPaths()
      if (srcPaths.length === 0) return null
      if (srcPaths.some((src) => isSharePathInsideOrEqual(src, dest.path))) return null
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

  function handleFolderDragOver(dest: DropDest, e: DragEvent<HTMLButtonElement>): void {
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

  function handleFolderDragLeave(dest: DropDest, e: DragEvent<HTMLButtonElement>): void {
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
      afterImport(result, destPath)
    } catch (err) {
      toast.error(
        mapIpcError(err instanceof Error ? err.message : String(err), 'No se pudo importar.')
      )
    } finally {
      setImporting(false)
    }
  }

  /** Moves every dragged entry with the existing single move, one by one; stops at the first failure. */
  async function moveInternalToFolder(dest: DropDest): Promise<void> {
    if (nav.kind === 'root') return
    const srcPaths = internalDragPaths()
    if (srcPaths.length === 0) return
    const moved = new Set<string>()
    setOpBusy(true)
    try {
      for (const srcPath of srcPaths) {
        const srcName = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath
        let error: string | undefined
        try {
          const result = await api.moveLocal({ groupId, path: srcPath, destPath: dest.path })
          if (!result.ok) error = mapIpcError(result.error, `No se pudo mover «${srcName}».`)
        } catch (err) {
          error = mapIpcError(err instanceof Error ? err.message : String(err), `No se pudo mover «${srcName}».`)
        }
        if (error) {
          toast.error(error)
          break
        }
        moved.add(srcPath)
      }
      if (moved.size === 0) return
      setSelectedKeys((prev) => new Set([...prev].filter((key) => !moved.has(key))))
      toast.success(
        moved.size === 1 ? `Movido a «${dest.name}»` : `${moved.size} elementos movidos a «${dest.name}»`
      )
      await loadContents({ silent: true })
    } finally {
      dragPathsRef.current = []
      setOpBusy(false)
    }
  }

  function handleFolderDrop(dest: DropDest, e: DragEvent<HTMLButtonElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const effect = folderDropEffect(dest, e)
    const dt = e.dataTransfer
    dropDepthRef.current = 0
    setDropActive(false)
    setFolderDropPath(null)
    setCrumbDrop(null)

    if (!effect) return

    if (effect === 'move') {
      void moveInternalToFolder(dest)
      return
    }
    if (importing || !dt) return
    void importOsDropTo(dt, dest.path, dest.name)
  }

  /** Breadcrumb drop: same rules as a folder; the open folder never accepts. */
  function crumbDropEffect(dest: DropDest, isCurrent: boolean, e: DragEvent): 'move' | 'copy' | null {
    e.stopPropagation()
    const effect = isCurrent ? null : folderDropEffect(dest, e)
    if (!effect) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
    }
    return effect
  }

  function handleCrumbDragOver(dest: DropDest, isCurrent: boolean, e: DragEvent<HTMLButtonElement>): void {
    const effect = crumbDropEffect(dest, isCurrent, e)
    if (!effect && !isInternalFileDragActive() && !isOsFileDrag(e.dataTransfer)) {
      setCrumbDrop(null)
      return
    }
    setFolderDropPath(effect ? dest.path : null)
    setCrumbDrop({
      path: dest.path,
      label: effect === 'move' ? 'Mover aquí' : effect === 'copy' ? 'Importar aquí' : 'No disponible'
    })
    setDropActive(false)
  }

  function handleCrumbDragLeave(dest: DropDest, e: DragEvent<HTMLButtonElement>): void {
    handleFolderDragLeave(dest, e)
    const related = e.relatedTarget
    if (related instanceof Node && e.currentTarget.contains(related)) return
    setCrumbDrop((cur) => (cur?.path === dest.path ? null : cur))
  }

  function handleCrumbDrop(dest: DropDest, isCurrent: boolean, e: DragEvent<HTMLButtonElement>): void {
    if (isCurrent) {
      e.preventDefault()
      e.stopPropagation()
      setFolderDropPath(null)
      setCrumbDrop(null)
      return
    }
    handleFolderDrop(dest, e)
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
    await importSources(sources)
  }

  async function pickAndImport(): Promise<void> {
    if (nav.kind === 'root' || importing) return
    try {
      const sources = await api.selectFiles()
      if (sources.length > 0) await importSources(sources)
    } catch (err) {
      toast.error(
        mapIpcError(err instanceof Error ? err.message : String(err), 'No se pudo abrir el selector.')
      )
    }
  }

  /** Imports local paths into the open folder; shared by drop and the «Añadir archivos» picker. */
  async function importSources(sources: string[]): Promise<void> {
    if (nav.kind === 'root') return
    setImporting(true)
    try {
      const result = await api.importLocal({ groupId, sources, destPath: nav.path || undefined })
      if (!result.ok) {
        toast.error(mapIpcError(result.error, 'No se pudo importar.'))
        return
      }
      toast.success(sources.length === 1 ? 'Importado' : `${sources.length} importados`)
      await loadContents({ silent: true })
      afterImport(result, nav.path)
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
            Arrastra archivos aquí o usa el botón +, o crea una carpeta nueva.
          </p>
          <div className="finder-empty-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={startNewFolder}
              disabled={opBusy || Boolean(renameMode)}
            >
              Nueva carpeta
            </Button>
          </div>
        </div>
      </div>
    )
  }

  function entryMenuItems(entry: DirEntry): ContextMenuItem[] {
    if (selectedKeys.has(entry.path) && selectedEntries.length > 1) {
      const targets = selectedEntries
      return [
        { id: 'reveal', label: REVEAL_LABEL, onSelect: () => void revealEntry(entry) },
        {
          id: 'delete',
          label: `Eliminar ${targets.length} elementos`,
          danger: true,
          onSelect: () => setPendingDelete(targets)
        }
      ]
    }
    return [
      { id: 'open', label: 'Abrir', onSelect: () => void openEntry(entry) },
      { id: 'reveal', label: REVEAL_LABEL, onSelect: () => void revealEntry(entry) },
      { id: 'saveAs', label: 'Guardar como…', onSelect: () => void saveEntryAs(entry) },
      { id: 'rename', label: 'Renombrar', onSelect: () => beginRename(entry) },
      { id: 'delete', label: 'Eliminar', danger: true, onSelect: () => setPendingDelete([entry]) }
    ]
  }

  function backgroundMenuItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    if (!opBusy) items.push({ id: 'newFolder', label: 'Nueva carpeta', onSelect: startNewFolder })
    if (!importing && !opBusy) {
      items.push({ id: 'import', label: 'Añadir archivos…', onSelect: () => void pickAndImport() })
    }
    items.push(
      { id: 'revealFolder', label: REVEAL_FOLDER_LABEL, onSelect: () => void revealCurrentFolder() },
      { id: 'refresh', label: 'Actualizar', onSelect: () => void loadContents({ silent: false }) }
    )
    return items
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
            <span className="finder-import-status">
              <span aria-hidden="true">{xferLabel('Importando', importXfer, true)}</span>
              <span className="sr-only" role="status" aria-live="polite">
                {xferAnnouncement('Importando', importXfer)}
              </span>
            </span>
          ) : null}
          {exportXfer && exportXfer.copied < exportXfer.total ? (
            <span className="finder-import-status">
              <span aria-hidden="true">{xferLabel('Guardando', exportXfer, false)}</span>
              <span className="sr-only" role="status" aria-live="polite">
                {xferAnnouncement('Guardando', exportXfer)}
              </span>
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
          {nav.kind === 'group' && groupReady ? (
            <div className="finder-search" role="search">
              <Input
                ref={filterInputRef}
                type="search"
                inputSize="sm"
                value={filter}
                placeholder="Filtrar"
                aria-label="Filtrar archivos por nombre"
                title={`Filtrar (${api.platform === 'darwin' ? '⌘F' : 'Ctrl+F'})`}
                spellCheck={false}
                autoComplete="off"
                leftIcon={<Search size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  e.stopPropagation()
                  if (filter) setFilter('')
                  else e.currentTarget.blur()
                }}
              />
            </div>
          ) : null}
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
          {nav.kind === 'group' && groupReady ? (
            <button
              type="button"
              className="finder-fab"
              aria-label="Añadir archivos"
              title="Añadir archivos"
              disabled={importing || opBusy || Boolean(renameMode)}
              onClick={() => void pickAndImport()}
            >
              <Plus size={22} strokeWidth={2.25} aria-hidden="true" />
            </button>
          ) : null}
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
                onContextMenu={handleBackgroundContextMenu}
                onClick={handleBackgroundClick}
              >
                {showLoading && <div className="state-box">Cargando…</div>}
                {!showLoading &&
                  viewMode === 'list' &&
                  (visibleEntries.length > 0 || renameMode?.kind === 'create') && (
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
                        Tipo
                        {sort.key === 'type' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                      <button
                        type="button"
                        className={`finder-list-sort${sort.key === 'date' ? ' on' : ''}`}
                        aria-label={`Ordenar por fecha de modificación${sort.key === 'date' ? `, ${sort.dir === 'asc' ? 'ascendente' : 'descendente'}` : ''}`}
                        onClick={() => cycleSortColumn('date')}
                      >
                        Modificado
                        {sort.key === 'date' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                      <button
                        type="button"
                        className={`finder-list-sort finder-list-sort-end${sort.key === 'size' ? ' on' : ''}`}
                        aria-label={`Ordenar por tamaño${sort.key === 'size' ? `, ${sort.dir === 'asc' ? 'ascendente' : 'descendente'}` : ''}`}
                        onClick={() => cycleSortColumn('size')}
                      >
                        Tamaño
                        {sort.key === 'size' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </div>
                  )}
                {!showLoading &&
                  sortedEntries.length === 0 &&
                  !listFailed &&
                  renameMode?.kind !== 'create' &&
                  renderEmptyFolder()}
                {!showLoading &&
                  sortedEntries.length > 0 &&
                  visibleEntries.length === 0 &&
                  renameMode?.kind !== 'create' && (
                    <div className="finder-empty finder-no-results" role="status">
                      <p className="finder-empty-sub">Sin resultados para «{filterQuery}»</p>
                    </div>
                  )}
                {!showLoading && (visibleEntries.length > 0 || renameMode?.kind === 'create') && (
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
                    {visibleEntries.map((entry) => (
                      <li key={entry.path}>
                        <FolderItem
                          data-entry-path={entry.path}
                          viewMode={viewMode}
                          name={entry.isDir ? `${entry.name}` : entry.name}
                          kind={entry.isDir ? 'folder' : 'file'}
                          selected={selectedKeys.has(entry.path)}
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
                          dateLabel={formatMtime(entry.mtime)}
                          dateTitle={modifiedByTitle(entry)}
                          sizeLabel={formatSize(entry.size, entry.isDir)}
                          dropActive={folderDropPath === entry.path}
                          onClick={(e) => {
                            if (renameMode) return
                            selectWithModifiers(entry, e)
                          }}
                          onDoubleClick={() => {
                            if (renameMode) return
                            void openEntry(entry)
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            if (!selectedKeys.has(entry.path)) selectOnly(entry.path)
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
            crumbs.map((c, i) => {
              const isCurrent = i === crumbs.length - 1
              const dest: DropDest = { path: c.path, name: c.label }
              const hint = crumbDrop?.path === c.path ? crumbDrop.label : null
              return (
                <span key={`${c.label}-${i}`} className="finder-crumb-wrap">
                  {i > 0 && <span className="crumb-sep">›</span>}
                  <button
                    type="button"
                    className={`finder-crumb${isCurrent ? ' current' : ''}${
                      folderDropPath === c.path ? ' drop-active' : ''
                    }${hint && folderDropPath !== c.path ? ' drop-rejected' : ''}`}
                    onClick={c.go}
                    onDragEnter={(e) => handleCrumbDragOver(dest, isCurrent, e)}
                    onDragOver={(e) => handleCrumbDragOver(dest, isCurrent, e)}
                    onDragLeave={(e) => handleCrumbDragLeave(dest, e)}
                    onDrop={(e) => handleCrumbDrop(dest, isCurrent, e)}
                  >
                    <span className="finder-crumb-icon">
                      <FolderIcon size="sm" />
                    </span>
                    {c.label}
                    {hint ? <span className="finder-crumb-hint">{hint}</span> : null}
                  </button>
                </span>
              )
            })
          )}
        </nav>
        {currentGroup ? (
          <FooterSyncState group={currentGroup} />
        ) : null}
      </footer>

      <ContextMenu
        open={Boolean(menu)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={
          menu?.entry
            ? entryMenuItems(menu.entry)
            : menu
              ? backgroundMenuItems()
              : []
        }
      />

      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => {
          if (!opBusy) setPendingDelete(null)
        }}
        title={deleteTitle(pendingDelete ?? [])}
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
        {pendingDelete && pendingDelete.length > 0 ? (
          <div className="delete-confirm">
            <p className="panel-sub" style={{ margin: 0 }}>
              {deleteQuestion(pendingDelete)}
            </p>
            <p className="delete-reach">
              <Users size={15} aria-hidden="true" />
              <span>{deleteReachLabel(currentGroup?.members.length ?? 0)}</span>
            </p>
          </div>
        ) : null}
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
