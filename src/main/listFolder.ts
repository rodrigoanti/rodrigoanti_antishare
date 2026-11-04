import { lstatSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import type { DirEntry } from '../shared/types'
import { isInsideRoot, resolveSafe } from './pathSafe'
import { SYNC_TEMP_PREFIX } from './syncIndex'

/** Name of the device that last changed a share-relative file, if known. */
export type AuthorLookup = (path: string) => string | undefined

/** List directory under share root with symlink-safe resolveSafe. */
export function listShareFolder(root: string, relPath: string = '', authorOf?: AuthorLookup): DirEntry[] {
  const entries = listDir(root, relPath)
  if (!authorOf) return entries
  return entries.map((e) => {
    if (e.isDir) return e
    const modifiedByName = authorOf(e.path)
    return modifiedByName ? { ...e, modifiedByName } : e
  })
}

function listDir(root: string, relPath: string): DirEntry[] {
  const abs = resolveSafe(root, relPath)
  const st = statSync(abs)
  if (!st.isDirectory()) {
    throw new Error('Not a directory')
  }
  const rootReal = realpathSync(root)
  const names = readdirSync(abs).filter((n) => !n.startsWith(SYNC_TEMP_PREFIX))
  return names.map((name) => {
    const full = join(abs, name)
    const lst = lstatSync(full)
    const entryRel = relPath && relPath !== '.' ? `${relPath.replace(/\/$/, '')}/${name}` : name
    const base = {
      name,
      path: entryRel.replace(/\\/g, '/'),
      mtime: lst.mtimeMs
    }

    if (lst.isSymbolicLink()) {
      try {
        const real = realpathSync(full)
        if (!isInsideRoot(rootReal, real)) {
          return { ...base, isDir: false, size: 0 }
        }
        const s = statSync(real)
        return {
          ...base,
          isDir: s.isDirectory(),
          size: s.isFile() ? s.size : 0,
          mtime: s.mtimeMs
        }
      } catch {
        return { ...base, isDir: false, size: 0 }
      }
    }

    return {
      ...base,
      isDir: lst.isDirectory(),
      size: lst.isFile() ? lst.size : 0
    } satisfies DirEntry
  })
}
