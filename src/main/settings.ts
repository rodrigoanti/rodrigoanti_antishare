import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** Stable per-install id used in sync version vectors and group signatures. */
export function loadDeviceId(): string {
  const path = join(app.getPath('userData'), 'device-id')
  try {
    if (existsSync(path)) {
      const id = readFileSync(path, 'utf8').trim()
      if (id) return id
    }
  } catch {
    /* regenerate below */
  }
  const id = randomUUID()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, id, 'utf8')
  } catch (err) {
    console.error('[settings] device id save failed', err instanceof Error ? err.message : err)
  }
  return id
}
