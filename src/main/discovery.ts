import { createSocket, Socket } from 'dgram'
import { hostname } from 'os'
import {
  DISCOVERY_MAGIC,
  DISCOVERY_PORT,
  type Peer,
  type PeerAddManualRequest,
  type PeerAddManualResult,
  type PeerAnnouncement,
  type PeerRemoveManualRequest
} from '../shared/types'
import {
  getAllLocalIPv4,
  getLanIfaces,
  getLanIPv4,
  isLocalHostAddress,
  isUnusableAnnounceHost,
  normalizeHost,
  uniqueHosts,
  type LanIface
} from './net'
import { PeerTable, buildPeerRecord } from './peerTable'
import { classifyPeerNetworkError, peerHttp } from './remote'

/** Admin-scoped multicast for LAN AntiShare discovery. */
export const DISCOVERY_MULTICAST = '239.255.76.67'

/** Push peers to the renderer at most this often while nothing but lastSeen changes. */
const EMIT_HEARTBEAT_MS = 5000

export type PeersListener = (peers: Peer[]) => void

export interface AnnounceState {
  name: string
  port: number
  tokenRequired: boolean
  /**
   * Checked before every packet: announcing a port nobody is listening on turns this
   * machine into a phantom peer for everyone else on the LAN.
   */
  isServing?: () => boolean
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
  private table = new PeerTable()
  private listeners = new Set<PeersListener>()
  private lastEmitAt = 0
  private announce: AnnounceState | null = null
  private localIps = new Set<string>()
  private listening = false
  private sendersReady = false
  private ifaceFingerprint = ''
  private memberships: string[] = []
  private networkRefresh: Promise<void> | null = null

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

    recv.bind({ port: DISCOVERY_PORT, address: '0.0.0.0' }, () => {
      try {
        recv.setMulticastTTL(1)
        recv.setMulticastLoopback(false)
      } catch {
        /* multicast optional */
      }
      void this.refreshNetwork(true).then(() => {
        if (this.announce) this.broadcast()
      })
    })

