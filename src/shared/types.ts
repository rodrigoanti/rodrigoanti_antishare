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

/** Discovery announcement payload (UDP). */
export interface PeerAnnouncement {
  name: string
  host: string
  port: number
  tokenRequired: boolean
}

export const DEFAULT_SHARE_PORT = 8765
export const DISCOVERY_PORT = 8766
export const DISCOVERY_MAGIC = 'antishare-v1'
export const PEER_STALE_MS = 10_000

/** OS drag-out (Electron startDrag). Files only. */
export interface StartDragLocalRequest {
  kind: 'local'
  path: string
  isDir?: boolean
}

export interface StartDragRemoteRequest {
  kind: 'remote'
  baseUrl: string
  path: string
  token?: string
  isDir?: boolean
}

export type StartDragRequest = StartDragLocalRequest | StartDragRemoteRequest

export type PrepareDragRequest = StartDragRequest

export interface PrepareDragResult {
  ok: boolean
  /** Absolute path ready for startDragLocal / startDrag. */
  filePath?: string
  error?: string
}

export interface StartDragResult {
  ok: boolean
  error?: string
}

export interface AntishareApi {
  selectFolder: () => Promise<string | null>
  startShare: (req: ShareStartRequest) => Promise<ShareStartResult>
  stopShare: () => Promise<ShareStopResult>
  shareStatus: () => Promise<ShareStatus>
  listLocal: (req?: ShareListLocalRequest) => Promise<ShareListLocalResult>
  getSettings: () => Promise<ShareSettings>
  setSettings: (partial: Partial<ShareSettings>) => Promise<ShareSettings>
  diagnoseNetwork: () => Promise<NetworkDiagnoseResult>
  /** Combined prepare+drag (fine on macOS; on Windows prefer prepareDrag + startDragLocal). */
  startDrag: (req: StartDragRequest) => Promise<StartDragResult>
  /** Download/resolve file ahead of dragstart (required for reliable remote drag on Windows). */
  prepareDrag: (req: PrepareDragRequest) => Promise<PrepareDragResult>
  /** Call from dragstart with an absolute path from prepareDrag. */
  startDragLocal: (filePath: string) => Promise<StartDragResult>
  listPeers: () => Promise<Peer[]>
  onPeersUpdate: (cb: (peers: Peer[]) => void) => () => void
  addManualPeer: (req: PeerAddManualRequest) => Promise<PeerAddManualResult>
  removeManualPeer: (req: PeerRemoveManualRequest) => Promise<{ ok: boolean }>
  remoteList: (req: RemoteListRequest) => Promise<RemoteListResult>
  remoteDownload: (req: RemoteDownloadRequest) => Promise<RemoteDownloadResult>
  remoteUpload: (req: RemoteUploadRequest) => Promise<RemoteUploadResult>
  showItemInFolder: (filePath: string) => Promise<{ ok: boolean; error?: string }>
}
