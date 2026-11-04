/** Shared contracts for AntiShare (main ↔ preload ↔ renderer). */

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  /** Device that last changed this file, per the group's sync index («este equipo» for ours). */
  modifiedByName?: string
}

export interface Peer {
  name: string
  host: string
  port: number
  tokenRequired: boolean
  lastSeen: number
  baseUrl: string
  /** Alternate LAN IPv4s for the same peer (try if primary host fails). */
  hosts?: string[]
  /** Groups this peer is a member of (from its UDP announcement). */
  groups?: AnnouncedGroup[]
}

/** Group as seen in a UDP announcement (never carries secrets). */
export interface AnnouncedGroup {
  id: string
  name: string
  /** Tombstone: a member deleted the group for everyone; kept so others learn it. */
  deleted?: boolean
  /** When the current password was set; a newer value elsewhere means ours is outdated. */
  keySince: number
}

/** Group settings any member can change; last writer wins by (rev, at, by). */
export interface GroupMeta {
  name: string
  deleted: boolean
  rev: number
  at: number
  /** Device id of the last editor. */
  by: string
}

/** GET /g/:groupId/meta payload. */
export interface GroupMetaResponse {
  id: string
  meta: GroupMeta
  keySince: number
}

export type GroupState = 'ok' | 'noFolder' | 'locked'

/** One group this device belongs to, as the renderer sees it. */
export interface GroupView {
  id: string
  name: string
  folder: string | null
  /** locked = another member changed the password; ask for the new one. */
  state: GroupState
  sync?: SyncStatus
  /** Names of members currently announcing the group on the LAN. */
  members: string[]
}

/** Group announced by other devices that this device has not joined. */
export interface DiscoveredGroup {
  id: string
  name: string
  members: string[]
}

export interface GroupsSnapshot {
  serverRunning: boolean
  serverError?: string
  deviceName: string
  groups: GroupView[]
  discovered: DiscoveredGroup[]
}

export interface GroupCreateRequest {
  name: string
  password: string
  folder: string
}

export interface GroupJoinRequest {
  id: string
  password: string
  folder: string
}

/** Any member may rename, change the password or move its own folder. */
export interface GroupUpdateRequest {
  id: string
  name?: string
  password?: string
  folder?: string
}

export interface GroupLeaveRequest {
  id: string
  /** true = delete the group for every member (their files stay on disk). */
  forEveryone: boolean
}

export interface GroupOpResult {
  ok: boolean
  error?: string
  group?: GroupView
}

/** Open a synced file with the OS default app. */
export interface FileOpenRequest {
  groupId: string
  path: string
}

/** Per-device edit counters for one file; compared to detect newer vs concurrent edits. */
export type VersionVector = Record<string, number>

/** One file as seen by the sync index (paths are share-relative, `/`-separated). */
export interface SyncEntry {
  path: string
  /** sha256 hex; empty for deletions. */
  hash: string
  size: number
  /** Tombstone: the file was deleted and the deletion must propagate. */
  deleted: boolean
  version: VersionVector
  /** Device that produced this version (used to break ties in conflicts). */
  modifiedBy: string
  modifiedAt: number
}

/** GET /g/:groupId/index payload. */
export interface SyncIndexResponse {
  groupId: string
  deviceId: string
  deviceName: string
  entries: SyncEntry[]
}

export type SyncState = 'idle' | 'scanning' | 'syncing' | 'error'

export interface SyncStatus {
  state: SyncState
  /** Members of the group reached on the last round. */
  peers: number
  files: number
  /** Conflict copies created since sync started. */
  conflicts: number
  lastSyncAt: number | null
  error?: string
  /** Files to download from the peer being merged (only while syncing). */
  pending?: number
  /** Downloads finished (or given up) out of pending. */
  done?: number
}

export interface ShareListLocalRequest {
  /** Group whose local folder is listed. */
  groupId?: string
  path?: string
}

export interface ShareListLocalResult {
  ok: boolean
  entries?: DirEntry[]
  folder?: string
  error?: string
}

export type NetworkCheckSeverity = 'info' | 'warn' | 'error'

export interface NetworkCheck {
  id: string
  ok: boolean
  severity: NetworkCheckSeverity
  messageEs: string
  hintEs?: string
}

export interface NetworkDiagnoseResult {
  checks: NetworkCheck[]
  summaryEs: string
}

export interface FsOpResult {
  ok: boolean
  error?: string
}

export interface FsMkdirRequest {
  groupId?: string
  /** Relative parent folder inside the share (empty = root). */
  path?: string
  name: string
}

