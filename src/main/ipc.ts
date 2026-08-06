import { dialog, ipcMain, BrowserWindow, shell } from 'electron'
import { existsSync, statSync } from 'fs'
import { hostname } from 'os'
import {
  DEFAULT_SHARE_PORT,
  type DirEntry,
  type Peer,
  type PeerAddManualRequest,
  type PeerRemoveManualRequest,
  type ShareSettings,
  type ShareStartRequest,
  type ShareStartResult,
  type ShareStatus,
  type ShareStopResult,
  type ShareListLocalRequest,
  type ShareListLocalResult,
  type RemoteListRequest,
  type RemoteDownloadRequest,
  type RemoteUploadRequest,
  type ImportLocalRequest,
  type RemoteImportRequest,
  type ExportItemsRequest,
  type ExportItemsResult,
  type PrepareDragRequest,
  type PrepareDragResult,
  type FsMkdirRequest,
  type FsRenameRequest,
  type FsMoveRequest,
  type FsRemoveRequest,
  type RemoteFsMkdirRequest,
  type RemoteFsRenameRequest,
  type RemoteFsMoveRequest,
  type RemoteFsRemoveRequest
} from '../shared/types'
import { listShareFolder, startShareServer, type ShareServerHandle } from './shareServer'
import { PeerDiscovery } from './discovery'
import {
  remoteDownload,
  remoteList,
  remoteMkdir,
  remoteMove,
  remoteRemove,
  remoteRename,
  remoteUpload
} from './remote'
import { mkdirLocal, moveLocal, removeLocal, renameLocal } from './fsOps'
import { importLocalPaths, importRemotePaths } from './importFiles'
import { exportItemsToFolder } from './exportItems'
import { loadSettings, saveSettings } from './settings'
import { runNetworkDiagnose } from './diagnose'
import { handlePrepareDrag, ensureDragIconFile } from './drag'
import { buildShareUrls, uniqueHosts } from './net'

function liveShareUrls(port: number = DEFAULT_SHARE_PORT): string[] {
  return buildShareUrls(port).all
}

let share: ShareServerHandle | null = null
const discovery = new PeerDiscovery()

function broadcastPeers(peers: Peer[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('peers:onUpdate', peers)
  }
}

function bindErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (
    msg.includes('EADDRINUSE') ||
    msg.toLowerCase().includes('ya está en uso') ||
    (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
  ) {
    return `El puerto ${DEFAULT_SHARE_PORT} ya está en uso. Cierra la otra instancia de AntiShare (u otra app) que lo esté usando e intenta de nuevo.`
  }
  return msg
}

async function startShareInternal(req: ShareStartRequest): Promise<ShareStartResult> {
  try {
    if (share) {
      await share.stop()
      share = null
    }
    // Fixed share port — ignore req.port
    const port = DEFAULT_SHARE_PORT
    const handle = await startShareServer({
      folder: req.folder,
      port,
      token: req.token
    })
    share = handle
    // Announce only while this exact server is the live one and still bound.
    discovery.setAnnounce({
      name: hostname(),
      port: handle.port,
      tokenRequired: handle.tokenRequired,
      isServing: () => share === handle && handle.address !== null
    })
    return { ok: true, urls: liveShareUrls(handle.port), port: handle.port }
  } catch (e) {
    return {
      ok: false,
      urls: [],
      port: DEFAULT_SHARE_PORT,
      error: bindErrorMessage(e)
    }
  }
}

function resolveLocalRoot(): string | null {
  if (share?.folder) return share.folder
  const settings = loadSettings()
  if (settings.folder && existsSync(settings.folder)) {
    try {
      if (statSync(settings.folder).isDirectory()) return settings.folder
    } catch {
      return null
    }
  }
  return null
}

