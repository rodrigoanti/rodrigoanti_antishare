import { createHash, randomBytes } from 'crypto'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher
} from 'fs'
import { basename, dirname, extname, join } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  GroupMetaResponse,
  Peer,
  SyncEntry,
  SyncIndexResponse,
  SyncStatus
} from '../shared/types'
import { resolveSafe } from './pathSafe'
import { peerHttp } from './peerHttp'
import {
  SETTLE_MS,
  SYNC_TEMP_PREFIX,
  SyncIndex,
  compareVersions,
  isIgnoredName,
  mergeVersions,
  type LocalEntry
} from './syncIndex'

/** Full round (scan + pull from every peer) even when nothing notifies us. */
const ROUND_INTERVAL_MS = 20_000
/** Quiet time after the last fs event before rescanning (editors write in bursts). */
const WATCH_DEBOUNCE_MS = 1_000
const NOTIFY_DEBOUNCE_MS = 300
const INDEX_TIMEOUT_MS = 8_000
const TRANSFER_TIMEOUT_MS = 120_000

export interface SyncEngineOptions {
  root: string
  groupId: string
  /** Absolute path of the persisted index file (outside the synced folder). */
  indexFile: string
  deviceId: string
  deviceName: string
  /** Peers announcing this group. */
  listPeers: () => Peer[]
  /** Auth headers for a request to `pathAndQuery` (signed with the current group key). */
  sign: (method: string, pathAndQuery: string) => Record<string, string>
  /** Group settings seen on a peer (name, deletion). */
  onPeerMeta?: (meta: GroupMetaResponse) => void
}

function isValidSyncPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && !isIgnoredName(seg))
}

function isValidEntry(e: unknown): e is SyncEntry {
  const r = e as SyncEntry
  return (
    !!r &&
    isValidSyncPath(r.path) &&
    typeof r.hash === 'string' &&
    typeof r.deleted === 'boolean' &&
    typeof r.modifiedBy === 'string' &&
    typeof r.modifiedAt === 'number' &&
    !!r.version &&
    typeof r.version === 'object'
  )
}

/** Deterministic on both sides, so exactly one device keeps the main name. */
function remoteWins(r: SyncEntry, l: SyncEntry): boolean {
  if (r.modifiedAt !== l.modifiedAt) return r.modifiedAt > l.modifiedAt
  return r.modifiedBy > l.modifiedBy
}

function conflictName(abs: string, deviceName: string): string {
  const ext = extname(abs)
  const stem = basename(abs, ext)
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const safeDevice = deviceName.replace(/[\\/:*?"<>|]/g, '_')
  let candidate = join(dirname(abs), `${stem} (conflicto de ${safeDevice} ${stamp})${ext}`)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dirname(abs), `${stem} (conflicto de ${safeDevice} ${stamp} ${n})${ext}`)
    n++
  }
  return candidate
}

/**
 * Keeps one folder identical across every member of a group.
 * Pull-only: each device downloads newer versions from peers and never writes to theirs.
 */
export class SyncEngine {
  private readonly index: SyncIndex
  private watcher: FSWatcher | null = null
  private roundTimer: ReturnType<typeof setInterval> | null = null
  private scanDebounce: ReturnType<typeof setTimeout> | null = null
  private notifyDebounce: ReturnType<typeof setTimeout> | null = null
  private running = false
  private rerun = false
  private stopped = false
  private status: SyncStatus

  constructor(private readonly opts: SyncEngineOptions) {
    this.index = new SyncIndex(opts.indexFile, opts.deviceId)
    this.status = {
      state: 'idle',
      peers: 0,
      files: this.index.liveFileCount(),
      conflicts: 0,
      lastSyncAt: null
    }
  }

