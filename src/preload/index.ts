import { contextBridge, ipcRenderer } from 'electron'
import type {
  AntishareApi,
  FsMkdirRequest,
  FsMoveRequest,
  FsRemoveRequest,
  FsRenameRequest,
  ImportLocalRequest,
  ImportProgress,
  ExportProgress,
  Peer,
  PeerAddManualRequest,
  PeerRemoveManualRequest,
  PrepareDragRequest,
  ExportItemsRequest,
  RemoteDownloadRequest,
  RemoteFsMkdirRequest,
  RemoteFsMoveRequest,
  RemoteFsRemoveRequest,
  RemoteFsRenameRequest,
  RemoteImportRequest,
  RemoteListRequest,
  RemoteUploadRequest,
  ShareListLocalRequest,
  ShareSettings,
  ShareStartRequest
} from '../shared/types'

const api: AntishareApi = {
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke('share:selectFolder'),
  startShare: (req: ShareStartRequest) => ipcRenderer.invoke('share:start', req),
  stopShare: () => ipcRenderer.invoke('share:stop'),
  shareStatus: () => ipcRenderer.invoke('share:status'),
  listLocal: (req?: ShareListLocalRequest) => ipcRenderer.invoke('share:listLocal', req),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<ShareSettings>) => ipcRenderer.invoke('settings:set', partial),
  diagnoseNetwork: () => ipcRenderer.invoke('network:diagnose'),
  prepareDrag: (req: PrepareDragRequest) => ipcRenderer.invoke('files:prepareDrag', req),
  listPeers: () => ipcRenderer.invoke('peers:list'),
  onPeersUpdate: (cb: (peers: Peer[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, peers: Peer[]): void => cb(peers)
    ipcRenderer.on('peers:onUpdate', handler)
    return () => ipcRenderer.removeListener('peers:onUpdate', handler)
  },
  onImportProgress: (cb: (p: ImportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: ImportProgress): void => cb(p)
    ipcRenderer.on('files:importProgress', handler)
    return () => ipcRenderer.removeListener('files:importProgress', handler)
  },
  onExportProgress: (cb: (p: ExportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, p: ExportProgress): void => cb(p)
    ipcRenderer.on('files:exportProgress', handler)
    return () => ipcRenderer.removeListener('files:exportProgress', handler)
  },
  addManualPeer: (req: PeerAddManualRequest) => ipcRenderer.invoke('peers:addManual', req),
  removeManualPeer: (req: PeerRemoveManualRequest) =>
    ipcRenderer.invoke('peers:removeManual', req),
  remoteList: (req: RemoteListRequest) => ipcRenderer.invoke('remote:list', req),
  remoteDownload: (req: RemoteDownloadRequest) => ipcRenderer.invoke('remote:download', req),
  remoteUpload: (req: RemoteUploadRequest) => ipcRenderer.invoke('remote:upload', req),
  importLocal: (req: ImportLocalRequest) => ipcRenderer.invoke('files:importLocal', req),
  importRemote: (req: RemoteImportRequest) => ipcRenderer.invoke('files:importRemote', req),
  exportItems: (req: ExportItemsRequest) => ipcRenderer.invoke('files:exportItems', req),
  mkdirLocal: (req: FsMkdirRequest) => ipcRenderer.invoke('files:mkdir', req),
  renameLocal: (req: FsRenameRequest) => ipcRenderer.invoke('files:rename', req),
  moveLocal: (req: FsMoveRequest) => ipcRenderer.invoke('files:move', req),
  removeLocal: (req: FsRemoveRequest) => ipcRenderer.invoke('files:remove', req),
  remoteMkdir: (req: RemoteFsMkdirRequest) => ipcRenderer.invoke('remote:mkdir', req),
  remoteRename: (req: RemoteFsRenameRequest) => ipcRenderer.invoke('remote:rename', req),
  remoteMove: (req: RemoteFsMoveRequest) => ipcRenderer.invoke('remote:move', req),
  remoteRemove: (req: RemoteFsRemoveRequest) => ipcRenderer.invoke('remote:remove', req),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath)
}

contextBridge.exposeInMainWorld('antishare', api)
