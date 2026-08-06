import {
  BrowserWindow,
  nativeImage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type NativeImage
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, isAbsolute, join } from 'path'
import { tmpdir } from 'os'
import type {
  PrepareDragRequest,
  PrepareDragResult,
  StartDragRequest,
  StartDragResult
} from '../shared/types'
import { resolveSafe } from './shareServer'
import { remoteDownload, remoteList } from './remote'

export const DRAG_DIR = join(tmpdir(), 'antishare-drag')
const MAX_TEMP_AGE_MS = 30 * 60 * 1000

/** Embedded 64×64 PNG — Windows startDrag requires a non-empty NativeImage. */
const DRAG_ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVklEQVR42u3PsQkAMAgAMG/rb/3XwaFjXxCchEAeSGS91UJAQEBAYBQ4t1YTEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEGj5/abztHp/zLQAAAAASUVORK5CYII=',
  'base64'
)

let cachedIcon: NativeImage | null = null

function dragIcon(): NativeImage {
  if (cachedIcon && !cachedIcon.isEmpty()) return cachedIcon

  // Prefer file on disk (dev resources/ or DRAG_DIR cache)
  const candidates = [
    join(__dirname, '../../resources/drag-icon.png'),
    join(process.resourcesPath || '', 'drag-icon.png'),
    join(DRAG_DIR, 'drag-icon.png')
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) {
          cachedIcon = img
          return img
        }
      }
    } catch {
      /* try next */
    }
  }

  cachedIcon = nativeImage.createFromBuffer(DRAG_ICON_PNG)
  if (cachedIcon.isEmpty()) {
    try {
      mkdirSync(DRAG_DIR, { recursive: true })
      const iconPath = join(DRAG_DIR, 'drag-icon.png')
      writeFileSync(iconPath, DRAG_ICON_PNG)
      cachedIcon = nativeImage.createFromPath(iconPath)
    } catch {
      /* last resort below */
    }
  }

  // Windows rejects empty icons — force a buffer-backed image again
  if (!cachedIcon || cachedIcon.isEmpty()) {
    cachedIcon = nativeImage.createFromBuffer(Buffer.from(DRAG_ICON_PNG))
  }
  return cachedIcon
}