    this.pruneTimer = setInterval(() => {
      void this.refreshNetwork(false)
      if (this.table.prune()) {
        this.emit()
        return
      }
      // Keep-alive: refresh lastSeen in the renderer without an update per packet.
      if (this.table.size > 0 && Date.now() - this.lastEmitAt >= EMIT_HEARTBEAT_MS) this.emit()
    }, 2000)
  }

  /** Begin/replace share announcements (~2s). Keeps listening. */
  setAnnounce(state: AnnounceState): void {
    this.startListening()
    if (state.isServing && !state.isServing()) {
      console.warn('[discovery] announce skipped: share server is not listening')
      return
    }
    this.announce = { ...state }
    this.refreshLocalIps()
    this.forgetSelfPeers('', '', state.port)
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = setInterval(() => this.broadcast(), 2000)
    void this.refreshNetwork(true).then(() => this.broadcast())
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
    this.ifaceFingerprint = ''

    if (this.recv) {
      this.dropMulticastMemberships()
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
    this.table.clear()
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

  /** Peers currently reachable by discovery; expired ones are excluded, not just unsorted. */
  list(): Peer[] {
    return this.table.list()
  }

  /** Peer TTL in ms (no announce within this window ⇒ dropped). */
  get peerTtlMs(): number {
    return this.table.ttlMs
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
    const host = normalizeHost(req.host)
    const port = Number(req.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'Invalid host or port' }
    }

    const baseUrl = `http://${host}:${port}`
    let tokenRequired = Boolean(req.tokenRequired)
    let name = `${host}:${port}`

    // Single probe through the same client as remoteList (IPv4 + localAddress). A HEAD
    // fallback here used to swallow the transport error and report "fetch failed".
    try {
      const res = await peerHttp(`${baseUrl}/api/list?path=`, {
        headers: req.token ? { 'X-Share-Token': req.token } : {},
        timeoutMs: 4000
      })
      if (res.status === 401) {
        tokenRequired = true
      } else if (!res.ok) {
        return { ok: false, error: `El peer respondió HTTP ${res.status} en ${baseUrl}/api/list.` }
      } else {
        tokenRequired = Boolean(req.tokenRequired)
      }
      name = host
    } catch (e) {
      return { ok: false, error: classifyPeerNetworkError(e, { host, port, baseUrl }) }
    }

    const peer: Peer = {
      name,
      host,
      port,
      tokenRequired,
      lastSeen: Date.now(),
      baseUrl,
      hosts: [host],
      manual: true
    }
    this.table.setManual(peer)
    this.emit()
    return { ok: true, peer }
  }

  removeManual(req: PeerRemoveManualRequest): { ok: boolean } {
    if (this.table.removeManual(req.host, Number(req.port))) this.emit()
    return { ok: true }
  }

  private ifaceSnapshot(): string {
    return getLanIfaces()
      .map((i) => `${i.name}=${i.address}/${i.netmask}/${i.broadcast}`)
      .sort()
      .join('|')
  }

  private async refreshNetwork(force: boolean): Promise<void> {
    if (this.networkRefresh) {
      await this.networkRefresh
      if (!force) {
        const fp = this.ifaceSnapshot()
        if (fp === this.ifaceFingerprint && this.sendersReady) return
      }
    }

    const fp = this.ifaceSnapshot()
    if (!force && fp === this.ifaceFingerprint && this.sendersReady) return

    const work = (async () => {
      this.ifaceFingerprint = this.ifaceSnapshot()
      this.refreshLocalIps()
      await this.setupSenders()
      this.refreshMulticastMembership()
      this.sendersReady = true
    })()

    this.networkRefresh = work
    try {
      await work
    } finally {
      if (this.networkRefresh === work) this.networkRefresh = null
    }
  }

  private dropMulticastMemberships(): void {
    if (!this.recv) {
      this.memberships = []
      return
    }
    for (const addr of this.memberships) {
      try {
        if (addr) this.recv.dropMembership(DISCOVERY_MULTICAST, addr)
        else this.recv.dropMembership(DISCOVERY_MULTICAST)
      } catch {
        /* ignore */
      }
    }
    this.memberships = []
  }

  private refreshMulticastMembership(): void {
    if (!this.recv) return
    this.dropMulticastMemberships()
    const ifaces = getLanIfaces()
    if (ifaces.length === 0) {
      try {
        this.recv.addMembership(DISCOVERY_MULTICAST)
        this.memberships.push('')
      } catch {
        /* multicast optional */
      }
      return
    }
    for (const iface of ifaces) {
      try {
        this.recv.addMembership(DISCOVERY_MULTICAST, iface.address)
        this.memberships.push(iface.address)
      } catch {
        /* ignore per-iface join failures */
      }
    }
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
    const bindList: LanIface[] =
      ifaces.length > 0
        ? ifaces
        : [
            {
              name: '*',
              address: '0.0.0.0',
              netmask: '0.0.0.0',
              broadcast: '255.255.255.255'
            }
          ]

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
                s.setMulticastLoopback(false)
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
    this.localIps = new Set(getAllLocalIPv4().map((ip) => normalizeHost(ip)))
    this.localIps.add('127.0.0.1')
    this.localIps.add('0.0.0.0')
  }

  private emit(): void {
    this.lastEmitAt = Date.now()
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  private usableAnnounceHost(candidate: string | undefined): string | undefined {
    if (!candidate || isUnusableAnnounceHost(candidate)) return undefined
    return candidate
  }

  private broadcast(): void {
    if (!this.announce) return
    if (!this.sendersReady || this.ifaceSnapshot() !== this.ifaceFingerprint) {
      void this.refreshNetwork(true).then(() => this.sendAnnouncePackets())
      return
    }
    this.sendAnnouncePackets()
  }

  private sendAnnouncePackets(): void {
    if (!this.announce || !this.sendersReady) return
    if (this.announce.isServing && !this.announce.isServing()) {
      // Share went away (stopped or crashed): stop advertising a dead port.
      this.clearAnnounce()
      return
    }
    this.refreshLocalIps()

    const allHosts = getLanIPv4().filter((h) => this.usableAnnounceHost(h))
    const lanFallback = allHosts[0]

    for (const sender of this.senders) {
      const host = this.usableAnnounceHost(sender.address) ?? lanFallback
      const payload: PeerAnnouncement & { magic: string } = {
        magic: DISCOVERY_MAGIC,
        name: this.announce.name || hostname(),
        port: this.announce.port,
        tokenRequired: this.announce.tokenRequired,
        ...(host ? { host } : {}),
        ...(allHosts.length > 0 ? { hosts: allHosts } : {})
      }
      const buf = Buffer.from(JSON.stringify(payload), 'utf8')
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

  /** Own announce echo: same share port and local/loopback/unspecified source or payload host. */
  private isSelfPacket(announcedHost: string, fromHost: string, port: number): boolean {
    if (!this.announce) return false
    if (port !== this.announce.port) return false
    return (
      isLocalHostAddress(fromHost, this.localIps) ||
      isLocalHostAddress(announcedHost, this.localIps)
    )
  }

  private forgetSelfPeers(announcedHost: string, fromHost: string, port: number): void {
    if (!this.announce || port !== this.announce.port) return
    const changed = this.table.forget((peer) => {
      if (peer.port !== port) return false
      const peerHosts = uniqueHosts([peer.host, ...(peer.hosts ?? [])])
      return (
        peerHosts.some((ph) => isLocalHostAddress(ph, this.localIps)) ||
        (Boolean(announcedHost) && peerHosts.includes(announcedHost)) ||
        (Boolean(fromHost) && peerHosts.includes(fromHost))
      )
    })
    if (changed) this.emit()
  }

  private onMessage(msg: Buffer, fromHost: string): void {
    try {
      const data = JSON.parse(msg.toString('utf8')) as PeerAnnouncement & { magic?: string }
      if (data.magic !== DISCOVERY_MAGIC) return
      if (typeof data.port !== 'number' || !data.name) return

      this.refreshLocalIps()
      const announced = normalizeHost(data.host)
      const from = normalizeHost(fromHost)
      const announcedHosts = Array.isArray(data.hosts)
        ? data.hosts.filter((h): h is string => typeof h === 'string')
        : []
      if (this.isSelfPacket(announced, from, data.port)) {
        this.forgetSelfPeers(announced, from, data.port)
        return
      }

      const record = buildPeerRecord(
        {
          name: data.name,
          port: data.port,
          tokenRequired: Boolean(data.tokenRequired),
          announcedHost: announced,
          announcedHosts,
          fromHost: from,
          at: Date.now()
        },
        getLanIfaces()
      )
      if (!record) return
      if (this.isSelfPacket(record.host, from, record.port)) {
        this.forgetSelfPeers(record.host, from, record.port)
        return
      }
      if (this.table.ingestRecord(record)) this.emit()
    } catch {
      /* ignore malformed */
    }
  }
}
