/**
 * Delete by moving to the OS Trash / Recycle Bin so a mistaken delete can be restored.
 * Falls back to a permanent delete when the Trash is unavailable (network volumes,
 * or outside Electron as in the smoke scripts).
 */
import { rmSync } from 'fs'

type TrashFn = (abs: string) => Promise<void>

function electronTrash(): TrashFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shell = require('electron').shell as { trashItem?: TrashFn } | undefined
    return shell?.trashItem ? (abs) => shell.trashItem!(abs) : null
  } catch {
    return null
  }
}

export async function moveToTrash(abs: string): Promise<void> {
  const trash = electronTrash()
  if (trash) {
    try {
      await trash(abs)
      return
    } catch (err) {
      console.warn('[trash] fallback to permanent delete', abs, err instanceof Error ? err.message : err)
    }
  }
  rmSync(abs, { recursive: true, force: true })
}
