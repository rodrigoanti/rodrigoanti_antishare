import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { lstat, readdir } from 'fs/promises'
import { dirname, join } from 'path'
import type { SyncEntry, VersionVector } from '../shared/types'

/** Prefix for in-flight downloads; never indexed, listed or synced. */
export const SYNC_TEMP_PREFIX = '.~antishare-'

/** A file touched this recently may still be mid-write (copy, editor save); retry later. */
export const SETTLE_MS = 2_000

const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'])

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith(SYNC_TEMP_PREFIX) || name.startsWith('~$')
}

/** Local-only stat fingerprint so unchanged files are not rehashed on every scan. */
export interface LocalEntry extends SyncEntry {
  mtime: number
}

export type VersionOrder = 'equal' | 'greater' | 'less' | 'concurrent'

/** Order of `a` relative to `b`. */
export function compareVersions(a: VersionVector, b: VersionVector): VersionOrder {
  let aAhead = false
  let bAhead = false
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[id] ?? 0
    const bv = b[id] ?? 0
    if (av > bv) aAhead = true
    if (bv > av) bAhead = true
  }
  if (aAhead && bAhead) return 'concurrent'
  if (aAhead) return 'greater'
  if (bAhead) return 'less'
  return 'equal'
}

export function mergeVersions(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a }
  for (const [id, v] of Object.entries(b)) out[id] = Math.max(out[id] ?? 0, v)
  return out
}

export function bumpVersion(v: VersionVector, deviceId: string): VersionVector {
  return { ...v, [deviceId]: (v[deviceId] ?? 0) + 1 }
}

export function hashFile(abs: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256')
    createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolveHash(h.digest('hex')))
  })
}

/** Index of one synced folder, persisted outside the folder (userData). */
export class SyncIndex {
  entries = new Map<string, LocalEntry>()
  /** Last scan skipped files that were still changing. */
  pendingWrites = false

  constructor(
    private readonly file: string,
    readonly deviceId: string
  ) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: LocalEntry[] }
      for (const e of raw.entries ?? []) {
        if (e && typeof e.path === 'string') this.entries.set(e.path, e)
      }
    } catch (err) {
      console.error('[sync] index load failed', err instanceof Error ? err.message : err)
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ entries: [...this.entries.values()] }), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[sync] index save failed', err instanceof Error ? err.message : err)
    }
  }

  /** Shared view (drops the local stat fingerprint). */
  publicEntries(): SyncEntry[] {
    return [...this.entries.values()].map(({ mtime: _mtime, ...e }) => e)
  }

  liveFileCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (!e.deleted) n++
    return n
  }

  /**
   * Walk the folder and record local edits: new/changed files get a bumped version,
   * vanished files become tombstones. Returns how many entries changed.
   */
  async scan(root: string): Promise<number> {
    const seen = new Set<string>()
    let changed = 0
    this.pendingWrites = false

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(absDir)
      } catch {
        return
      }
      for (const name of names) {
        if (isIgnoredName(name)) continue
        const abs = join(absDir, name)
        const rel = relDir ? `${relDir}/${name}` : name
        let st
        try {
          st = await lstat(abs)
        } catch {
          continue
        }
        // Symlinks are skipped: following them could sync files outside the folder.
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          await walk(abs, rel)
          continue
        }
        if (!st.isFile()) continue
        seen.add(rel)
        const prev = this.entries.get(rel)
        if (prev && !prev.deleted && prev.size === st.size && prev.mtime === st.mtimeMs) continue
        if (Date.now() - st.mtimeMs < SETTLE_MS) {
          this.pendingWrites = true
          continue
        }
        let hash: string
        try {
          hash = await hashFile(abs)
          // Copies can keep the source mtime while still growing: size/mtime must hold still.
          const after = await lstat(abs)
          if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
            this.pendingWrites = true
            continue
          }
        } catch {
          // Locked (e.g. open in Excel on Windows) or vanished mid-hash: try next round.
          this.pendingWrites = true
          continue
        }
        if (prev && !prev.deleted && prev.hash === hash) {
          this.entries.set(rel, { ...prev, mtime: st.mtimeMs })
          continue
        }
        this.entries.set(rel, {
          path: rel,
          hash,
          size: st.size,
          deleted: false,
          version: bumpVersion(prev?.version ?? {}, this.deviceId),
          modifiedBy: this.deviceId,
          // File time, not scan time: the most recent save wins a conflict.
          modifiedAt: st.mtimeMs,
          mtime: st.mtimeMs
        })
        changed++
      }
    }

    await walk(root, '')

    for (const [path, e] of this.entries) {
      if (e.deleted || seen.has(path)) continue
      this.entries.set(path, {
        ...e,
        hash: '',
        size: 0,
        deleted: true,
        version: bumpVersion(e.version, this.deviceId),
        modifiedBy: this.deviceId,
        modifiedAt: Date.now(),
        mtime: 0
      })
      changed++
    }

    if (changed > 0) this.save()
    return changed
  }
}
