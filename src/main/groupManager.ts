import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, isAbsolute } from 'path'
import type {
  AnnouncedGroup,
  DiscoveredGroup,
  GroupCreateRequest,
  GroupJoinRequest,
  GroupLeaveRequest,
  GroupMetaResponse,
  GroupOpResult,
  GroupUpdateRequest,
  GroupView,
  Peer
} from '../shared/types'
import { deriveGroupKey, newGroupId, signGroupRequest, verifyGroupRequest } from './groupAuth'
import type { GroupServerHooks } from './groupServer'
import type { AuthorLookup } from './listFolder'
import { GroupStore, isNewerMeta, type GroupRecord } from './groupStore'
import { peerHttp } from './peerHttp'
import { SyncEngine } from './syncEngine'

const MIN_PASSWORD = 4
const MAX_NAME = 60
const JOIN_TIMEOUT_MS = 6_000
const SELF_LABEL = 'este equipo'

export interface GroupManagerOptions {
  /** Directory for groups.json and sync indexes (userData in the app). */
  dataDir: string
  deviceId: string
  deviceName: string
  listPeers: () => Peer[]
}

function isNested(a: string, b: string): boolean {
  const rel = relative(a, b)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function realFolder(folder: string): string {
  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new Error('La carpeta no existe.')
  }
  return realpathSync(folder)
}

function cleanName(raw: string): string {
  const name = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Ponle un nombre al grupo.')
  if (name.length > MAX_NAME) throw new Error(`El nombre admite hasta ${MAX_NAME} caracteres.`)
  return name
}

function checkPassword(raw: string): string {
  const password = String(raw || '')
  if (password.length < MIN_PASSWORD) {
    throw new Error(`La clave debe tener al menos ${MIN_PASSWORD} caracteres.`)
  }
  return password
}

function fail(err: unknown): GroupOpResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Owns this device's group memberships: one sync engine per group with a folder, the
 * server hooks every /g/ route goes through, and the announcement other devices see.
 */
export class GroupManager {
  private readonly store: GroupStore
  private readonly engines = new Map<string, SyncEngine>()
  /** deviceId → last known name, kept on disk so offline members still show up. */
  private readonly deviceNames = new Map<string, string>()

  constructor(private readonly opts: GroupManagerOptions) {
    this.store = new GroupStore(join(opts.dataDir, 'groups.json'))
    this.loadDeviceNames()
  }

  private get deviceNamesFile(): string {
    return join(this.opts.dataDir, 'device-names.json')
  }

