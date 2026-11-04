import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AntishareApi, ExportProgress, ImportProgress } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: AntishareApi = {
  platform: process.platform,
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  selectFolder: () => ipcRenderer.invoke('share:selectFolder'),
  selectFiles: () => ipcRenderer.invoke('share:selectFiles'),
  listLocal: (req) => ipcRenderer.invoke('share:listLocal', req),
  diagnoseNetwork: () => ipcRenderer.invoke('network:diagnose'),
  listGroups: () => ipcRenderer.invoke('groups:list'),
  createGroup: (req) => ipcRenderer.invoke('groups:create', req),
  joinGroup: (req) => ipcRenderer.invoke('groups:join', req),
  updateGroup: (req) => ipcRenderer.invoke('groups:update', req),
  leaveGroup: (req) => ipcRenderer.invoke('groups:leave', req),
  onImportProgress: (cb) => subscribe<ImportProgress>('files:importProgress', cb),
  onExportProgress: (cb) => subscribe<ExportProgress>('files:exportProgress', cb),
  importLocal: (req) => ipcRenderer.invoke('files:importLocal', req),
  exportItems: (req) => ipcRenderer.invoke('files:exportItems', req),
  mkdirLocal: (req) => ipcRenderer.invoke('files:mkdir', req),
  renameLocal: (req) => ipcRenderer.invoke('files:rename', req),
  moveLocal: (req) => ipcRenderer.invoke('files:move', req),
  removeLocal: (req) => ipcRenderer.invoke('files:remove', req),
  openFile: (req) => ipcRenderer.invoke('files:open', req),
  revealFile: (req) => ipcRenderer.invoke('files:reveal', req),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath)
}

contextBridge.exposeInMainWorld('antishare', api)
