/**
 * Import OS-dropped files/folders into the local share or a remote peer.
 * Local copies stay on disk (recursive); remote walks the tree and uploads each file,
 * creating empty directories via /api/upload?path=… (mkdir recursive, no file part).
 *
 * Local tree copy is async (fs.promises + setImmediate yields) so the Electron main
 * process event loop stays responsive during large imports.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'path'
import type {
  ImportLocalRequest,
  ImportLocalResult,
  RemoteImportRequest,
  RemoteImportResult,
  RemoteUploadResult
} from '../shared/types'
import { copyTree } from './fsCopy'
import { peerHttp, remoteUpload } from './remote'
import { resolveSafe } from './shareServer'

function posixJoin(parent: string, name: string): string {
  const p = String(parent || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const n = basename(String(name || '').replace(/\\/g, '/')).replace(/[/\\]/g, '_').trim() || 'item'
  return p ? `${p}/${n}` : n
}

/** True if any path segment is exactly `..` (not a substring like `foo..bar`). */
function hasDotDotSegment(rel: string): boolean {
  return String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .some((seg) => seg === '..')
}

function isInside(parent: string, child: string): boolean {
  const p = normalize(parent)
  const c = normalize(child)
  if (p === c) return true
  const prefix = p.endsWith(sep) ? p : p + sep
  return c.startsWith(prefix)
}

function uniqueNameInDir(dir: string, name: string): string {
  const safe = basename(name.replace(/\\/g, '/')).replace(/[/\\]/g, '_').trim() || 'item'
  let candidate = join(dir, safe)
  if (!existsSync(candidate)) return safe
  const ext = extname(safe)
  const stem = basename(safe, ext) || 'item'
  let n = 1
  while (existsSync(join(dir, `${stem} (${n})${ext}`))) n++
  return `${stem} (${n})${ext}`
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function validateSource(source: string): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, error: 'Ruta de origen inválida.' }
  }
  if (!isAbsolute(source)) {
    return { ok: false, error: 'La ruta de origen debe ser absoluta.' }
  }
  if (!existsSync(source)) {
    return { ok: false, error: `No existe: ${source}` }
  }
  return { ok: true, abs: source }
}

function rejectSelfCopy(
  shareReal: string,
  srcAbs: string,
  destDir: string,
  destAbs: string
): string | null {
  let srcReal = srcAbs
  let destDirReal = destDir
  try {
    if (!lstatSync(srcAbs).isSymbolicLink()) srcReal = realpathSync(srcAbs)
  } catch {
    return 'No se pudo leer el origen.'
  }
  try {
    destDirReal = realpathSync(destDir)
  } catch {
    return 'No se pudo leer el destino.'
  }
  const destLogical = join(destDirReal, basename(destAbs))
  const st = lstatSync(srcAbs)
  if (st.isFile()) {
    if (dirname(srcReal) === destDirReal) {
      return 'Ese archivo ya está en este destino.'
    }
    return null
  }
  if (!st.isDirectory()) return null
  if (isInside(srcReal, destLogical)) {
    return 'No se puede copiar una carpeta dentro de sí misma.'
  }
  if (dirname(srcReal) === destDirReal) {
    return 'Esa carpeta ya está en este destino.'
  }
  if (isInside(srcReal, shareReal)) {
    return 'No se puede importar el share (ni una carpeta que lo contiene) dentro de sí mismo.'
  }
  return null
}