  private loadDeviceNames(): void {
    if (!existsSync(this.deviceNamesFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.deviceNamesFile, 'utf8')) as Record<string, unknown>
      for (const [id, name] of Object.entries(raw)) {
        if (typeof name === 'string' && name) this.deviceNames.set(id, name)
      }
    } catch (err) {
      console.error('[groups] device names load failed', err instanceof Error ? err.message : err)
    }
  }

  private rememberDevice(deviceId: string, name: string): void {
    const clean = name.trim().slice(0, MAX_NAME)
    if (!deviceId || !clean || deviceId === this.opts.deviceId) return
    if (this.deviceNames.get(deviceId) === clean) return
    this.deviceNames.set(deviceId, clean)
    try {
      mkdirSync(dirname(this.deviceNamesFile), { recursive: true })
      const tmp = `${this.deviceNamesFile}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.deviceNames)), 'utf8')
      renameSync(tmp, this.deviceNamesFile)
    } catch (err) {
      console.error('[groups] device names save failed', err instanceof Error ? err.message : err)
    }
  }

  /** Who last changed each file of a group, from its sync index; unknown devices stay blank. */
  authorLookup(id: string | undefined): AuthorLookup | undefined {
    const engine = id ? this.engines.get(id) : undefined
    if (!engine) return undefined
    return (path) => {
      const by = engine.modifiedBy(path)
      if (!by) return undefined
      return by === this.opts.deviceId ? SELF_LABEL : this.deviceNames.get(by)
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    for (const g of this.store.list()) this.ensureEngine(g)
  }

  stop(): void {
    for (const id of [...this.engines.keys()]) this.stopEngine(id)
  }

  /** Call when discovery changes: a newer password elsewhere pauses our engine. */
  onPeersChanged(): void {
    for (const g of this.store.list()) {
      if (this.isLocked(g)) this.stopEngine(g.id)
      else this.ensureEngine(g)
    }
  }

  private indexFile(g: GroupRecord): string {
    const key = createHash('sha1').update(`${g.id}\0${g.folder ?? ''}`).digest('hex')
    return join(this.opts.dataDir, 'sync', `${key}.json`)
  }

  private ensureEngine(g: GroupRecord): void {
    if (this.engines.has(g.id) || g.meta.deleted || !g.folder || this.isLocked(g)) return
    if (!existsSync(g.folder)) return
    const engine = new SyncEngine({
      root: g.folder,
      groupId: g.id,
      indexFile: this.indexFile(g),
      deviceId: this.opts.deviceId,
      deviceName: this.opts.deviceName,
      listPeers: () => this.syncPeers(g.id),
      sign: (method, path) => this.sign(g.id, method, path),
      onPeerMeta: (meta) => this.mergeMeta(meta),
      onPeerName: (deviceId, name) => this.rememberDevice(deviceId, name)
    })
    this.engines.set(g.id, engine)
    engine.start()
  }

  private stopEngine(id: string): void {
    this.engines.get(id)?.stop()
    this.engines.delete(id)
  }

  // ── peers and announcements ──────────────────────────────────────────────

  private announcedBy(peer: Peer, id: string): AnnouncedGroup | undefined {
    return peer.groups?.find((g) => g.id === id)
  }

  /** Members on the same password as us: the only ones our signatures work with. */
  private syncPeers(id: string): Peer[] {
    const g = this.store.get(id)
    if (!g) return []
    return this.opts.listPeers().filter((p) => this.announcedBy(p, id)?.keySince === g.keySince)
  }

  private isLocked(g: GroupRecord): boolean {
    if (g.meta.deleted) return false
    return this.opts.listPeers().some((p) => {
      const a = this.announcedBy(p, g.id)
      return Boolean(a && !a.deleted && a.keySince > g.keySince)
    })
  }

  private sign(id: string, method: string, path: string): Record<string, string> {
    const g = this.store.get(id)
    return g ? signGroupRequest(g.key, this.opts.deviceId, method, path) : {}
  }

  /** What other devices see over UDP. Tombstones stay so the deletion reaches everyone. */
  announced(): AnnouncedGroup[] {
    return this.store.list().map((g) => ({
      id: g.id,
      name: g.meta.name,
      keySince: g.keySince,
      ...(g.meta.deleted ? { deleted: true } : {})
    }))
  }

  // ── renderer views ───────────────────────────────────────────────────────

  private memberNames(id: string): string[] {
    const names = this.opts
      .listPeers()
      .filter((p) => {
        const a = this.announcedBy(p, id)
        return a && !a.deleted
      })
      .map((p) => p.name)
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'es'))
  }

  view(g: GroupRecord): GroupView {
    const engine = this.engines.get(g.id)
    return {
      id: g.id,
      name: g.meta.name,
      folder: g.folder,
      state: this.isLocked(g) ? 'locked' : g.folder ? 'ok' : 'noFolder',
      ...(engine ? { sync: engine.getStatus() } : {}),
      members: this.memberNames(g.id)
    }
  }

  groups(): GroupView[] {
    return this.store
      .list()
      .filter((g) => !g.meta.deleted)
      .map((g) => this.view(g))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }

  discovered(): DiscoveredGroup[] {
    const known = new Set(this.store.list().map((g) => g.id))
    const found = new Map<string, DiscoveredGroup & { keySince: number }>()
    for (const peer of this.opts.listPeers()) {
      for (const a of peer.groups ?? []) {
        if (a.deleted || known.has(a.id)) continue
        const cur = found.get(a.id)
        if (!cur) {
          found.set(a.id, { id: a.id, name: a.name, members: [peer.name], keySince: a.keySince })
          continue
        }
        if (!cur.members.includes(peer.name)) cur.members.push(peer.name)
        // Newest password holder has the most recent name too, most likely.
        if (a.keySince > cur.keySince) {
          cur.name = a.name
          cur.keySince = a.keySince
        }
      }
    }
    return [...found.values()]
      .map(({ keySince: _k, ...g }) => g)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }

  /** Absolute folder of a group this device syncs, or null. */
  rootFor(id: string | undefined): string | null {
    if (!id) return null
    const g = this.store.get(id)
    if (!g || g.meta.deleted || !g.folder || !existsSync(g.folder)) return null
    return g.folder
  }

  // ── actions ──────────────────────────────────────────────────────────────

  private assertFolderFree(folder: string, exceptId?: string): void {
    for (const g of this.store.list()) {
      if (g.id === exceptId || g.meta.deleted || !g.folder) continue
      if (isNested(g.folder, folder) || isNested(folder, g.folder)) {
        throw new Error(`Esa carpeta ya se sincroniza con «${g.meta.name}» (o está dentro de ella).`)
      }
    }
  }

  create(req: GroupCreateRequest): GroupOpResult {
    try {
      const name = cleanName(req.name)
      const password = checkPassword(req.password)
      const folder = realFolder(req.folder)
      this.assertFolderFree(folder)
      const id = newGroupId()
      const now = Date.now()
      const g: GroupRecord = {
        id,
        meta: { name, deleted: false, rev: 1, at: now, by: this.opts.deviceId },
        key: deriveGroupKey(id, password),
        keySince: now,
        folder
      }
      this.store.put(g)
      this.ensureEngine(g)
      return { ok: true, group: this.view(g) }
    } catch (err) {
      return fail(err)
    }
  }

  /** Join a discovered group, or re-enter the password of one we are already in. */
  async join(req: GroupJoinRequest): Promise<GroupOpResult> {
    try {
      const password = checkPassword(req.password)
      const existing = this.store.get(req.id)
      const folder = realFolder(req.folder || existing?.folder || '')
      this.assertFolderFree(folder, req.id)

      // Ask the members with the newest password: they define the group today.
      const members = this.opts
        .listPeers()
        .filter((p) => {
          const a = this.announcedBy(p, req.id)
          return a && !a.deleted
        })
        .sort((a, b) => this.announcedBy(b, req.id)!.keySince - this.announcedBy(a, req.id)!.keySince)
      if (members.length === 0) {
        throw new Error('No hay miembros del grupo conectados ahora. Intenta cuando alguno esté encendido.')
      }

      const key = deriveGroupKey(req.id, password)
      let meta: GroupMetaResponse | null = null
      let rejected = false
      for (const peer of members) {
        const bases = [peer.baseUrl, ...(peer.hosts ?? []).map((h) => `http://${h}:${peer.port}`)]
        for (const base of [...new Set(bases)]) {
          const url = `${base}/g/${req.id}/meta`
          try {
            const u = new URL(url)
            const res = await peerHttp(url, {
              headers: signGroupRequest(key, this.opts.deviceId, 'GET', `${u.pathname}${u.search}`),
              timeoutMs: JOIN_TIMEOUT_MS
            })
            if (res.status === 401) {
              rejected = true
              break
            }
            if (res.ok) meta = (await res.json()) as GroupMetaResponse
            break
          } catch {
            /* next address */
          }
        }
        if (meta) break
      }
      if (!meta) {
        throw new Error(
          rejected
            ? 'Clave incorrecta. Si es correcta, revisa que la hora de ambos equipos coincida.'
            : 'No se pudo contactar a ningún miembro del grupo.'
        )
      }
      if (meta.meta.deleted) throw new Error('Este grupo fue eliminado.')

      const g: GroupRecord = {
        id: req.id,
        meta: existing && isNewerMeta(existing.meta, meta.meta) ? existing.meta : meta.meta,
        key,
        keySince: meta.keySince,
        folder
      }
      const folderChanged = existing?.folder !== folder
      if (folderChanged || existing) this.stopEngine(req.id)
      this.store.put(g)
      this.ensureEngine(g)
      return { ok: true, group: this.view(g) }
    } catch (err) {
      return fail(err)
    }
  }

  update(req: GroupUpdateRequest): GroupOpResult {
    try {
      const g = this.store.get(req.id)
      if (!g || g.meta.deleted) throw new Error('No perteneces a ese grupo.')
      const next: GroupRecord = { ...g, meta: { ...g.meta } }
      let metaChanged = false
      let restart = false

      if (req.name !== undefined) {
        const name = cleanName(req.name)
        if (name !== g.meta.name) {
          next.meta.name = name
          metaChanged = true
        }
      }
      if (req.password !== undefined) {
        // Everyone else must type the new password: someone who knew the old one is out.
        next.key = deriveGroupKey(g.id, checkPassword(req.password))
        next.keySince = Date.now()
        restart = true
      }
      if (req.folder !== undefined) {
        const folder = realFolder(req.folder)
        if (folder !== g.folder) {
          this.assertFolderFree(folder, g.id)
          next.folder = folder
          restart = true
        }
      }
      if (metaChanged) {
        next.meta.rev = g.meta.rev + 1
        next.meta.at = Date.now()
        next.meta.by = this.opts.deviceId
      }

      const engine = this.engines.get(g.id)
      if (restart) this.stopEngine(g.id)
      this.store.put(next)
      if (restart) this.ensureEngine(next)
      else if (metaChanged) engine?.kick()
      return { ok: true, group: this.view(next) }
    } catch (err) {
      return fail(err)
    }
  }

  leave(req: GroupLeaveRequest): GroupOpResult {
    try {
      const g = this.store.get(req.id)
      if (!g) throw new Error('No perteneces a ese grupo.')
      const engine = this.engines.get(g.id)
      if (req.forEveryone) {
        // Tell members before stopping: they pull the tombstone from our meta.
        engine?.kick()
        this.stopEngine(g.id)
        this.store.put({
          ...g,
          meta: { ...g.meta, deleted: true, rev: g.meta.rev + 1, at: Date.now(), by: this.opts.deviceId }
        })
      } else {
        this.stopEngine(g.id)
        this.store.remove(g.id)
      }
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  }

  /** Name or deletion changed on a member: keep the newest (any member may manage). */
  private mergeMeta(remote: GroupMetaResponse): void {
    const g = this.store.get(remote.id)
    if (!g || !remote.meta || !isNewerMeta(remote.meta, g.meta)) return
    this.store.put({ ...g, meta: remote.meta })
    if (remote.meta.deleted) this.stopEngine(g.id)
  }

  // ── server hooks ─────────────────────────────────────────────────────────

  serverHooks(): GroupServerHooks {
    return {
      hello: () => ({ name: this.opts.deviceName, deviceId: this.opts.deviceId }),
      authorize: (id, header, method, path) => {
        const g = this.store.get(id)
        return Boolean(g && verifyGroupRequest(header, g.key, method, path))
      },
      meta: (id) => {
        const g = this.store.get(id)
        return g ? { id: g.id, meta: g.meta, keySince: g.keySince } : null
      },
      index: (id) => this.engines.get(id)?.indexResponse() ?? null,
      rootFor: (id) => (this.engines.has(id) ? this.rootFor(id) : null),
      notify: (id, deviceId) => this.engines.get(id)?.onNotify(deviceId)
    }
  }
}
