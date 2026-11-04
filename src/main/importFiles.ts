/**
 * Import OS-dropped files/folders into a group folder, and copy items out (export).
 *
 * Tree copy is async (fs.promises + setImmediate yields) so the Electron main
 * process event loop stays responsive during large imports.
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'path'
import type { ImportLocalRequest, ImportLocalResult } from '../shared/types'
import { copyTree, dirTotalBytes } from './fsCopy'
import { resolveSafe } from './pathSafe'

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
  req: ImportLocalRequest,
  onProgress?: (copiedBytes: number, totalBytes: number) => void
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

  const checkedSources: string[] = []
  for (const source of sources) {
    const checked = validateSource(source)
    if (!checked.ok) return { ok: false, imported: 0, error: checked.error }
    checkedSources.push(checked.abs)
  }

  let totalBytes = 0
  const sourceSizes: number[] = []
  for (const abs of checkedSources) {
    const bytes = await dirTotalBytes(abs)
    sourceSizes.push(bytes)
    totalBytes += bytes
  }
  onProgress?.(0, totalBytes)

  let imported = 0
  let completedBytes = 0
  const names: string[] = []
  const renamed: { from: string; to: string }[] = []
  for (let i = 0; i < checkedSources.length; i++) {
    const abs = checkedSources[i]
    const original = basename(abs)
    const name = uniqueNameInDir(destDir, original)
    const destAbs = join(destDir, name)
    try {
      resolveSafe(shareRoot, relative(shareReal, destAbs) || name)
    } catch {
      return { ok: false, imported, error: 'Ruta no permitida (path traversal bloqueado).' }
    }

    const blocked = rejectSelfCopy(shareReal, abs, destDir, destAbs)
    if (blocked) return { ok: false, imported, error: blocked }

    try {
      const treeProgress = { files: 0, bytes: 0 }
      await copyTree(abs, destAbs, treeProgress, (copiedInSource) => {
        onProgress?.(completedBytes + copiedInSource, totalBytes)
      })
      completedBytes += sourceSizes[i] ?? treeProgress.bytes
      onProgress?.(completedBytes, totalBytes)
      imported++
      names.push(name)
      if (name !== original) renamed.push({ from: original, to: name })
      // Yield between top-level sources so concurrent IPC can run.
      await yieldToEventLoop()
    } catch (e) {
      return {
        ok: false,
        imported,
        names,
        renamed,
        error: e instanceof Error ? e.message : `No se pudo copiar ${abs}.`
      }
    }
  }
  return { ok: true, imported, names, renamed }
}

/** Copy absolute paths into an arbitrary absolute directory (e.g. user-chosen export folder). */
export async function copyPathsToDirectory(
  sources: string[],
  destDir: string,
  onProgress?: (copiedBytes: number, totalBytes: number) => void
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

  const checkedSources: string[] = []
  for (const source of sources) {
    const checked = validateSource(source)
    if (!checked.ok) return { ok: false, copied: 0, destPaths: [], error: checked.error }
    checkedSources.push(checked.abs)
  }

  let totalBytes = 0
  const sourceSizes: number[] = []
  for (const abs of checkedSources) {
    const bytes = await dirTotalBytes(abs)
    sourceSizes.push(bytes)
    totalBytes += bytes
  }
  onProgress?.(0, totalBytes)

  const destPaths: string[] = []
  let copied = 0
  let completedBytes = 0
  for (let i = 0; i < checkedSources.length; i++) {
    const abs = checkedSources[i]
    const name = uniqueNameInDir(destReal, basename(abs))
    const destAbs = join(destReal, name)

    try {
      const treeProgress = { files: 0, bytes: 0 }
      await copyTree(abs, destAbs, treeProgress, (copiedInSource) => {
        onProgress?.(completedBytes + copiedInSource, totalBytes)
      })
      completedBytes += sourceSizes[i] ?? treeProgress.bytes
      onProgress?.(completedBytes, totalBytes)
      destPaths.push(destAbs)
      copied++
      await yieldToEventLoop()
    } catch (e) {
      return {
        ok: false,
        copied,
        destPaths,
        error: e instanceof Error ? e.message : `No se pudo copiar ${abs}.`
      }
    }
  }
  return { ok: true, copied, destPaths }
}
