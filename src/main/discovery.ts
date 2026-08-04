import { createSocket, Socket } from 'dgram'
import { hostname } from 'os'
import {
  DISCOVERY_MAGIC,
  DISCOVERY_PORT,
  PEER_STALE_MS,
  type Peer,
  type PeerAddManualRequest,
  type PeerAddManualResult,
  type PeerAnnouncement,
  type PeerRemoveManualRequest
} from '../shared/types'
import { getLanIfaces, getLanIPv4 } from './net'

/** Admin-scoped multicast for LAN AntiShare discovery. */
export const DISCOVERY_MULTICAST = '239.255.76.67'

export type PeersListener = (peers: Peer[]) => void

export interface AnnounceState {
  name: string
  port: number
  tokenRequired: boolean
}

interface SenderEntry {
  socket: Socket
  address: string
  broadcast: string
}

/**
 * UDP discovery with split listen vs announce.
 * Listen starts with the app; announce only while sharing.
 */
export class PeerDiscovery {
  private recv: Socket | null = null
  private senders: SenderEntry[] = []
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private peers = new Map<string, Peer>()
  private manualKeys = new Set<string>()
  private listeners = new Set<PeersListener>()
  private announce: AnnounceState | null = null
  private localIps = new Set<string>()
  private listening = false
  private sendersReady = false

  /** Start UDP receive + prune (idempotent). Does not announce. */
  startListening(): void {
    if (this.listening) return
    this.listening = true
    this.refreshLocalIps()

    const recv = createSocket({ type: 'udp4', reuseAddr: true })
    this.recv = recv

    recv.on('message', (msg, rinfo) => {
      this.onMessage(msg, rinfo.address)
    })
    recv.on('error', (err) => console.error('[discovery:recv]', err.message))

    recv.bind(DISCOVERY_PORT, () => {
      try {
        recv.setMulticastTTL(1)
        recv.setMulticastLoopback(true)
        recv.addMembership(DISCOVERY_MULTICAST)
      } catch {
        /* multicast optional */
      }
      void this.setupSenders().then(() => {
        this.sendersReady = true
        if (this.announce) this.broadcast()
      })
    })

    this.pruneTimer = setInterval(() => this.prune(), 2000)
  }

  /** Begin/replace share announcements (~2s). Keeps listening. */
  setAnnounce(state: AnnounceState): void {
    this.startListening()
    this.announce = { ...state }
    this.refreshLocalIps()
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = setInterval(() => this.broadcast(), 2000)
    if (this.sendersReady) this.broadcast()
  }

  /** Stop announcing; keep UDP listen and known peers (manual + discovered). */
  clearAnnounce(): void {
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = null
    this.announce = null
  }

  /** Tear down listen + announce (app quit). */
  stopListening(): void {
    this.clearAnnounce()
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    this.listening = false
    this.sendersReady = false

    if (this.recv) {
      try {
        this.recv.dropMembership(DISCOVERY_MULTICAST)
      } catch {
        /* ignore */
      }
      try {
        this.recv.close()
      } catch {
        /* ignore */
      }
      this.recv = null
    }
    for (const s of this.senders) {
      try {
        s.socket.close()
      } catch {
        /* ignore */
      }
    }
    this.senders = []
    this.peers.clear()
    this.manualKeys.clear()
    this.emit()
  }

  /** @deprecated use startListening + setAnnounce */
  start(announce: AnnounceState): void {
    this.startListening()
    this.setAnnounce(announce)
  }

  /** @deprecated use clearAnnounce or stopListening */
  stop(): void {
    this.stopListening()
  }

  list(): Peer[] {
    return Array.from(this.peers.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Whether UDP discovery receive is active. */
  isListening(): boolean {
    return this.listening && this.recv !== null
  }

  /** True when the recv socket has successfully bound (port available). */
  isRecvBound(): boolean {
    if (!this.recv) return false
    try {
      const addr = this.recv.address()
      return typeof addr === 'object' && addr.port === DISCOVERY_PORT
    } catch {
      return false
    }
  }

  onUpdate(cb: PeersListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  async addManual(req: PeerAddManualRequest): Promise<PeerAddManualResult> {
    const host = (req.host || '').trim().replace(/^\[|\]$/g, '')
    const port = Number(req.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'Invalid host or port' }
    }

    const baseUrl = `http://${host}:${port}`
    let tokenRequired = Boolean(req.tokenRequired)
    let name = `${host}:${port}`

    try {
      const headers: Record<string, string> = {}
      if (req.token) headers['X-Share-Token'] = req.token
      const res = await fetch(`${baseUrl}/api/list?path=`, {
        headers,
        signal: AbortSignal.timeout(4000)
      })
      if (res.status === 401) {
        tokenRequired = true
      } else if (!res.ok) {
        return { ok: false, error: `Probe failed: HTTP ${res.status}` }
      } else {
        tokenRequired = Boolean(req.tokenRequired)
      }
    } catch (e) {
      // Fallback: try HEAD /
      try {
        const res = await fetch(baseUrl + '/', {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000)
        })
        if (res.status === 401) tokenRequired = true
        else if (!res.ok && res.status !== 405) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : `Unreachable ${baseUrl}`
          }
        }
      } catch (e2) {
        return {
          ok: false,
          error: e2 instanceof Error ? e2.message : `Unreachable ${baseUrl}`
        }
      }
    }

