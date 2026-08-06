/** Shared contracts for AntiShare (main ↔ preload ↔ renderer). */

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
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
  /** True when added via peers:addManual (not pruned by UDP stale timeout). */
  manual?: boolean
}

export interface PeerAddManualRequest {
  host: string
  port: number
  tokenRequired?: boolean
  /** Optional token used only to probe the peer. */
  token?: string
}

export interface PeerAddManualResult {
  ok: boolean
  peer?: Peer
  error?: string
}

export interface PeerRemoveManualRequest {
  host: string
  port: number
}

export interface ShareUrls {
  localhost: string
  lan: string[]
}

export interface ShareStartRequest {
  folder: string
  /** Ignored — share always binds DEFAULT_SHARE_PORT (8765). */
  port?: number
  token?: string
}

export interface ShareStartResult {
  ok: boolean
  urls: string[]
  port: number
  error?: string
}

export interface ShareStopResult {
  ok: boolean
  error?: string
}

export interface ShareStatus {
  running: boolean
  folder: string | null
  port: number | null
  urls: string[]
  tokenRequired: boolean
}

/** Persisted local share preferences (Electron userData). Port is fixed at 8765. */
export interface ShareSettings {
  folder: string | null
  token?: string
  autoStart: boolean
}

export interface ShareListLocalRequest {
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

export interface RemoteListRequest {
  baseUrl: string
  path?: string
  token?: string
  /** Other LAN base URLs to try after a network failure on baseUrl (not HTTP 4xx). */
  altBaseUrls?: string[]
}

export interface RemoteDownloadRequest {
  baseUrl: string
  path: string
  destPath?: string
  token?: string
}

export interface RemoteUploadRequest {
  baseUrl: string
  path: string
  filePath: string
  token?: string
}

export interface RemoteListResult {
  ok: boolean
  entries?: DirEntry[]
  error?: string
}

export interface RemoteDownloadResult {
  ok: boolean
  destPath?: string
  error?: string
}

export interface RemoteUploadResult {
  ok: boolean
  error?: string
}

export interface FsOpResult {
  ok: boolean
  error?: string
}

export interface FsMkdirRequest {
  /** Relative parent folder inside the share (empty = root). */
  path?: string
  name: string
}

export interface FsRenameRequest {
  /** Relative path of the file or folder to rename. */
  path: string
  newName: string
}

/** Move a share entry into another relative folder (keeps basename). */
export interface FsMoveRequest {
  /** Relative path of the file or folder to move. */
  path: string
  /** Relative destination parent folder (empty = share root). */
  destPath?: string
}

export interface FsRemoveRequest {
  /** Relative path of the file or folder to delete. */
  path: string
}

export interface RemoteFsMkdirRequest extends FsMkdirRequest {
  baseUrl: string
  token?: string
}

export interface RemoteFsRenameRequest extends FsRenameRequest {
  baseUrl: string
  token?: string
}

export interface RemoteFsMoveRequest extends FsMoveRequest {
  baseUrl: string
  token?: string
}

export interface RemoteFsRemoveRequest extends FsRemoveRequest {
  baseUrl: string
  token?: string
}

/** Drop-import absolute OS paths into the local share (files and folders). */
export interface ImportLocalRequest {
  sources: string[]
  /** Relative folder inside the share (current explorer path). */
  destPath?: string
}

export interface ImportLocalResult {
  ok: boolean
  imported?: number
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

/** Drop-import absolute OS paths onto a remote peer share (files and folder trees). */
export interface RemoteImportRequest {
  baseUrl: string
  sources: string[]
  destPath?: string
  token?: string
}

export interface RemoteImportResult {
  ok: boolean
  imported?: number
  error?: string
}

/** Discovery announcement payload (UDP). */
export interface PeerAnnouncement {
  name: string
  /** LAN IPv4; omit when none is usable (never 127.0.0.1 / 0.0.0.0). */
  host?: string
  /** All usable LAN IPv4s on the announcer. */
  hosts?: string[]
  port: number
  tokenRequired: boolean
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

/** OS drag-out (Electron startDrag). Files and folders. */
export interface StartDragLocalRequest {
  kind: 'local'
  path: string
  /** When true, `path` is a directory (also detected from disk if omitted). */
  isDir?: boolean
}

export interface StartDragRemoteRequest {
  kind: 'remote'
  baseUrl: string
  path: string
  token?: string
  /** When true, materialize the remote directory tree before dragging. */
  isDir?: boolean
}

export type StartDragRequest = StartDragLocalRequest | StartDragRemoteRequest

export type PrepareDragRequest = StartDragRequest

export interface PrepareDragResult {
  ok: boolean
  /** Absolute file or folder path under the share or DRAG_DIR staging. */
  filePath?: string
  error?: string
}

export interface StartDragResult {
  ok: boolean
  error?: string
}

/** One share entry to copy into a user-chosen OS folder (Save As / Export). */
export interface ExportItemSpec {
  kind: 'local' | 'remote'
  path: string
  isDir: boolean
  baseUrl?: string
  token?: string
}

export interface ExportItemsRequest {
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
  selectFolder: () => Promise<string | null>
  startShare: (req: ShareStartRequest) => Promise<ShareStartResult>
  stopShare: () => Promise<ShareStopResult>
  shareStatus: () => Promise<ShareStatus>
  listLocal: (req?: ShareListLocalRequest) => Promise<ShareListLocalResult>
  getSettings: () => Promise<ShareSettings>
  setSettings: (partial: Partial<ShareSettings>) => Promise<ShareSettings>
  diagnoseNetwork: () => Promise<NetworkDiagnoseResult>
  /** Resolve a local file/folder or materialize a remote one (used by export / tooling). */
  prepareDrag: (req: PrepareDragRequest) => Promise<PrepareDragResult>
  listPeers: () => Promise<Peer[]>
  onPeersUpdate: (cb: (peers: Peer[]) => void) => () => void
  /** Subscribe to byte progress while importLocal runs. Returns unsubscribe. */
  onImportProgress: (cb: (p: ImportProgress) => void) => () => void
  /** Subscribe to byte progress while exportItems runs. Returns unsubscribe. */
  onExportProgress: (cb: (p: ExportProgress) => void) => () => void
  addManualPeer: (req: PeerAddManualRequest) => Promise<PeerAddManualResult>
  removeManualPeer: (req: PeerRemoveManualRequest) => Promise<{ ok: boolean }>
  remoteList: (req: RemoteListRequest) => Promise<RemoteListResult>
  remoteDownload: (req: RemoteDownloadRequest) => Promise<RemoteDownloadResult>
  remoteUpload: (req: RemoteUploadRequest) => Promise<RemoteUploadResult>
  /** Copy dropped OS files/folders into the local share. */
  importLocal: (req: ImportLocalRequest) => Promise<ImportLocalResult>
  /** Upload dropped OS files/folders (trees) to a remote peer. */
  importRemote: (req: RemoteImportRequest) => Promise<RemoteImportResult>
  /** Copy share item(s) into a user-chosen absolute folder (replaces OS drag-out). */
  exportItems: (req: ExportItemsRequest) => Promise<ExportItemsResult>
  mkdirLocal: (req: FsMkdirRequest) => Promise<FsOpResult>
  renameLocal: (req: FsRenameRequest) => Promise<FsOpResult>
  moveLocal: (req: FsMoveRequest) => Promise<FsOpResult>
  removeLocal: (req: FsRemoveRequest) => Promise<FsOpResult>
  remoteMkdir: (req: RemoteFsMkdirRequest) => Promise<FsOpResult>
  remoteRename: (req: RemoteFsRenameRequest) => Promise<FsOpResult>
  remoteMove: (req: RemoteFsMoveRequest) => Promise<FsOpResult>
  remoteRemove: (req: RemoteFsRemoveRequest) => Promise<FsOpResult>
  showItemInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
}
