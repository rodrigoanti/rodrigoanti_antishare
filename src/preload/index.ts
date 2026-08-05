import { contextBridge, ipcRenderer } from 'electron'
import type {
  AntishareApi,
  ImportLocalRequest,
  Peer,
  PeerAddManualRequest,
  PeerRemoveManualRequest,
  PrepareDragRequest,
  RemoteDownloadRequest,
  RemoteImportRequest,
  RemoteListRequest,
  RemoteUploadRequest,
  ShareListLocalRequest,
  ShareSettings,
  ShareStartRequest,
  StartDragRequest
} from '../shared/types'

const api: AntishareApi = {
  selectFolder: () => ipcRenderer.invoke('share:selectFolder'),
  startShare: (req: ShareStartRequest) => ipcRenderer.invoke('share:start', req),
  stopShare: () => ipcRenderer.invoke('share:stop'),
  shareStatus: () => ipcRenderer.invoke('share:status'),
  listLocal: (req?: ShareListLocalRequest) => ipcRenderer.invoke('share:listLocal', req),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<ShareSettings>) => ipcRenderer.invoke('settings:set', partial),
  diagnoseNetwork: () => ipcRenderer.invoke('network:diagnose'),
  startDrag: (req: StartDragRequest) => ipcRenderer.invoke('files:startDrag', req),
  prepareDrag: (req: PrepareDragRequest) => ipcRenderer.invoke('files:prepareDrag', req),
  startDragLocal: (filePath: string, opts?: { isDir?: boolean }) =>
    ipcRenderer.invoke('files:startDragLocal', filePath, opts),
  listPeers: () => ipcRenderer.invoke('peers:list'),
  onPeersUpdate: (cb: (peers: Peer[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, peers: Peer[]): void => cb(peers)
    ipcRenderer.on('peers:onUpdate', handler)
    return () => ipcRenderer.removeListener('peers:onUpdate', handler)
  },
  addManualPeer: (req: PeerAddManualRequest) => ipcRenderer.invoke('peers:addManual', req),
  removeManualPeer: (req: PeerRemoveManualRequest) =>
    ipcRenderer.invoke('peers:removeManual', req),
  remoteList: (req: RemoteListRequest) => ipcRenderer.invoke('remote:list', req),
  remoteDownload: (req: RemoteDownloadRequest) => ipcRenderer.invoke('remote:download', req),
  remoteUpload: (req: RemoteUploadRequest) => ipcRenderer.invoke('remote:upload', req),
  importLocal: (req: ImportLocalRequest) => ipcRenderer.invoke('files:importLocal', req),
  importRemote: (req: RemoteImportRequest) => ipcRenderer.invoke('files:importRemote', req),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath)
}

contextBridge.exposeInMainWorld('antishare', api)
