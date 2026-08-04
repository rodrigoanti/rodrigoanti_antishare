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
import { remoteDownload } from './remote'

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

function beginDrag(event: IpcMainInvokeEvent, filePath: string): StartDragResult {
  const icon = dragIcon()
  if (icon.isEmpty()) {
    return {
      ok: false,
      error: 'Icono de arrastre inválido (requerido en Windows).'
    }
  }
  try {
    const opts: {
      file: string
      icon: NativeImage
      files?: string[]
    } = {
      file: filePath,
      icon
    }
    // Electron on Windows: also pass files[] when supported
    if (process.platform === 'win32') {
      opts.files = [filePath]
    }
    event.sender.startDrag(opts)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'No se pudo iniciar el arrastre'
    }
  }
}

/** Resolve local share file to absolute path (no drag). */
function resolveLocalFile(localRoot: string | null, relPath: string): PrepareDragResult {
  if (!localRoot) {
    return { ok: false, error: 'No hay carpeta compartida configurada.' }
  }
  if (!relPath.trim()) {
    return { ok: false, error: 'Ruta de archivo inválida.' }
  }
  try {
    const abs = resolveSafe(localRoot, relPath)
    const st = statSync(abs)
    if (st.isDirectory()) {
      return { ok: false, error: 'Solo se pueden arrastrar archivos (no carpetas).' }
    }
    if (!st.isFile()) {
      return { ok: false, error: 'No es un archivo.' }
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

async function downloadRemoteToDragDir(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<PrepareDragResult> {
  mkdirSync(DRAG_DIR, { recursive: true })
  const safeName = basename(req.path.replace(/\\/g, '/')).replace(/[/\\]/g, '_') || 'download.bin'
  const destPath = join(DRAG_DIR, `${Date.now()}-${safeName}`)

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

/**
 * Prepare a file for OS drag (pointerdown / before dragstart).
 * Remote files are downloaded to DRAG_DIR; local files resolve under share root.
 * Frontend should call startDragLocal(filePath) from dragstart with the returned path.
 */
export async function handlePrepareDrag(
  req: PrepareDragRequest,
  localRoot: string | null
): Promise<PrepareDragResult> {
  cleanOldTemps()
  if (req.isDir) {
    return { ok: false, error: 'Solo se pueden arrastrar archivos (no carpetas).' }
  }

  if (req.kind === 'local') {
    return resolveLocalFile(localRoot, req.path)
  }

  if (!req.baseUrl || !req.path) {
    return { ok: false, error: 'Faltan baseUrl o path del archivo remoto.' }
  }
  return downloadRemoteToDragDir({
    baseUrl: req.baseUrl,
    path: req.path,
    token: req.token
  })
}

/** startDrag an absolute file path already on disk (prepared or local). */
export function handleStartDragLocal(
  event: IpcMainInvokeEvent,
  filePath: string
): StartDragResult {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'Ruta de archivo inválida.' }
  }
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return { ok: false, error: 'El archivo no existe o no es un archivo.' }
    }
  } catch {
    return { ok: false, error: 'No se pudo leer el archivo para arrastrar.' }
  }
  return beginDrag(event, filePath)
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
