import { nativeImage, type IpcMainInvokeEvent, type NativeImage } from 'electron'
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
import { basename, join } from 'path'
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

/** Payload for webContents.startDrag: Windows also needs `files` for folders and files. */
export function startDragPayload(filePath: string): { file: string; files?: string[] } {
  if (process.platform === 'win32') return { file: filePath, files: [filePath] }
  return { file: filePath }
}

function beginDrag(event: IpcMainInvokeEvent, filePath: string): StartDragResult {
  const icon = dragIcon()
  if (icon.isEmpty()) {
    return {
      ok: false,
      error: 'Icono de arrastre inválido (requerido en Windows).'
    }
  }
  try {
    event.sender.startDrag({
      ...startDragPayload(filePath),
      icon
    })
    return { ok: true }
  } catch (e) {
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

function uniqueDragDest(name: string): string {
  mkdirSync(DRAG_DIR, { recursive: true })
  let candidate = join(DRAG_DIR, name)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(DRAG_DIR, `${name} (${n})`)
    n++
  }
  return candidate
}

async function downloadRemoteFileToDragDir(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<PrepareDragResult> {
  const safeName = safeDragName(req.path, 'download.bin')
  const destPath = uniqueDragDest(`${Date.now()}-${safeName}`)

  const dl = await remoteDownload({
    baseUrl: req.baseUrl,
    path: req.path,
    destPath,
    token: req.token
  })
  if (!dl.ok || !dl.destPath) {
    return { ok: false, error: dl.error || 'No se pudo descargar el archivo remoto.' }
  }
  try {
    if (!statSync(dl.destPath).isFile()) {
      return { ok: false, error: 'La descarga no produjo un archivo.' }
    }
  } catch {
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

/** Materialize a remote directory under DRAG_DIR, keeping the root folder name. */
export async function materializeRemoteFolder(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<PrepareDragResult> {
  const rootName = safeDragName(req.path, 'folder')
  const destRoot = uniqueDragDest(rootName)
  mkdirSync(destRoot, { recursive: true })
  try {
    await downloadRemoteTree(req.baseUrl, req.path, destRoot, req.token)
  } catch (e) {
    try {
      rmSync(destRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
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
 * Prepare a file or folder for OS drag (pointerdown / before dragstart).
 * Remote items land in DRAG_DIR; local items resolve under the share root without copying.
 * Frontend should call startDragLocal(filePath) from dragstart with the returned path.
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

/** Validate an absolute file or folder path before startDrag. */
export function resolveDragTarget(filePath: string): PrepareDragResult {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'Ruta inválida.' }
  }
  try {
    if (!existsSync(filePath)) {
      return { ok: false, error: 'La ruta no existe.' }
    }
    const st = statSync(filePath)
    if (!st.isFile() && !st.isDirectory()) {
      return { ok: false, error: 'La ruta no es un archivo ni una carpeta.' }
    }
    return { ok: true, filePath }
  } catch {
    return { ok: false, error: 'No se pudo leer la ruta para arrastrar.' }
  }
}

/** startDrag an absolute file or folder path already on disk (prepared or local). */
export function handleStartDragLocal(
  event: IpcMainInvokeEvent,
  filePath: string
): StartDragResult {
  const resolved = resolveDragTarget(filePath)
  if (!resolved.ok || !resolved.filePath) {
    return { ok: false, error: resolved.error }
  }
  return beginDrag(event, resolved.filePath)
}

/** Combined helper: prepare + startDrag (OK on macOS; prefer prepare+startDragLocal on Windows). */
export async function handleStartDrag(
  event: IpcMainInvokeEvent,
  req: StartDragRequest,
  localRoot: string | null
): Promise<StartDragResult> {
  const prepared = await handlePrepareDrag(req, localRoot)
  if (!prepared.ok || !prepared.filePath) {
    return { ok: false, error: prepared.error }
  }
  return beginDrag(event, prepared.filePath)
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
