/**
 * In-memory table of peers seen over UDP discovery.
 *
 * Peers are never persisted: a peer exists only while it keeps announcing. Records are
 * rebuilt from each announcement instead of merged with the previous one, so an address
 * the peer no longer advertises cannot come back to life.
 */
import { PEER_STALE_MS, type AnnouncedGroup, type Peer } from '../shared/types'
import { normalizeHost, pickPeerPrimary, rankPeerHosts, uniqueHosts, type LanIface } from './net'

/** One announcement as received: payload fields plus the UDP source address. */
export interface PeerObservation {
  name: string
  port: number
  tokenRequired: boolean
  /** `host` from the payload. */
  announcedHost?: string
  /** `hosts[]` from the payload (every LAN IPv4 the announcer currently has). */
  announcedHosts?: string[]
  /** UDP source address (the only address with proven delivery). */
  fromHost?: string
  at?: number
  groups?: AnnouncedGroup[]
}

/** Keep only well-formed group entries from an (untrusted) announcement. */
export function sanitizeGroups(raw: unknown): AnnouncedGroup[] {
  if (!Array.isArray(raw)) return []
  const out: AnnouncedGroup[] = []
  for (const g of raw.slice(0, 64)) {
    const r = g as AnnouncedGroup
    if (!r || typeof r.id !== 'string' || !/^[0-9a-f]{6,64}$/.test(r.id)) continue
    if (typeof r.name !== 'string' || typeof r.keySince !== 'number') continue
    out.push({
      id: r.id,
      name: r.name.slice(0, 80),
      keySince: r.keySince,
      ...(r.deleted ? { deleted: true } : {})
    })
  }
  return out
}

export function peerKey(host: string, port: number): string {
  return `${host}:${port}`
}

export function isPeerExpired(peer: Peer, now: number, ttlMs: number): boolean {
  return now - peer.lastSeen > ttlMs
}

/**
 * Build a peer record from a single observation. An announcement carries every address
 * the announcer has, so it is authoritative on its own: nothing is carried over from a
 * previous record. Returns null when no usable (non-loopback) address is available.
 */
export function buildPeerRecord(
  obs: PeerObservation,
  localIfaces: Array<Pick<LanIface, 'address' | 'netmask'>>
): Peer | null {
  const name = String(obs.name || '').trim()
  const port = Number(obs.port)
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return null

  const from = normalizeHost(obs.fromHost)
  const candidates = uniqueHosts([obs.announcedHost, from, ...(obs.announcedHosts ?? [])])
  const host = pickPeerPrimary(candidates, from, localIfaces)
  if (!host) return null

  const hosts = rankPeerHosts(candidates, from, localIfaces)
  return {
    name,
    host,
    port,
    tokenRequired: Boolean(obs.tokenRequired),
    lastSeen: obs.at ?? Date.now(),
    baseUrl: `http://${host}:${port}`,
    hosts: hosts.length > 0 ? hosts : [host],
    ...(obs.groups && obs.groups.length > 0 ? { groups: obs.groups } : {})
  }
}

/** Fields the UI renders; lastSeen alone must not trigger a peers:onUpdate. */
function contentChanged(a: Peer, b: Peer): boolean {
  return (
    a.name !== b.name ||
    a.host !== b.host ||
    a.port !== b.port ||
    a.baseUrl !== b.baseUrl ||
    a.tokenRequired !== b.tokenRequired ||
    (a.hosts ?? []).join(',') !== (b.hosts ?? []).join(',') ||
    JSON.stringify(a.groups ?? []) !== JSON.stringify(b.groups ?? [])
  )
}

export class PeerTable {
  private peers = new Map<string, Peer>()
  readonly ttlMs: number

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? PEER_STALE_MS
  }

  /**
   * Record an announcement. Returns true when the visible peer list changed, so callers
   * do not push an update on every keep-alive packet.
   */
  ingest(
    obs: PeerObservation,
    localIfaces: Array<Pick<LanIface, 'address' | 'netmask'>>
  ): boolean {
    const record = buildPeerRecord(obs, localIfaces)
    if (!record) return false
    return this.ingestRecord(record)
  }

  /** Store an already-built record (callers that must inspect it first, e.g. self-filter). */
  ingestRecord(record: Peer): boolean {
    // Resolve existing peer before keying on primary — multi-NIC peers send one
    // UDP packet per interface, and pickPeerPrimary follows fromHost each time.
    const provisionalKey = peerKey(record.host, record.port)
    const matchKey = this.findExistingKey(record, provisionalKey)
    const prev = matchKey ? this.peers.get(matchKey) : undefined

    let sticky = record
    if (prev && record.host !== prev.host) {
      const candidates = uniqueHosts([record.host, ...(record.hosts ?? [])])
      if (candidates.includes(prev.host)) {
        // Same peer, different NIC packet: keep the sticky primary.
        sticky = {
          ...record,
          host: prev.host,
          baseUrl: `http://${prev.host}:${record.port}`,
          hosts: uniqueHosts([prev.host, ...candidates])
        }
      }
      // else: prev.host left the candidate set — allow the primary to move.
    }

    const key = peerKey(sticky.host, sticky.port)

    if (matchKey && matchKey !== key) {
      // Same peer on a new address: drop the old entry so the dead IP disappears at once.
      this.peers.delete(matchKey)
    }

    this.peers.set(key, sticky)
    return !prev || contentChanged(prev, sticky)
  }

  /**
   * Existing entry for this record: exact address, then any shared address, then the same
   * name on the same port (the announcer kept its identity but changed IP).
   */
  private findExistingKey(record: Peer, key: string): string | undefined {
    if (this.peers.has(key)) return key
    const addresses = new Set(uniqueHosts([record.host, ...(record.hosts ?? [])]))
    for (const [k, peer] of this.peers) {
      if (peer.port !== record.port) continue
      const known = uniqueHosts([peer.host, ...(peer.hosts ?? [])])
      if (known.some((h) => addresses.has(h))) return k
    }
    for (const [k, peer] of this.peers) {
      if (peer.port === record.port && peer.name === record.name) return k
    }
    return undefined
  }

  /** Reachable peers only: expired discovered peers are never returned. */
  list(now: number = Date.now()): Peer[] {
    return Array.from(this.peers.values())
      .filter((peer) => !isPeerExpired(peer, now, this.ttlMs))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Delete expired discovered peers. Returns true when something was removed. */
  prune(now: number = Date.now()): boolean {
    let changed = false
    for (const [key, peer] of this.peers) {
      if (isPeerExpired(peer, now, this.ttlMs)) {
        this.peers.delete(key)
        changed = true
      }
    }
    return changed
  }

  /** Drop peers matching `predicate`. */
  forget(predicate: (peer: Peer, key: string) => boolean): boolean {
    let changed = false
    for (const [key, peer] of this.peers) {
      if (predicate(peer, key)) {
        this.peers.delete(key)
        changed = true
      }
    }
    return changed
  }

  clear(): void {
    this.peers.clear()
  }

  get size(): number {
    return this.peers.size
  }
}