/** Copy absolute OS paths into the local share at destPath (relative). */
export async function importLocalPaths(
  shareRoot: string | null,
  req: ImportLocalRequest
): Promise<ImportLocalResult> {
  if (!shareRoot) {
    return { ok: false, imported: 0, error: 'No hay carpeta compartida configurada.' }
  }
  const sources = Array.isArray(req.sources) ? req.sources : []
  if (sources.length === 0) {
    return { ok: false, imported: 0, error: 'No hay rutas para importar.' }
  }

  let destDir: string
  let shareReal: string
  try {
    destDir = resolveSafe(shareRoot, req.destPath || '.')
    shareReal = realpathSync(shareRoot)
    if (!statSync(destDir).isDirectory()) {
      return { ok: false, imported: 0, error: 'El destino local no es una carpeta.' }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('traversal')) {
      return { ok: false, imported: 0, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    return { ok: false, imported: 0, error: msg }
  }

  let imported = 0
  for (const source of sources) {
    const checked = validateSource(source)
    if (!checked.ok) return { ok: false, imported, error: checked.error }

    const name = uniqueNameInDir(destDir, basename(checked.abs))
    const destAbs = join(destDir, name)
    try {
      resolveSafe(shareRoot, relative(shareReal, destAbs) || name)
    } catch {
      return { ok: false, imported, error: 'Ruta no permitida (path traversal bloqueado).' }
    }

    const blocked = rejectSelfCopy(shareReal, checked.abs, destDir, destAbs)
    if (blocked) return { ok: false, imported, error: blocked }

    try {
      await copyTree(checked.abs, destAbs)
      imported++
      // Yield between top-level sources so concurrent IPC can run.
      await yieldToEventLoop()
    } catch (e) {
      return {
        ok: false,
        imported,
        error: e instanceof Error ? e.message : `No se pudo copiar ${checked.abs}.`
      }
    }
  }
  return { ok: true, imported }
}

/** Copy absolute paths into an arbitrary absolute directory (e.g. user-chosen export folder). */
export async function copyPathsToDirectory(
  sources: string[],
  destDir: string
): Promise<{ ok: boolean; copied: number; destPaths: string[]; error?: string }> {
  if (typeof destDir !== 'string' || !destDir.trim() || !isAbsolute(destDir)) {
    return { ok: false, copied: 0, destPaths: [], error: 'La carpeta destino debe ser una ruta absoluta.' }
  }
  if (!existsSync(destDir)) {
    return { ok: false, copied: 0, destPaths: [], error: 'La carpeta destino no existe.' }
  }
  let destReal: string
  try {
    if (!statSync(destDir).isDirectory()) {
      return { ok: false, copied: 0, destPaths: [], error: 'El destino no es una carpeta.' }
    }
    destReal = realpathSync(destDir)
  } catch (e) {
    return {
      ok: false,
      copied: 0,
      destPaths: [],
      error: e instanceof Error ? e.message : 'No se pudo leer la carpeta destino.'
    }
  }

  const destPaths: string[] = []
  let copied = 0
  for (const source of sources) {
    const checked = validateSource(source)
    if (!checked.ok) return { ok: false, copied, destPaths, error: checked.error }

    const name = uniqueNameInDir(destReal, basename(checked.abs))
    const destAbs = join(destReal, name)

    try {
      await copyTree(checked.abs, destAbs)
      destPaths.push(destAbs)
      copied++
      await yieldToEventLoop()
    } catch (e) {
      return {
        ok: false,
        copied,
        destPaths,
        error: e instanceof Error ? e.message : `No se pudo copiar ${checked.abs}.`
      }
    }
  }
  return { ok: true, copied, destPaths }
}

async function remoteEnsureDir(req: {
  baseUrl: string
  path: string
  token?: string
}): Promise<RemoteUploadResult> {
  const base = req.baseUrl.replace(/\/$/, '')
  const url = `${base}/api/upload?path=${encodeURIComponent(req.path || '')}`
  const boundary = `----AntiShareDir${Date.now()}`
  const body = Buffer.from(`--${boundary}--\r\n`, 'utf8')
  try {
    const res = await peerHttp(url, {
      method: 'POST',
      headers: {
        ...(req.token ? { 'X-Share-Token': req.token } : {}),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body,
      timeoutMs: 15_000
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      return {
        ok: false,
        error: data.error || `No se pudo crear la carpeta (HTTP ${res.status}).`
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function uploadTree(
  baseUrl: string,
  token: string | undefined,
  srcAbs: string,
  destRel: string
): Promise<RemoteUploadResult & { count: number }> {
  const st = lstatSync(srcAbs)
  if (st.isSymbolicLink()) return { ok: true, count: 0 }
  if (st.isFile()) {
    const parent = destRel.includes('/') ? destRel.slice(0, destRel.lastIndexOf('/')) : ''
    const result = await remoteUpload({
      baseUrl,
      path: parent,
      filePath: srcAbs,
      token
    })
    return { ...result, count: result.ok ? 1 : 0 }
  }
  if (!st.isDirectory()) return { ok: true, count: 0 }

  const ensured = await remoteEnsureDir({ baseUrl, path: destRel, token })
  if (!ensured.ok) return { ok: false, count: 0, error: ensured.error }

  let count = 1
  for (const name of readdirSync(srcAbs)) {
    const child = join(srcAbs, name)
    const childRel = posixJoin(destRel, name)
    const childSt = lstatSync(child)
    if (childSt.isSymbolicLink()) continue
    if (childSt.isDirectory()) {
      const nested = await uploadTree(baseUrl, token, child, childRel)
      count += nested.count
      if (!nested.ok) return { ok: false, count, error: nested.error }
      continue
    }
    if (childSt.isFile()) {
      const up = await remoteUpload({
        baseUrl,
        path: destRel,
        filePath: child,
        token
      })
      if (!up.ok) return { ok: false, count, error: up.error }
      count++
    }
  }
  return { ok: true, count }
}

/** Upload absolute OS paths (files or trees) to a remote share folder. */
export async function importRemotePaths(req: RemoteImportRequest): Promise<RemoteImportResult> {
  if (!req.baseUrl) {
    return { ok: false, imported: 0, error: 'Falta la URL del peer.' }
  }
  const sources = Array.isArray(req.sources) ? req.sources : []
  if (sources.length === 0) {
    return { ok: false, imported: 0, error: 'No hay rutas para importar.' }
  }
  const destBase = String(req.destPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')

  let imported = 0
  for (const source of sources) {
    const checked = validateSource(source)
    if (!checked.ok) return { ok: false, imported, error: checked.error }

    const destRel = posixJoin(destBase, basename(checked.abs))
    if (hasDotDotSegment(destRel) || hasDotDotSegment(destBase)) {
      return { ok: false, imported, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    try {
      const result = await uploadTree(req.baseUrl, req.token, checked.abs, destRel)
      imported += result.count
      if (!result.ok) return { ok: false, imported, error: result.error }
    } catch (e) {
      return {
        ok: false,
        imported,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }
  return { ok: true, imported }
}
