/**
 * Async recursive copy with event-loop yields so Electron main stays responsive.
 */
import { promises as fsp } from 'fs'
import { join, normalize, sep } from 'path'

/** Yield to the main event loop every N file copies so IPC/UI stay responsive. */
const COPY_YIELD_EVERY = 8

function isInside(parent: string, child: string): boolean {
  const p = normalize(parent)
  const c = normalize(child)
  if (p === c) return true
  const prefix = p.endsWith(sep) ? p : p + sep
  return c.startsWith(prefix)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Copy a file or directory tree asynchronously (skips symlinks). */
export async function copyTree(
  src: string,
  dest: string,
  progress: { files: number } = { files: 0 }
): Promise<void> {
  const st = await fsp.lstat(src)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    let srcReal = src
    try {
      srcReal = await fsp.realpath(src)
    } catch {
      srcReal = normalize(src)
    }
    let destNorm = normalize(dest)
    try {
      await fsp.access(dest)
      destNorm = await fsp.realpath(dest)
    } catch {
      destNorm = normalize(dest)
    }
    if (isInside(srcReal, destNorm)) {
      throw new Error('No se puede copiar una carpeta dentro de sí misma.')
    }
    await fsp.mkdir(dest, { recursive: true })
    const names = await fsp.readdir(src)
    for (const name of names) {
      await copyTree(join(src, name), join(dest, name), progress)
    }
    return
  }
  if (st.isFile()) {
    await fsp.copyFile(src, dest)
    progress.files += 1
    if (progress.files % COPY_YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
  }
}
