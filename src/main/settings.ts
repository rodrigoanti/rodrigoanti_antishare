import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ShareSettings } from '../shared/types'

const FILE_NAME = 'share-settings.json'

function settingsPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export function defaultSettings(): ShareSettings {
  return {
    folder: null,
    autoStart: false
  }
}

export function loadSettings(): ShareSettings {
  const defaults = defaultSettings()
  try {
    const path = settingsPath()
    if (!existsSync(path)) return defaults
    // Migrate: drop legacy `port` from older files.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ShareSettings> & {
      port?: unknown
    }
    const folder =
      typeof raw.folder === 'string' && raw.folder.length > 0 ? raw.folder : null
    const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : undefined
    const autoStart =
      typeof raw.autoStart === 'boolean' ? raw.autoStart : Boolean(folder)
    const out: ShareSettings = { folder, autoStart }
    if (token !== undefined) out.token = token
    if (typeof raw.syncSpace === 'string' && raw.syncSpace.trim()) out.syncSpace = raw.syncSpace.trim()
    // Rewrite without port if legacy field present
    if ('port' in raw) {
      try {
        writeFileSync(path, JSON.stringify(out, null, 2), 'utf8')
      } catch {
        /* ignore migrate write */
      }
    }
    return out
  } catch (err) {
    console.error('[settings] load failed', err instanceof Error ? err.message : err)
    return defaults
  }
}

/** Stable per-install id used in sync version vectors (never changes once created). */
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

export function saveSettings(partial: Partial<ShareSettings> & { token?: string }): ShareSettings {
  const current = loadSettings()
  const next: ShareSettings = {
    folder: partial.folder !== undefined ? partial.folder : current.folder,
    autoStart: partial.autoStart !== undefined ? partial.autoStart : current.autoStart
  }
  const syncSpace = (partial.syncSpace !== undefined ? partial.syncSpace : current.syncSpace)?.trim()
  if (syncSpace) next.syncSpace = syncSpace

  if ('token' in partial) {
    if (partial.token && partial.token.length > 0) {
      next.token = partial.token
    }
  } else if (current.token) {
    next.token = current.token
  }

  if (
    partial.folder &&
    partial.autoStart === undefined &&
    !current.folder &&
    partial.folder.length > 0
  ) {
    next.autoStart = true
  }

  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] save failed', err instanceof Error ? err.message : err)
  }
  return next
}