  start(): void {
    try {
      this.watcher = watch(this.opts.root, { recursive: true }, (_ev, filename) => {
        const name = filename ? basename(String(filename)) : ''
        if (name && isIgnoredName(name)) return
        this.scheduleRound(WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', (err) => console.warn('[sync] watcher error', err.message))
    } catch (err) {
      // Periodic rounds still pick up changes, just slower.
      console.warn('[sync] watch unavailable', err instanceof Error ? err.message : err)
    }
    this.roundTimer = setInterval(() => void this.round(), ROUND_INTERVAL_MS)
    void this.round()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.roundTimer) clearInterval(this.roundTimer)
    if (this.scanDebounce) clearTimeout(this.scanDebounce)
    if (this.notifyDebounce) clearTimeout(this.notifyDebounce)
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  indexResponse(): SyncIndexResponse {
    return {
      groupId: this.opts.groupId,
      deviceId: this.opts.deviceId,
      deviceName: this.opts.deviceName,
      entries: this.index.publicEntries()
    }
  }

  /** A member says it has changes: pull soon instead of waiting for the timer. */
  onNotify(deviceId: string): void {
    if (deviceId === this.opts.deviceId) return
    this.scheduleRound(NOTIFY_DEBOUNCE_MS)
  }

  /** Tell members to pull now (e.g. after a rename or password change). */
  kick(): void {
    void this.notifyPeers()
  }

  private scheduleRound(delayMs: number): void {
    if (this.stopped) return
    if (this.scanDebounce) clearTimeout(this.scanDebounce)
    this.scanDebounce = setTimeout(() => void this.round(), delayMs)
  }

  private groupPath(rest: string): string {
    return `/g/${this.opts.groupId}/${rest}`
  }

  /** Signs exactly the path + query the HTTP client will put on the request line. */
  private signed(method: string, url: string): Record<string, string> {
    const u = new URL(url)
    return this.opts.sign(method, `${u.pathname}${u.search}`)
  }

  private peerBases(peer: Peer): string[] {
    const bases = [peer.baseUrl, ...(peer.hosts ?? []).map((h) => `http://${h}:${peer.port}`)]
    return bases.map((b) => b.replace(/\/+$/, '')).filter((b, i, arr) => b && arr.indexOf(b) === i)
  }

  private async round(): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      this.status.state = 'scanning'
      const scanned = await this.index.scan(this.opts.root)
      if (this.stopped) return

      this.status.state = 'syncing'
      let reached = 0
      let applied = 0
      for (const peer of this.opts.listPeers()) {
        if (this.stopped) return
        const remote = await this.fetchIndex(peer)
        if (!remote) continue
        reached++
        applied += await this.applyRemote(remote.base, remote.index)
      }
      if (applied > 0) this.index.save()

      this.status = {
        ...this.status,
        state: 'idle',
        peers: reached,
        files: this.index.liveFileCount(),
        lastSyncAt: Date.now(),
        error: undefined
      }
      if (scanned > 0 || applied > 0) void this.notifyPeers()
    } catch (err) {
      this.status.state = 'error'
      this.status.error = err instanceof Error ? err.message : String(err)
      console.error('[sync] round failed', this.status.error)
    } finally {
      this.running = false
      if (this.rerun && !this.stopped) {
        this.rerun = false
        this.scheduleRound(NOTIFY_DEBOUNCE_MS)
      } else if (this.index.pendingWrites) {
        this.scheduleRound(SETTLE_MS)
      }
    }
  }

  /** Meta first (it may carry a new key), then the file index. */
  private async fetchIndex(
    peer: Peer
  ): Promise<{ base: string; index: SyncIndexResponse } | null> {
    for (const base of this.peerBases(peer)) {
      try {
        const metaUrl = `${base}${this.groupPath('meta')}`
        const metaRes = await peerHttp(metaUrl, {
          headers: this.signed('GET', metaUrl),
          timeoutMs: INDEX_TIMEOUT_MS
        })
        // 401 = different password, 404 = the peer left the group: not a member for us.
        if (!metaRes.ok) return null
        const meta = (await metaRes.json()) as GroupMetaResponse
        if (meta.id === this.opts.groupId) this.opts.onPeerMeta?.(meta)
        if (this.stopped || meta.meta?.deleted) return null

        const indexUrl = `${base}${this.groupPath('index')}`
        const res = await peerHttp(indexUrl, {
          headers: this.signed('GET', indexUrl),
          timeoutMs: INDEX_TIMEOUT_MS
        })
        if (!res.ok) return null
        const body = (await res.json()) as SyncIndexResponse
        if (body.groupId !== this.opts.groupId || body.deviceId === this.opts.deviceId) return null
        if (!Array.isArray(body.entries)) return null
        return { base, index: body }
      } catch {
        /* try next host */
      }
    }
    return null
  }

  private async notifyPeers(): Promise<void> {
    const body = JSON.stringify({ deviceId: this.opts.deviceId })
    await Promise.all(
      this.opts.listPeers().map(async (peer) => {
        const [base] = this.peerBases(peer)
        if (!base) return
        const url = `${base}${this.groupPath('notify')}`
        try {
          await peerHttp(url, {
            method: 'POST',
            headers: { ...this.signed('POST', url), 'Content-Type': 'application/json' },
            body,
            timeoutMs: INDEX_TIMEOUT_MS
          })
        } catch {
          /* the peer's own timer catches up */
        }
      })
    )
  }

  /** True when the file on disk is exactly what the index last recorded (no unscanned edit). */
  private localMatches(abs: string, l: LocalEntry | undefined): boolean {
    if (!existsSync(abs)) return !l || l.deleted
    if (!l || l.deleted) return false
    try {
      const st = statSync(abs)
      return st.isFile() && st.size === l.size && st.mtimeMs === l.mtime
    } catch {
      return false
    }
  }

  /** Merge one peer's index into ours. Returns how many entries changed locally. */
  private async applyRemote(base: string, remote: SyncIndexResponse): Promise<number> {
    let applied = 0
    for (const r of remote.entries) {
      if (this.stopped) break
      if (!isValidEntry(r)) continue
      let abs: string
      try {
        abs = resolveSafe(this.opts.root, r.path)
      } catch {
        continue
      }
      const l = this.index.entries.get(r.path)

      if (!l) {
        if (r.deleted) {
          this.index.entries.set(r.path, { ...r, mtime: 0 })
          applied++
        } else if (await this.pull(base, r, r.version, abs, l)) {
          applied++
        }
        continue
      }

      const order = compareVersions(r.version, l.version)
      if (order === 'equal' || order === 'less') continue

      if (order === 'greater') {
        if (r.deleted) {
          if (this.removeLocal(abs, l)) {
            this.index.entries.set(r.path, { ...r, mtime: 0 })
            applied++
          }
        } else if (!l.deleted && l.hash === r.hash) {
          this.index.entries.set(r.path, { ...r, mtime: l.mtime })
          applied++
        } else if (await this.pull(base, r, r.version, abs, l)) {
          applied++
        }
        continue
      }

      // Concurrent: both sides changed the file without seeing each other's edit.
      const merged = mergeVersions(l.version, r.version)
      const sameContent = r.deleted === l.deleted && (r.deleted || r.hash === l.hash)
      if (sameContent) {
        this.index.entries.set(r.path, { ...l, version: merged })
        applied++
        continue
      }
      // An edit always beats a delete, so no one loses work.
      if (r.deleted) continue
      if (l.deleted) {
        if (await this.pull(base, r, merged, abs, l)) applied++
        continue
      }
      // Both edited: the newest keeps the name, the other survives as a conflict copy.
      if (!remoteWins(r, l)) continue
      if (!this.localMatches(abs, l)) continue
      try {
        copyFileSync(abs, conflictName(abs, this.opts.deviceName))
      } catch (err) {
        console.warn('[sync] conflict copy failed', err instanceof Error ? err.message : err)
        continue
      }
      if (await this.pull(base, r, merged, abs, l)) {
        this.status.conflicts++
        applied++
      }
    }
    return applied
  }

  /** Download r into a temp file next to the target, verify the hash, then swap it in. */
  private async pull(
    base: string,
    r: SyncEntry,
    version: SyncEntry['version'],
    abs: string,
    l: LocalEntry | undefined
  ): Promise<boolean> {
    if (!this.localMatches(abs, l)) return false
    const dir = dirname(abs)
    const tmp = join(dir, `${SYNC_TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
    try {
      mkdirSync(dir, { recursive: true })
      const url = `${base}${this.groupPath('download')}?path=${encodeURIComponent(r.path)}`
      const res = await peerHttp(url, {
        headers: this.signed('GET', url),
        timeoutMs: TRANSFER_TIMEOUT_MS,
        stream: true
      })
      if (!res.ok) {
        res.bodyStream.resume()
        return false
      }
      const hash = createHash('sha256')
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk)
          cb(null, chunk)
        }
      })
      await pipeline(res.bodyStream, tap, createWriteStream(tmp))
      // A mismatch means the peer edited the file mid-transfer; the next round retries.
      if (hash.digest('hex') !== r.hash) {
        rmSync(tmp, { force: true })
        return false
      }
      // Re-check: the user may have saved the file while we were downloading.
      if (!this.localMatches(abs, l)) {
        rmSync(tmp, { force: true })
        return false
      }
      renameSync(tmp, abs)
      const st = statSync(abs)
      this.index.entries.set(r.path, { ...r, version, size: st.size, mtime: st.mtimeMs })
      return true
    } catch (err) {
      rmSync(tmp, { force: true })
      console.warn('[sync] pull failed', r.path, err instanceof Error ? err.message : err)
      return false
    }
  }

  private removeLocal(abs: string, l: LocalEntry): boolean {
    if (!existsSync(abs)) return true
    if (!this.localMatches(abs, l)) return false
    try {
      unlinkSync(abs)
    } catch {
      return false
    }
    this.pruneEmptyDirs(dirname(abs))
    return true
  }

  /** Remove folders left empty by remote deletions, up to (not including) the root. */
  private pruneEmptyDirs(dir: string): void {
    let current = dir
    while (current.length > this.opts.root.length && current.startsWith(this.opts.root)) {
      try {
        const left = readdirSync(current).filter((n) => !isIgnoredName(n))
        if (left.length > 0) return
        for (const n of readdirSync(current)) rmSync(join(current, n), { force: true })
        rmdirSync(current)
      } catch {
        return
      }
      current = dirname(current)
    }
  }
}
