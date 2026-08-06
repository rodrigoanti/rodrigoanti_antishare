export const ANTISHARE_INTERNAL_DRAG = 'application/x-antishare-internal'

/** Session flag: track AntiShare→self drops (HTML5 internal drag). */
let internalOsDragDepth = 0
/** Share-relative parent of the item being dragged ('' = share root). */
let internalDragSourceParent: string | null = null
/** Share-relative path of the item being dragged. */
let internalDragSourcePath: string | null = null

export function beginInternalFileDrag(sourceParent?: string, sourcePath?: string): void {
  internalOsDragDepth += 1
  if (sourceParent !== undefined) {
    internalDragSourceParent = sourceParent
  }
  if (sourcePath !== undefined) {
    internalDragSourcePath = sourcePath
  }
}

export function endInternalFileDrag(): void {
  internalOsDragDepth = Math.max(0, internalOsDragDepth - 1)
  if (internalOsDragDepth === 0) {
    internalDragSourceParent = null
    internalDragSourcePath = null
  }
}

export function isInternalFileDragActive(): boolean {
  return internalOsDragDepth > 0
}

/** Share-relative parent path of the in-progress internal drag, or null. */
export function getInternalDragSourceParent(): string | null {
  return internalOsDragDepth > 0 ? internalDragSourceParent : null
}

/** Share-relative path of the item being dragged, or null. */
export function getInternalDragSourcePath(): string | null {
  return internalOsDragDepth > 0 ? internalDragSourcePath : null
}

/** True if `child` is the same as `parent` or nested under it (share-relative posix). */
export function isSharePathInsideOrEqual(parent: string, child: string): boolean {
  const p = String(parent || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  const c = String(child || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (p === c) return true
  if (!p) return true
  return c.startsWith(`${p}/`)
}

export function markInternalDrag(dt: DataTransfer): void {
  dt.effectAllowed = 'copyMove'
  dt.setData(ANTISHARE_INTERNAL_DRAG, '1')
}

export function isInternalDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes(ANTISHARE_INTERNAL_DRAG)
}

export function isOsFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt || isInternalDrag(dt) || isInternalFileDragActive()) return false
  return Array.from(dt.types).includes('Files')
}

type FileWithPath = File & { path?: string }

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function parentDir(p: string): string {
  const n = normPath(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? '' : n.slice(0, i)
}

function joinShareRoot(root: string, rel: string): string {
  const r = normPath(root)
  const p = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  return p ? `${r}/${p}` : r
}

export function osDropPaths(dt: DataTransfer): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string | undefined): void => {
    const path = raw?.trim()
    if (!path || seen.has(path)) return
    seen.add(path)
    out.push(path)
  }

  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i]
      if (item.kind !== 'file') continue
      const file = item.getAsFile() as FileWithPath | null
      push(file?.path)
    }
    if (out.length > 0) return out
  }

  for (const file of Array.from(dt.files)) {
    push((file as FileWithPath).path)
  }
  return out
}

/**
 * True when every dropped OS path already lives in the current local folder
 * (same-parent re-drop from Finder into the open share folder).
 */
export function isOsDropAlreadyInFolder(
  dt: DataTransfer,
  shareRoot: string | null | undefined,
  destRel: string
): boolean {
  if (!shareRoot) return false
  const paths = osDropPaths(dt)
  if (paths.length === 0) return false
  const destDir = joinShareRoot(shareRoot, destRel)
  return paths.every((p) => parentDir(p) === destDir)
}

/** Exactly one OS path that looks like a directory (Finder/Explorer folder drop). */
export function osDropSingleDirectoryPath(dt: DataTransfer): string | null {
  const paths = osDropPaths(dt)
  if (paths.length !== 1) return null
  const item = dt.items?.[0]
  if (item && typeof item.webkitGetAsEntry === 'function') {
    const entry = item.webkitGetAsEntry()
    if (entry && !entry.isDirectory) return null
  }
  return paths[0]
}