export interface FsRenameRequest {
  groupId?: string
  /** Relative path of the file or folder to rename. */
  path: string
  newName: string
}

/** Move a share entry into another relative folder (keeps basename). */
export interface FsMoveRequest {
  groupId?: string
  /** Relative path of the file or folder to move. */
  path: string
  /** Relative destination parent folder (empty = share root). */
  destPath?: string
}

export interface FsRemoveRequest {
  groupId?: string
  /** Relative path of the file or folder to delete. */
  path: string
}

/** Drop-import absolute OS paths into a group folder (files and folders). */
export interface ImportLocalRequest {
  groupId?: string
  sources: string[]
  /** Relative folder inside the share (current explorer path). */
  destPath?: string
}

export interface ImportLocalResult {
  ok: boolean
  imported?: number
  /** Final names written in the destination folder, in source order. */
  names?: string[]
  /** Sources saved under another name because the original already existed. */
  renamed?: { from: string; to: string }[]
  error?: string
}

/** Byte progress for local import / export (main → renderer). */
export interface ImportProgress {
  copiedBytes: number
  totalBytes: number
  done?: boolean
}

/** Same shape as ImportProgress; used by files:exportProgress. */
export type ExportProgress = ImportProgress

/** Discovery announcement payload (UDP). */
export interface PeerAnnouncement {
  name: string
  /** LAN IPv4; omit when none is usable (never 127.0.0.1 / 0.0.0.0). */
  host?: string
  /** All usable LAN IPv4s on the announcer. */
  hosts?: string[]
  port: number
  tokenRequired: boolean
  groups?: AnnouncedGroup[]
}

export const DEFAULT_SHARE_PORT = 8765
export const DISCOVERY_PORT = 8766
export const DISCOVERY_MAGIC = 'antishare-v1'
/**
 * Drop UDP-discovered peers if no announce arrives within this window. Announces go out
 * every ~2s, so this tolerates 4 lost rounds while still hiding a peer that left within
 * ~10s instead of keeping a phantom entry the UI cannot connect to.
 */
export const PEER_STALE_MS = 10_000

/** One group entry to copy into a user-chosen OS folder (Guardar como…). */
export interface ExportItemSpec {
  path: string
  isDir: boolean
}

export interface ExportItemsRequest {
  groupId?: string
  /** Absolute destination directory chosen via native folder dialog. */
  destDir: string
  items: ExportItemSpec[]
}

export interface ExportItemsResult {
  ok: boolean
  exported: number
  destPaths?: string[]
  error?: string
}

export interface AntishareApi {
  /** Host platform ('darwin' | 'win32' | 'linux' | 'unknown'), for window-chrome styling only. */
  platform: string
  /** Absolute OS path of a dropped File ('' when it has none, e.g. browser-generated data). */
  getPathForFile: (file: File) => string
  selectFolder: () => Promise<string | null>
  /** Files (and folders on macOS) picked to import; [] when canceled. */
  selectFiles: () => Promise<string[]>
  listLocal: (req?: ShareListLocalRequest) => Promise<ShareListLocalResult>
  diagnoseNetwork: () => Promise<NetworkDiagnoseResult>
  listGroups: () => Promise<GroupsSnapshot>
  createGroup: (req: GroupCreateRequest) => Promise<GroupOpResult>
  joinGroup: (req: GroupJoinRequest) => Promise<GroupOpResult>
  updateGroup: (req: GroupUpdateRequest) => Promise<GroupOpResult>
  leaveGroup: (req: GroupLeaveRequest) => Promise<GroupOpResult>
  /** Subscribe to byte progress while importLocal runs. Returns unsubscribe. */
  onImportProgress: (cb: (p: ImportProgress) => void) => () => void
  /** Subscribe to byte progress while exportItems runs. Returns unsubscribe. */
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void
  /** Copy dropped OS files/folders into a group folder. */
  importLocal: (req: ImportLocalRequest) => Promise<ImportLocalResult>
  /** Copy group item(s) into a user-chosen absolute folder. */
  exportItems: (req: ExportItemsRequest) => Promise<ExportItemsResult>
  mkdirLocal: (req: FsMkdirRequest) => Promise<FsOpResult>
  renameLocal: (req: FsRenameRequest) => Promise<FsOpResult>
  moveLocal: (req: FsMoveRequest) => Promise<FsOpResult>
  removeLocal: (req: FsRemoveRequest) => Promise<FsOpResult>
  openFile: (req: FileOpenRequest) => Promise<FsOpResult>
  /** Show a group entry selected in Finder/Explorer. */
  revealFile: (req: FileOpenRequest) => Promise<FsOpResult>
  showItemInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
}