function listLocal(pathParam?: string): ShareListLocalResult {
  const root = resolveLocalRoot()
  if (!root) {
    return { ok: false, error: 'No hay carpeta compartida configurada.' }
  }
  try {
    const entries: DirEntry[] = listShareFolder(root, pathParam || '')
    return { ok: true, entries, folder: root }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/** Restore share from disk settings when autoStart && folder exists. */
export async function restoreAutoStart(): Promise<void> {
  const settings = loadSettings()
  if (!settings.autoStart || !settings.folder) return
  if (!existsSync(settings.folder)) {
    console.warn('[settings] autoStart folder missing, leaving share stopped:', settings.folder)
    return
  }
  try {
    if (!statSync(settings.folder).isDirectory()) return
  } catch {
    return
  }
  const result = await startShareInternal({
    folder: settings.folder,
    token: settings.token
  })
  if (!result.ok) {
    console.error('[settings] autoStart failed:', result.error)
  }
}

export function registerIpc(): void {
  discovery.onUpdate(broadcastPeers)
  discovery.startListening()
  ensureDragIconFile()

  ipcMain.handle('settings:get', async (): Promise<ShareSettings> => loadSettings())

  ipcMain.handle(
    'settings:set',
    async (_e, partial: Partial<ShareSettings>): Promise<ShareSettings> => saveSettings(partial)
  )

  ipcMain.handle('share:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('share:start', async (_e, req: ShareStartRequest): Promise<ShareStartResult> => {
    const result = await startShareInternal(req)
    if (result.ok) {
      saveSettings({
        folder: req.folder,
        token: req.token && req.token.length > 0 ? req.token : '',
        autoStart: true
      })
    }
    return result
  })

  ipcMain.handle('share:stop', async (): Promise<ShareStopResult> => {
    try {
      if (share) {
        await share.stop()
        share = null
      }
      discovery.clearAnnounce()
      saveSettings({ autoStart: false })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('share:status', async (): Promise<ShareStatus> => {
    // A handle whose socket is no longer bound is not running, whatever we last stored.
    if (!share || share.address === null) {
      return {
        running: false,
        folder: null,
        port: null,
        urls: [],
        tokenRequired: false
      }
    }
    return {
      running: true,
      folder: share.folder,
      port: share.port,
      urls: liveShareUrls(share.port),
      tokenRequired: share.tokenRequired
    }
  })

  ipcMain.handle(
    'share:listLocal',
    async (_e, req?: ShareListLocalRequest): Promise<ShareListLocalResult> =>
      listLocal(req?.path)
  )

  ipcMain.handle('network:diagnose', async () =>
    runNetworkDiagnose({ share, discovery })
  )

  ipcMain.handle('peers:list', async (): Promise<Peer[]> => discovery.list())

  ipcMain.handle('peers:addManual', async (_e, req: PeerAddManualRequest) =>
    discovery.addManual(req)
  )
  ipcMain.handle('peers:removeManual', async (_e, req: PeerRemoveManualRequest) =>
    discovery.removeManual(req)
  )

  ipcMain.handle('remote:list', async (_e, req: RemoteListRequest) => {
    const base = (req.baseUrl || '').replace(/\/+$/, '')
    const known = discovery.list().find((p) => {
      if (p.baseUrl.replace(/\/+$/, '') === base) return true
      return [p.host, ...(p.hosts ?? [])].some((h) => base === `http://${h}:${p.port}`)
    })
    if (!known) return remoteList(req)

    // discovery already ranked hosts with the verified UDP source first; re-ranking here
    // (without that source) could promote a look-alike same-subnet IP that never replies.
    const ranked = uniqueHosts([known.host, ...(known.hosts ?? [])])
    const urls = ranked.map((h) => `http://${h}:${known.port}`)
    const primaryUrl = urls[0] || base
    const altBaseUrls = [...urls.slice(1), ...(req.altBaseUrls ?? [])].filter(
      (u, i, arr) => u && u !== primaryUrl && arr.indexOf(u) === i
    )
    return remoteList({
      ...req,
      baseUrl: primaryUrl,
      altBaseUrls: altBaseUrls.length ? altBaseUrls : undefined
    })
  })
  ipcMain.handle('remote:download', async (_e, req: RemoteDownloadRequest) => remoteDownload(req))
  ipcMain.handle('remote:upload', async (_e, req: RemoteUploadRequest) => remoteUpload(req))
  ipcMain.handle('files:importLocal', async (_e, req: ImportLocalRequest) =>
    importLocalPaths(resolveLocalRoot(), req)
  )
  ipcMain.handle('files:importRemote', async (_e, req: RemoteImportRequest) =>
    importRemotePaths(req)
  )
  ipcMain.handle(
    'files:exportItems',
    async (_e, req: ExportItemsRequest): Promise<ExportItemsResult> =>
      exportItemsToFolder(resolveLocalRoot(), req)
  )
  ipcMain.handle('files:mkdir', async (_e, req: FsMkdirRequest) =>
    mkdirLocal(resolveLocalRoot(), req)
  )
  ipcMain.handle('files:rename', async (_e, req: FsRenameRequest) =>
    renameLocal(resolveLocalRoot(), req)
  )
  ipcMain.handle('files:move', async (_e, req: FsMoveRequest) =>
    moveLocal(resolveLocalRoot(), req)
  )
  ipcMain.handle('files:remove', async (_e, req: FsRemoveRequest) =>
    removeLocal(resolveLocalRoot(), req)
  )
  ipcMain.handle('remote:mkdir', async (_e, req: RemoteFsMkdirRequest) => remoteMkdir(req))
  ipcMain.handle('remote:rename', async (_e, req: RemoteFsRenameRequest) => remoteRename(req))
  ipcMain.handle('remote:move', async (_e, req: RemoteFsMoveRequest) => remoteMove(req))
  ipcMain.handle('remote:remove', async (_e, req: RemoteFsRemoveRequest) => remoteRemove(req))

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

  ipcMain.handle(
    'files:prepareDrag',
    async (_e, req: PrepareDragRequest): Promise<PrepareDragResult> =>
      handlePrepareDrag(req, resolveLocalRoot())
  )
}

export async function shutdownShare(): Promise<void> {
  discovery.stopListening()
  if (share) {
    await share.stop()
    share = null
  }
}
