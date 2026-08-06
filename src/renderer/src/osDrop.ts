export const ANTISHARE_INTERNAL_DRAG = 'application/x-antishare-internal'

/** Session flag: native startDrag strips custom MIME, so track AntiShare→self drops. */
let internalOsDragDepth = 0

export function beginInternalFileDrag(): void {
  internalOsDragDepth += 1
}

export function endInternalFileDrag(): void {
  internalOsDragDepth = Math.max(0, internalOsDragDepth - 1)
}

export function isInternalFileDragActive(): boolean {
  return internalOsDragDepth > 0
}

export function markInternalDrag(dt: DataTransfer): void {
  dt.effectAllowed = 'copy'
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
