/**
 * mkdir / rename / remove inside a share root. All paths go through resolveSafe.
 * Names cannot be empty or contain /, \\ or :. Never mutate the share root itself.
 */
import { existsSync, mkdirSync, promises as fsp, renameSync, statSync, realpathSync } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import type {
  FsMkdirRequest,
  FsMoveRequest,
  FsOpResult,
  FsRemoveRequest,
  FsRenameRequest
} from '../shared/types'
import { copyTree } from './fsCopy'
import { resolveSafe } from './pathSafe'
import { moveToTrash } from './trash'

export class FsOpError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'exists' | 'notfound' | 'traversal' | 'forbidden'
  ) {
    super(message)
    this.name = 'FsOpError'
  }
}

export function assertEntryName(raw: string): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new FsOpError('El nombre no puede estar vacío.', 'invalid')
  if (/[/\\:]/.test(name) || name.includes('\0')) {
    throw new FsOpError('El nombre no puede contener /, \\ ni :.', 'invalid')
  }
  if (name === '.' || name === '..') throw new FsOpError('Nombre inválido.', 'invalid')
  return name
}

function posixRel(rel: string): string {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

function childRel(parentRel: string, name: string): string {
  const p = posixRel(parentRel)
  return p ? `${p}/${name}` : name
}

function rootReal(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
}

function isShareRoot(root: string, abs: string): boolean {
  return abs === rootReal(root)
}

function wrap(fn: () => void): FsOpResult {
  try {
    fn()
    return { ok: true }
  } catch (e) {
    if (e instanceof FsOpError) return { ok: false, error: e.message }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('traversal')) {
      return { ok: false, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    return { ok: false, error: msg }
  }
}

async function wrapAsync(fn: () => Promise<void>): Promise<FsOpResult> {
  try {
    await fn()
    return { ok: true }
  } catch (e) {
    if (e instanceof FsOpError) return { ok: false, error: e.message }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('traversal')) {
      return { ok: false, error: 'Ruta no permitida (path traversal bloqueado).' }
    }
    return { ok: false, error: msg }
  }
}

function requireRoot(root: string | null): string {
  if (!root) throw new FsOpError('No hay carpeta compartida configurada.', 'forbidden')
  return root
}

/** Create a single directory. Fails if it already exists. Parent must exist. */
export function mkdirInShare(root: string, parentRel: string, name: string): void {
  const entry = assertEntryName(name)
  let parentAbs: string
  try {
    parentAbs = resolveSafe(root, posixRel(parentRel) || '.')
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
    throw new FsOpError('La carpeta destino no existe.', 'notfound')
  }
  let destAbs: string
  try {
    destAbs = resolveSafe(root, childRel(parentRel, entry))
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (existsSync(destAbs)) {
    throw new FsOpError('Ya existe un ítem con ese nombre.', 'exists')
  }
  mkdirSync(destAbs)
}

/** Rename a file or folder within the same parent. Does not overwrite. */
export function renameInShare(root: string, relPath: string, newName: string): void {
  const entry = assertEntryName(newName)
  const rel = posixRel(relPath)
  if (!rel || rel === '.') {
    throw new FsOpError('No se puede renombrar la raíz del share.', 'forbidden')
  }
  let srcAbs: string
  try {
    srcAbs = resolveSafe(root, rel)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (!existsSync(srcAbs)) throw new FsOpError('No existe ese ítem.', 'notfound')
  if (isShareRoot(root, srcAbs)) {
    throw new FsOpError('No se puede renombrar la raíz del share.', 'forbidden')
  }

  const destAbs = join(dirname(srcAbs), entry)
  let destSafe: string
  try {
    const destRel = relative(rootReal(root), destAbs).split(sep).join('/')
    destSafe = resolveSafe(root, destRel)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (existsSync(destSafe)) {
    try {
      if (realpathSync(destSafe) !== srcAbs) {
        throw new FsOpError('Ya existe un ítem con ese nombre.', 'exists')
      }
    } catch (e) {
      if (e instanceof FsOpError) throw e
      throw new FsOpError('Ya existe un ítem con ese nombre.', 'exists')
    }
  }
  renameSync(srcAbs, destSafe)
}

function isInsideAbs(parentAbs: string, childAbs: string): boolean {
  const p = parentAbs.endsWith(sep) ? parentAbs : parentAbs + sep
  return childAbs === parentAbs || childAbs.startsWith(p)
}

/**
 * Move a file/folder to another folder inside the share (same basename).
 * Same-device uses renameSync (instant). Cross-device (EXDEV) uses async copyTree + rm
 * so the main process stays responsive; origin is only deleted after a successful copy.
 */
export async function moveInShare(
  root: string,
  relPath: string,
  destParentRel: string
): Promise<void> {
  const rel = posixRel(relPath)
  if (!rel || rel === '.') {
    throw new FsOpError('No se puede mover la raíz del share.', 'forbidden')
  }
  let srcAbs: string
  try {
    srcAbs = resolveSafe(root, rel)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (!existsSync(srcAbs)) throw new FsOpError('No existe ese ítem.', 'notfound')
  if (isShareRoot(root, srcAbs)) {
    throw new FsOpError('No se puede mover la raíz del share.', 'forbidden')
  }

  let destParentAbs: string
  try {
    destParentAbs = resolveSafe(root, posixRel(destParentRel) || '.')
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (!existsSync(destParentAbs) || !statSync(destParentAbs).isDirectory()) {
    throw new FsOpError('La carpeta destino no existe.', 'notfound')
  }

  let srcReal = srcAbs
  let destParentReal = destParentAbs
  try {
    srcReal = realpathSync(srcAbs)
    destParentReal = realpathSync(destParentAbs)
  } catch {
    /* keep logical paths */
  }

  if (dirname(srcReal) === destParentReal) {
    throw new FsOpError('Ese ítem ya está en esta carpeta.', 'exists')
  }

  const name = basename(srcAbs)
  const destAbs = join(destParentAbs, name)
  let destSafe: string
  try {
    const destRel = relative(rootReal(root), destAbs).split(sep).join('/')
    destSafe = resolveSafe(root, destRel)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }

  if (statSync(srcAbs).isDirectory() && isInsideAbs(srcReal, destParentReal)) {
    throw new FsOpError('No se puede mover una carpeta dentro de sí misma.', 'forbidden')
  }

  if (existsSync(destSafe)) {
    throw new FsOpError('Ya existe un ítem con ese nombre.', 'exists')
  }

  try {
    renameSync(srcAbs, destSafe)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code !== 'EXDEV') {
      throw e instanceof FsOpError
        ? e
        : new FsOpError(e instanceof Error ? e.message : 'No se pudo mover.', 'invalid')
    }
    // Cross-device: copy async first; only then remove source (no data loss on copy failure).
    await copyTree(srcAbs, destSafe)
    await fsp.rm(srcAbs, { recursive: true, force: true })
  }
}

/** Move a file or folder to the Trash (permanent only as fallback). Never the share root. */
export async function removeInShare(root: string, relPath: string): Promise<void> {
  const rel = posixRel(relPath)
  if (!rel || rel === '.') {
    throw new FsOpError('No se puede eliminar la raíz del share.', 'forbidden')
  }
  let abs: string
  try {
    abs = resolveSafe(root, rel)
  } catch {
    throw new FsOpError('Path traversal blocked', 'traversal')
  }
  if (!existsSync(abs)) throw new FsOpError('No existe ese ítem.', 'notfound')
  if (isShareRoot(root, abs)) {
    throw new FsOpError('No se puede eliminar la raíz del share.', 'forbidden')
  }
  await moveToTrash(abs)
}

export function mkdirLocal(root: string | null, req: FsMkdirRequest): FsOpResult {
  return wrap(() => mkdirInShare(requireRoot(root), req.path || '', req.name))
}

export function renameLocal(root: string | null, req: FsRenameRequest): FsOpResult {
  return wrap(() => renameInShare(requireRoot(root), req.path, req.newName))
}

export async function moveLocal(
  root: string | null,
  req: FsMoveRequest
): Promise<FsOpResult> {
  return wrapAsync(() => moveInShare(requireRoot(root), req.path, req.destPath || ''))
}

export function removeLocal(root: string | null, req: FsRemoveRequest): Promise<FsOpResult> {
  return wrapAsync(() => removeInShare(requireRoot(root), req.path))
}
