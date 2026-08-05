import { existsSync, realpathSync } from 'fs'
import { dirname, join, normalize, relative, resolve, sep } from 'path'

export function isInsideRoot(rootReal: string, target: string): boolean {
  const root = normalize(rootReal)
  const abs = normalize(target)
  if (abs === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return abs.startsWith(prefix)
}

function assertLogicalUnder(rootResolved: string, candidate: string): void {
  const rel = relative(rootResolved, candidate)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('Path traversal blocked')
  }
  if (!isInsideRoot(rootResolved, candidate)) {
    throw new Error('Path traversal blocked')
  }
}

/**
 * Resolve path under share root. Blocks `..` and outbound symlinks
 * (realpath of target / nearest ancestor must stay under realpath(root)).
 */
export function resolveSafe(root: string, relPath: string): string {
  const rootResolved = resolve(root)
  let rootReal: string
  try {
    rootReal = realpathSync(rootResolved)
  } catch {
    throw new Error('Path traversal blocked')
  }

  const cleaned = (relPath || '.').replace(/^\/+/, '')
  const candidate = normalize(join(rootResolved, cleaned))
  assertLogicalUnder(rootResolved, candidate)

  if (existsSync(candidate)) {
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      throw new Error('Path traversal blocked')
    }
    if (!isInsideRoot(rootReal, real)) {
      throw new Error('Path traversal blocked')
    }
    return real
  }

  let ancestor = dirname(candidate)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (!existsSync(ancestor)) {
    throw new Error('Path traversal blocked')
  }

  let ancestorReal: string
  try {
    ancestorReal = realpathSync(ancestor)
  } catch {
    throw new Error('Path traversal blocked')
  }
  if (!isInsideRoot(rootReal, ancestorReal)) {
    throw new Error('Path traversal blocked')
  }

  const suffix = relative(ancestor, candidate)
  if (suffix.startsWith('..') || suffix.split(sep).includes('..')) {
    throw new Error('Path traversal blocked')
  }

  const finalPath = suffix ? normalize(join(ancestorReal, suffix)) : ancestorReal
  if (!isInsideRoot(rootReal, finalPath)) {
    throw new Error('Path traversal blocked')
  }

  return finalPath
}
