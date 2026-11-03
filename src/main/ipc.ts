import { app, dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { hostname } from 'os'
import {
  DEFAULT_SHARE_PORT,
  type DirEntry,
  type ExportItemsRequest,
  type ExportItemsResult,
  type FileOpenRequest,
  type FsMkdirRequest,
  type FsMoveRequest,
  type FsOpResult,
  type FsRemoveRequest,
  type FsRenameRequest,
  type GroupCreateRequest,
  type GroupJoinRequest,
  type GroupLeaveRequest,
  type GroupsSnapshot,
  type GroupUpdateRequest,
  type ImportLocalRequest,
  type ShareListLocalRequest,
  type ShareListLocalResult
} from '../shared/types'
import { listShareFolder } from './listFolder'
import { startGroupServer, type GroupServerHandle } from './groupServer'
import { GroupManager } from './groupManager'
import { PeerDiscovery } from './discovery'
import { mkdirLocal, moveLocal, removeLocal, renameLocal } from './fsOps'
import { importLocalPaths } from './importFiles'
import { exportItemsToFolder } from './exportItems'
import { loadDeviceId } from './settings'
import { runNetworkDiagnose } from './diagnose'
import { resolveSafe } from './pathSafe'

let server: GroupServerHandle | null = null
let serverError: string | undefined
let groups: GroupManager | null = null
const discovery = new PeerDiscovery()

function manager(): GroupManager {
  if (!groups) {
    groups = new GroupManager({
      dataDir: app.getPath('userData'),
      deviceId: loadDeviceId(),
      deviceName: hostname(),
      listPeers: () => discovery.list()
    })
  }
  return groups
}

const NO_GROUP = 'Ese grupo no tiene una carpeta disponible en este equipo.'

function rootFor(groupId: string | undefined): string | null {
  return manager().rootFor(groupId)
}

function listLocal(req?: ShareListLocalRequest): ShareListLocalResult {
  const root = rootFor(req?.groupId)
  if (!root) return { ok: false, error: NO_GROUP }
  try {
    const entries: DirEntry[] = listShareFolder(root, req?.path || '')
    return { ok: true, entries, folder: root }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function snapshot(): GroupsSnapshot {
  const m = manager()
  return {
    serverRunning: server !== null && server.address !== null,
    ...(serverError ? { serverError } : {}),
    deviceName: hostname(),
    groups: m.groups(),
    discovered: m.discovered()
  }
}

/** Server + announcements run for the whole app life: groups need them to sync. */
export async function startGroups(): Promise<void> {
  const m = manager()
  try {
    const handle = await startGroupServer({ port: DEFAULT_SHARE_PORT, hooks: m.serverHooks() })
    server = handle
    serverError = undefined
    discovery.setAnnounce({
      name: hostname(),
      port: handle.port,
      tokenRequired: false,
      isServing: () => server === handle && handle.address !== null,
      groups: () => m.announced()
    })
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e)
    console.error('[groups] server failed', serverError)
  }
  m.start()
}

/** Progress events for import/export, throttled to ~20/s. */
function progressEmitter(
  sender: Electron.WebContents,
  channel: string
): (copied: number, total: number, done?: boolean) => void {
  let lastEmit = 0
  return (copiedBytes, totalBytes, done) => {
    const now = Date.now()
    if (!done && now - lastEmit < 50 && totalBytes > 0 && copiedBytes < totalBytes) return
    lastEmit = now
    if (!sender.isDestroyed()) {
      sender.send(channel, { copiedBytes, totalBytes, ...(done ? { done: true } : {}) })
    }
  }
}

export function registerIpc(): void {
  discovery.onUpdate((peers) => {
    manager().onPeersChanged()
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('peers:onUpdate', peers)
  })
  discovery.startListening()

  ipcMain.handle('share:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('share:listLocal', async (_e, req?: ShareListLocalRequest) => listLocal(req))

  ipcMain.handle('network:diagnose', async () => runNetworkDiagnose({ server, discovery }))

  ipcMain.handle('groups:list', async (): Promise<GroupsSnapshot> => snapshot())
  ipcMain.handle('groups:create', async (_e, req: GroupCreateRequest) => manager().create(req))
  ipcMain.handle('groups:join', async (_e, req: GroupJoinRequest) => manager().join(req))
  ipcMain.handle('groups:update', async (_e, req: GroupUpdateRequest) => manager().update(req))
  ipcMain.handle('groups:leave', async (_e, req: GroupLeaveRequest) => manager().leave(req))

  ipcMain.handle('files:importLocal', async (event, req: ImportLocalRequest) => {
    const emit = progressEmitter(event.sender, 'files:importProgress')
    let last = { copied: 0, total: 0 }
    try {
      const result = await importLocalPaths(rootFor(req.groupId), req, (copied, total) => {
        last = { copied, total }
        emit(copied, total)
      })
      emit(last.total || last.copied, last.total, true)
      return result
    } catch (err) {
      emit(last.copied, last.total, true)
      throw err
    }
  })

  ipcMain.handle(
    'files:exportItems',
    async (event, req: ExportItemsRequest): Promise<ExportItemsResult> => {
      const emit = progressEmitter(event.sender, 'files:exportProgress')
      let last = { copied: 0, total: 0 }
      try {
        const result = await exportItemsToFolder(rootFor(req.groupId), req, (copied, total) => {
          last = { copied, total }
          emit(copied, total)
        })
        emit(last.total || last.copied, last.total, true)
        return result
      } catch (err) {
        emit(last.copied, last.total, true)
        throw err
      }
    }
  )

  ipcMain.handle('files:mkdir', async (_e, req: FsMkdirRequest) => mkdirLocal(rootFor(req.groupId), req))
  ipcMain.handle('files:rename', async (_e, req: FsRenameRequest) =>
    renameLocal(rootFor(req.groupId), req)
  )
  ipcMain.handle('files:move', async (_e, req: FsMoveRequest) => moveLocal(rootFor(req.groupId), req))
  ipcMain.handle('files:remove', async (_e, req: FsRemoveRequest) =>
    removeLocal(rootFor(req.groupId), req)
  )

  ipcMain.handle('files:open', async (_e, req: FileOpenRequest): Promise<FsOpResult> => {
    const root = rootFor(req?.groupId)
    if (!root) return { ok: false, error: NO_GROUP }
    try {
      const abs = resolveSafe(root, req.path)
      const error = await shell.openPath(abs)
      return error ? { ok: false, error } : { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('shell:showItemInFolder', async (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: 'Ruta inválida.' }
    }
    try {
      shell.showItemInFolder(filePath)
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'No se pudo abrir en el Finder/Explorador.'
      }
    }
  })
}

export async function shutdownGroups(): Promise<void> {
  discovery.stopListening()
  groups?.stop()
  if (server) {
    await server.stop()
    server = null
  }
}