function cleanOldTemps(): void {
  try {
    if (!existsSync(DRAG_DIR)) return
    const now = Date.now()
    for (const name of readdirSync(DRAG_DIR)) {
      if (name === 'drag-icon.png') continue
      const full = join(DRAG_DIR, name)
      try {
        const st = statSync(full)
        if (now - st.mtimeMs > MAX_TEMP_AGE_MS) {
          if (st.isDirectory()) rmSync(full, { recursive: true, force: true })
          else unlinkSync(full)
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function safeDragName(raw: string, fallback: string): string {
  const safe = basename(String(raw || '').replace(/\\/g, '/')).replace(/[/\\]/g, '_').trim()
  return safe || fallback
}

export type DragItemKind = 'file' | 'directory'

/** Payload for webContents.startDrag. macOS + Windows need `files` so the OS keeps dir vs file. */
export function startDragPayload(
  filePath: string,
  _kind: DragItemKind
): { file: string; files: string[] } {
  return { file: filePath, files: [filePath] }
}

export interface ResolvedDragTarget {
  ok: boolean
  filePath?: string
  kind?: DragItemKind
  error?: string
}

function restoreFocusAfterDrag(sender: IpcMainEvent['sender'] | IpcMainInvokeEvent['sender']): void {
  try {
    if (sender.isDestroyed()) return
    const win = BrowserWindow.fromWebContents(sender)
    win?.focus()
    sender.focus()
  } catch {
    /* ignore — focus restore is best-effort after native drag */
  }
}

function beginDrag(
  event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender'>,
  filePath: string,
  kind: DragItemKind
): StartDragResult {
  const icon = dragIcon()
  if (icon.isEmpty()) {
    return {
      ok: false,
      error: 'Icono de arrastre inválido (requerido en Windows).'
    }
  }
  try {
    event.sender.startDrag({
      ...startDragPayload(filePath, kind),
      icon
    })
    // startDrag blocks until the OS drag session ends (drop or cancel).
    // Reclaim real OS/window input focus so clicks work after internal drops.
    restoreFocusAfterDrag(event.sender)
    return { ok: true }
  } catch (e) {
    restoreFocusAfterDrag(event.sender)
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'No se pudo iniciar el arrastre'
    }
  }
}

/** Resolve a local share file or folder to its absolute path (no copy). */
export function resolveLocalDragPath(localRoot: string | null, relPath: string): PrepareDragResult {
  if (!localRoot) {
    return { ok: false, error: 'No hay carpeta compartida configurada.' }
  }
  if (!relPath.trim()) {
    return { ok: false, error: 'Ruta inválida.' }
  }
  try {
    const abs = resolveSafe(localRoot, relPath)
    const st = statSync(abs)
    if (!st.isFile() && !st.isDirectory()) {
      return { ok: false, error: 'La ruta no es un archivo ni una carpeta.' }
    }
    return { ok: true, filePath: abs }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('traversal')) {
      return { ok: false, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    return { ok: false, error: msg }
  }
}

/** Hidden unique parent so the leaf keeps the original name (no `Name (1)`). */
function stagingParent(baseUrl: string, remotePath: string, kind: 'file' | 'dir'): string {
  const id = createHash('sha1')
    .update(`${baseUrl}\0${remotePath}\0${kind}`)
    .digest('hex')
    .slice(0, 20)
  return join(DRAG_DIR, id)
}

function stagingLeafPath(baseUrl: string, remotePath: string, kind: 'file' | 'dir'): string {
  const name = safeDragName(remotePath, kind === 'dir' ? 'folder' : 'download.bin')
  return join(stagingParent(baseUrl, remotePath, kind), name)
}

function resetStagingParent(parent: string): void {
  mkdirSync(DRAG_DIR, { recursive: true })
  rmSync(parent, { recursive: true, force: true })
  mkdirSync(parent, { recursive: true })
}

async function downloadRemoteFileToDragDir(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<PrepareDragResult> {
  const destPath = stagingLeafPath(req.baseUrl, req.path, 'file')
  const parent = dirname(destPath)
  try {
    if (existsSync(destPath) && statSync(destPath).isFile()) {
      return { ok: true, filePath: destPath }
    }
  } catch {
    /* rematerialize */
  }

  resetStagingParent(parent)
  const dl = await remoteDownload({
    baseUrl: req.baseUrl,
    path: req.path,
    destPath,
    token: req.token
  })
  if (!dl.ok || !dl.destPath) {
    rmSync(parent, { recursive: true, force: true })
    return { ok: false, error: dl.error || 'No se pudo descargar el archivo remoto.' }
  }
  try {
    if (!statSync(dl.destPath).isFile()) {
      rmSync(parent, { recursive: true, force: true })
      return { ok: false, error: 'La descarga no produjo un archivo.' }
    }
  } catch {
    rmSync(parent, { recursive: true, force: true })
    return { ok: false, error: 'Archivo temporal no encontrado tras la descarga.' }
  }
  return { ok: true, filePath: dl.destPath }
}

async function downloadRemoteTree(
  baseUrl: string,
  remotePath: string,
  destDir: string,
  token?: string
): Promise<void> {
  const listed = await remoteList({ baseUrl, path: remotePath, token })
  if (!listed.ok) {
    throw new Error(listed.error || `No se pudo listar ${remotePath || '/'}.`)
  }
  mkdirSync(destDir, { recursive: true })
  for (const entry of listed.entries ?? []) {
    const childName = safeDragName(entry.name, entry.isDir ? 'folder' : 'file')
    const childDest = join(destDir, childName)
    if (entry.isDir) {
      await downloadRemoteTree(baseUrl, entry.path, childDest, token)
      continue
    }
    const dl = await remoteDownload({
      baseUrl,
      path: entry.path,
      destPath: childDest,
      token
    })
    if (!dl.ok) {
      const err = dl.error || ''
      if (err.toLowerCase().includes('traversal') || err.includes('403')) continue
      throw new Error(err || `No se pudo descargar ${entry.path}.`)
    }
  }
}

/** Materialize a remote directory as DRAG_DIR/<id>/OriginalName (reused or replaced). */
export async function materializeRemoteFolder(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<PrepareDragResult> {
  const destRoot = stagingLeafPath(req.baseUrl, req.path, 'dir')
  const parent = dirname(destRoot)
  try {
    if (existsSync(destRoot) && statSync(destRoot).isDirectory()) {
      return { ok: true, filePath: destRoot }
    }
  } catch {
    /* rematerialize */
  }

  resetStagingParent(parent)
  mkdirSync(destRoot, { recursive: true })
  try {
    await downloadRemoteTree(req.baseUrl, req.path, destRoot, req.token)
  } catch (e) {
    rmSync(parent, { recursive: true, force: true })
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('traversal')) {
      return { ok: false, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    return { ok: false, error: msg }
  }
  return { ok: true, filePath: destRoot }
}

async function prepareRemoteDrag(req: {
  baseUrl: string
  path: string
  token?: string
  isDir?: boolean
}): Promise<PrepareDragResult> {
  if (!req.baseUrl || !req.path) {
    return { ok: false, error: 'Faltan baseUrl o path del ítem remoto.' }
  }
  if (req.isDir === true) return materializeRemoteFolder(req)
  if (req.isDir === false) return downloadRemoteFileToDragDir(req)

  const listed = await remoteList({
    baseUrl: req.baseUrl,
    path: req.path,
    token: req.token
  })
  if (listed.ok) return materializeRemoteFolder(req)
  return downloadRemoteFileToDragDir(req)
}

/**
 * Resolve a local share path or materialize a remote item under DRAG_DIR.
 * Used by export (Save As) and prepareDrag IPC — not for OS drag-out.
 */
export async function handlePrepareDrag(
  req: PrepareDragRequest,
  localRoot: string | null
): Promise<PrepareDragResult> {
  cleanOldTemps()

  if (req.kind === 'local') {
    return resolveLocalDragPath(localRoot, req.path)
  }

  return prepareRemoteDrag({
    baseUrl: req.baseUrl,
    path: req.path,
    token: req.token,
    isDir: req.isDir
  })
}

/**
 * Stat the path (share-relative is resolved without copying) and require file vs dir when asked.
 */
export function resolveDragTarget(
  filePath: string,
  opts?: { isDir?: boolean },
  localRoot?: string | null
): ResolvedDragTarget {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'Ruta inválida.' }
  }
  let abs = filePath
  if (!isAbsolute(abs)) {
    const local = resolveLocalDragPath(localRoot ?? null, abs)
    if (!local.ok || !local.filePath) return { ok: false, error: local.error }
    abs = local.filePath
  }
  try {
    if (!existsSync(abs)) {
      return { ok: false, error: 'La ruta no existe.' }
    }
    const st = statSync(abs)
    const kind: DragItemKind | undefined = st.isDirectory()
      ? 'directory'
      : st.isFile()
        ? 'file'
        : undefined
    if (!kind) {
      return { ok: false, error: 'La ruta no es un archivo ni una carpeta.' }
    }
    if (opts?.isDir === true && kind !== 'directory') {
      return { ok: false, error: 'Se esperaba una carpeta.' }
    }
    if (opts?.isDir === false && kind !== 'file') {
      return { ok: false, error: 'Se esperaba un archivo.' }
    }
    return { ok: true, filePath: abs, kind }
  } catch {
    return { ok: false, error: 'No se pudo leer la ruta para arrastrar.' }
  }
}

/** startDrag an on-disk file or folder. Must run synchronously inside dragstart (sendSync). */
export function handleStartDragLocal(
  event: IpcMainEvent | IpcMainInvokeEvent,
  filePath: string,
  opts?: { isDir?: boolean },
  localRoot?: string | null
): StartDragResult {
  const resolved = resolveDragTarget(filePath, opts, localRoot)
  if (!resolved.ok || !resolved.filePath || !resolved.kind) {
    return { ok: false, error: resolved.error }
  }
  return beginDrag(event, resolved.filePath, resolved.kind)
}

/** Combined helper: prepare + startDrag (async — not safe during dragstart). */
export async function handleStartDrag(
  event: IpcMainInvokeEvent,
  req: StartDragRequest,
  localRoot: string | null
): Promise<StartDragResult> {
  const prepared = await handlePrepareDrag(req, localRoot)
  if (!prepared.ok || !prepared.filePath) {
    return { ok: false, error: prepared.error }
  }
  return handleStartDragLocal(event, prepared.filePath, { isDir: req.isDir }, localRoot)
}

/** Ensure drag icon exists on disk (optional warm-up). */
export function ensureDragIconFile(): void {
  try {
    mkdirSync(DRAG_DIR, { recursive: true })
    const p = join(DRAG_DIR, 'drag-icon.png')
    if (!existsSync(p)) writeFileSync(p, DRAG_ICON_PNG)
    // Touch cache
    void readFileSync(p)
  } catch {
    /* ignore */
  }
}