    try {
      const hostnameRes = await fetch(`${baseUrl}/`, {
        headers: req.token ? { 'X-Share-Token': req.token } : {},
        signal: AbortSignal.timeout(2000)
      })
      if (hostnameRes.ok) {
        name = host
      }
    } catch {
      /* keep default name */
    }

    const peer: Peer = {
      name,
      host,
      port,
      tokenRequired,
      lastSeen: Date.now(),
      baseUrl,
      manual: true
    }
    const key = peerKey(host, port)
    this.manualKeys.add(key)
    this.peers.set(key, peer)
    this.emit()
    return { ok: true, peer }
  }

  removeManual(req: PeerRemoveManualRequest): { ok: boolean } {
    const key = peerKey(req.host.trim(), Number(req.port))
    this.manualKeys.delete(key)
    const existed = this.peers.delete(key)
    if (existed) this.emit()
    return { ok: true }
  }

  private async setupSenders(): Promise<void> {
    for (const s of this.senders) {
      try {
        s.socket.close()
      } catch {
        /* ignore */
      }
    }
    this.senders = []

    const ifaces = getLanIfaces()
    const bindList =
      ifaces.length > 0
        ? ifaces
        : [{ address: '0.0.0.0', netmask: '0.0.0.0', broadcast: '255.255.255.255' }]

    await Promise.all(
      bindList.map(
        (iface) =>
          new Promise<void>((resolve) => {
            const s = createSocket({ type: 'udp4' })
            s.on('error', () => resolve())
            const bindAddr = iface.address === '0.0.0.0' ? undefined : iface.address
            s.bind({ address: bindAddr, port: 0 }, () => {
              try {
                s.setBroadcast(true)
                s.setMulticastTTL(1)
                s.setMulticastLoopback(true)
              } catch {
                /* ignore */
              }
              this.senders.push({
                socket: s,
                address: iface.address,
                broadcast: iface.broadcast
              })
              resolve()
            })
          })
      )
    )
  }

  private refreshLocalIps(): void {
    this.localIps = new Set(getLanIPv4())
    this.localIps.add('127.0.0.1')
  }

  private emit(): void {
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  private broadcast(): void {
    if (!this.announce || !this.sendersReady) return
    this.refreshLocalIps()

    const fallbackHost = getLanIPv4()[0] || '127.0.0.1'
    const base: PeerAnnouncement & { magic: string } = {
      magic: DISCOVERY_MAGIC,
      name: this.announce.name || hostname(),
      host: fallbackHost,
      port: this.announce.port,
      tokenRequired: this.announce.tokenRequired
    }

    for (const sender of this.senders) {
      const host =
        sender.address && sender.address !== '0.0.0.0' ? sender.address : fallbackHost
      const buf = Buffer.from(JSON.stringify({ ...base, host }), 'utf8')
      const targets = new Set<string>([
        DISCOVERY_MULTICAST,
        '255.255.255.255',
        sender.broadcast
      ])
      for (const target of targets) {
        if (!target) continue
        try {
          sender.socket.send(buf, 0, buf.length, DISCOVERY_PORT, target)
        } catch {
          /* ignore EHOSTUNREACH etc. */
        }
      }
    }
  }

  private isSelf(host: string, port: number): boolean {
    if (!this.announce) return false
    if (port !== this.announce.port) return false
    // Only skip our own announce (local IP + our share port).
    // Remote peers on the same port number must not be filtered.
    return this.localIps.has(host) || host === '127.0.0.1'
  }

  private upsertPeer(peer: Peer): void {
    if (this.isSelf(peer.host, peer.port)) return
    const key = peerKey(peer.host, peer.port)
    const prev = this.peers.get(key)
    if (prev?.manual) {
      peer = { ...peer, manual: true }
      this.manualKeys.add(key)
    }
    this.peers.set(key, peer)
    this.emit()
  }

  private onMessage(msg: Buffer, fromHost: string): void {
    try {
      const data = JSON.parse(msg.toString('utf8')) as PeerAnnouncement & { magic?: string }
      if (data.magic !== DISCOVERY_MAGIC) return
      if (typeof data.port !== 'number' || !data.name) return

      const host = data.host || fromHost
      if (this.isSelf(host, data.port)) return

      this.upsertPeer({
        name: data.name,
        host,
        port: data.port,
        tokenRequired: Boolean(data.tokenRequired),
        lastSeen: Date.now(),
        baseUrl: `http://${host}:${data.port}`
      })
    } catch {
      /* ignore malformed */
    }
  }

  private prune(): void {
    const now = Date.now()
    let changed = false
    for (const [key, peer] of this.peers) {
      if (this.manualKeys.has(key)) {
        // Manual peers stay until removeManual; refresh lastSeen lightly.
        continue
      }
      if (now - peer.lastSeen > PEER_STALE_MS) {
        this.peers.delete(key)
        changed = true
      }
    }
    if (changed) this.emit()
  }
}

function peerKey(host: string, port: number): string {
  return `${host}:${port}`
}
