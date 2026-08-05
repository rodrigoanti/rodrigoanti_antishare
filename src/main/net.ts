import { networkInterfaces, type NetworkInterfaceInfo } from 'os'

export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 0
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** Directed broadcast for addr/netmask (typically x.x.x.255 on /24). */
export function subnetBroadcast(address: string, netmask: string): string | null {
  const a = ipv4ToInt(address)
  const m = ipv4ToInt(netmask)
  if (!a || !m) return null
  return intToIpv4((a & m) | (~m >>> 0))
}

/** Trim, strip `[…]`, map `::ffff:a.b.c.d` → IPv4. */
export function normalizeHost(host: string | undefined | null): string {
  if (host == null) return ''
  let h = host.trim()
  if (!h) return ''
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1).trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h)
  if (mapped) return mapped[1]
  return h
}

export function isLoopbackIPv4(ip: string): boolean {
  const h = normalizeHost(ip)
  return h === '127.0.0.1' || h.startsWith('127.') || h === '::1' || h.toLowerCase() === 'localhost'
}

export function isUnspecifiedIPv4(ip: string): boolean {
  const h = normalizeHost(ip)
  return h === '0.0.0.0'
}

/** 169.254.0.0/16 (APIPA / link-local). */
export function isLinkLocalIPv4(ip: string): boolean {
  return (ipv4ToInt(ip) >>> 16) === ((169 << 8) | 254)
}

/** RFC1918 private ranges: 10/8, 172.16/12, 192.168/16. */
export function isRfc1918IPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (!n && ip !== '0.0.0.0') return false
  const a = n >>> 24
  const b = (n >>> 16) & 255
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Hosts that must never be advertised as a reachable share address. */
export function isUnusableAnnounceHost(ip: string | undefined | null): boolean {
  const trimmed = normalizeHost(ip)
  if (!trimmed) return true
  return isLoopbackIPv4(trimmed) || isUnspecifiedIPv4(trimmed)
}

/** Prefer announced LAN host; if missing/loopback/unspecified, use UDP source. */
export function resolveAnnounceHost(
  announced: string | undefined | null,
  fromHost: string
): string {
  const host = normalizeHost(announced)
  const from = normalizeHost(fromHost)
  if (!host || isUnusableAnnounceHost(host)) return from
  return host
}

/** True when host shares iface's prefix (address ∧ netmask). Not a fixed /24. */
export function sameSubnetIPv4(host: string, ifaceAddress: string, netmask: string): boolean {
  const h = ipv4ToInt(normalizeHost(host))
  const a = ipv4ToInt(normalizeHost(ifaceAddress))
  const m = ipv4ToInt(netmask)
  if (!h || !a || !m) return false
  return (h & m) === (a & m)
}

export function hostOnLocalSubnet(
  host: string,
  localIfaces: Array<Pick<LanIface, 'address' | 'netmask'>>
): boolean {
  const h = normalizeHost(host)
  if (!h || isUnusableAnnounceHost(h)) return false
  return localIfaces.some((iface) => sameSubnetIPv4(h, iface.address, iface.netmask))
}

/** Local iface IPv4 whose subnet contains `host`, if any. */
export function localAddressForPeer(host: string): string | undefined {
  const h = normalizeHost(host)
  if (!h || isUnusableAnnounceHost(h)) return undefined
  for (const iface of getLanIfaces()) {
    if (sameSubnetIPv4(h, iface.address, iface.netmask)) return iface.address
  }
  return undefined
}

/**
 * Primary peer IP: (1) UDP source (2) same subnet as best local iface (3) announced.
 *
 * The UDP source wins because it is the only address that provably delivered a packet
 * here: two separate LANs behind different routers can both number 192.168.100.0/24,
 * so a same-subnet announced IP may belong to a host that never answers ARP.
 * Never loopback / 0.0.0.0.
 */
export function pickPeerPrimary(
  candidates: Array<string | undefined | null>,
  fromHost: string | undefined | null,
  localIfaces: Array<Pick<LanIface, 'address' | 'netmask'>>
): string {
  const from = normalizeHost(fromHost)
  const fromUsable = from && !isUnusableAnnounceHost(from) ? from : ''
  if (fromUsable) return fromUsable

  const pool = uniqueHosts(candidates).filter((h) => !isUnusableAnnounceHost(h))
  for (const iface of localIfaces) {
    const hit = pool.filter((h) => sameSubnetIPv4(h, iface.address, iface.netmask))
    if (hit.length > 0) return hit[0]
  }
  return pool[0] || ''
}

/** Preferred local subnet first, then other candidates (no loopback). */
export function rankPeerHosts(
  candidates: Array<string | undefined | null>,
  fromHost: string | undefined | null,
  localIfaces: Array<Pick<LanIface, 'address' | 'netmask'>>
): string[] {
  const primary = pickPeerPrimary(candidates, fromHost, localIfaces)
  const rest = uniqueHosts([...candidates, fromHost]).filter(
    (h) => h !== primary && !isUnusableAnnounceHost(h)
  )
  const ordered: string[] = []
  const seen = new Set<string>()
  const push = (h: string): void => {
    if (!h || seen.has(h) || isUnusableAnnounceHost(h)) return
    seen.add(h)
    ordered.push(h)
  }
  push(primary)
  for (const iface of localIfaces) {
    for (const h of rest) {
      if (sameSubnetIPv4(h, iface.address, iface.netmask)) push(h)
    }
  }
  for (const h of rest) push(h)
  return ordered
}

/** Every IPv4 on this machine, including loopback and virtual/excluded NICs. */
export function getAllLocalIPv4(): string[] {
  const nets = networkInterfaces()
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of Object.keys(nets)) {
    const entries = nets[name]
    if (!entries) continue
    for (const e of entries) {
      const family = String(e.family)
      if (family !== 'IPv4' && family !== '4') continue
      const addr = normalizeHost(e.address)
      if (!addr || seen.has(addr)) continue
      seen.add(addr)
      out.push(addr)
    }
  }
  return out
}

export function isLocalHostAddress(host: string, localIps: ReadonlySet<string>): boolean {
  const h = normalizeHost(host)
  if (!h) return false
  if (isLoopbackIPv4(h) || isUnspecifiedIPv4(h)) return true
  return localIps.has(h)
}

export function uniqueHosts(hosts: Array<string | undefined | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of hosts) {
    const h = normalizeHost(raw)
    if (!h || seen.has(h)) continue
    seen.add(h)
    out.push(h)
  }
  return out
}

export type IfaceNameClass = 'preferred' | 'normal' | 'virtual' | 'excluded'

const EXCLUDED_IFACE =
  /^(lo\d*|utun\d*|awdl\d*|llw\d*|bridge\d*|vmnet\d*|vboxnet\d*|vnic\d*|docker\d*|br-.*|veth.*|cni.*|flannel.*|virbr\d*|tun\d*|tap\d*|gif\d*|stf\d*|anpi\d*|ap\d+|ipsec.*|ppp\d*|zt\d*|wg\d*|tailscale\d*)$/i

const EXCLUDED_IFACE_SUBSTR =
  /vethernet|hyper-?v|virtualbox|vmware|\bwsl\b|bluetooth|loopback|pseudo-interface/i

const PREFERRED_IFACE =
  /^(en\d+|en[psox]\w*|eth\w*|wlan\w*|wlp\w*|wlo\w*|wi-?fi\b.*|wifi\b.*|ethernet\b.*|local area connection.*)$/i

const VIRTUAL_IFACE =
  /^(utun|awdl|llw|bridge|vmnet|vbox|docker|veth|virbr|tun|tap|zt|wg|tailscale)/i

/** Classify a NIC name for LAN selection (pure / testable). */
export function classifyIfaceName(name: string): IfaceNameClass {
  const n = name.trim()
  if (!n) return 'excluded'
  if (EXCLUDED_IFACE.test(n) || EXCLUDED_IFACE_SUBSTR.test(n)) return 'excluded'
  if (PREFERRED_IFACE.test(n)) return 'preferred'
  if (VIRTUAL_IFACE.test(n) || /vpn|tunnel|tap|tun|virtual|vmnet|bridge/i.test(n)) return 'virtual'
  return 'normal'
}

export interface LanIface {
  address: string
  netmask: string
  broadcast: string
  name: string
}

export function scoreLanIface(name: string, address: string): number {
  const cls = classifyIfaceName(name)
  let score = 0
  if (cls === 'preferred') score += 100
  else if (cls === 'normal') score += 50
  else if (cls === 'virtual') score += 10
  else return -1
  if (isRfc1918IPv4(address)) score += 20
  else if (isLinkLocalIPv4(address)) score += 0
  else score += 5
  return score
}

type NetMap = NodeJS.Dict<NetworkInterfaceInfo[] | undefined>

/** Pure selection over a `networkInterfaces()` snapshot. */
export function selectLanIfaces(nets: NetMap): LanIface[] {
  const out: LanIface[] = []
  for (const name of Object.keys(nets)) {
    if (classifyIfaceName(name) === 'excluded') continue
    const entries = nets[name]
    if (!entries) continue
    for (const e of entries) {
      const family = String(e.family)
      if ((family !== 'IPv4' && family !== '4') || e.internal) continue
      if (isUnusableAnnounceHost(e.address)) continue
      const broadcast = subnetBroadcast(e.address, e.netmask) || e.address.replace(/\.\d+$/, '.255')
      out.push({ name, address: e.address, netmask: e.netmask, broadcast })
    }
  }
  out.sort((a, b) => {
    const diff = scoreLanIface(b.name, b.address) - scoreLanIface(a.name, a.address)
    if (diff !== 0) return diff
    return a.address.localeCompare(b.address)
  })
  return out
}

/** Non-internal IPv4 LAN interfaces, preferred NICs first, RFC1918 before 169.254. */
export function getLanIfaces(): LanIface[] {
  return selectLanIfaces(networkInterfaces())
}

/** Collect non-internal IPv4 addresses (LAN), best first. */
export function getLanIPv4(): string[] {
  return getLanIfaces().map((i) => i.address)
}

/**
 * Another IPv4 on a local subnet for TCC LAN probes.
 * Prefers gateway .1, then a different host octet. Never self/loopback.
 */
export function pickLanProbeTarget(): string | null {
  const self = new Set<string>([...getAllLocalIPv4(), '127.0.0.1', '0.0.0.0', '::1'])
  const usable = (ip: string, iface: LanIface): boolean => {
    if (!ip || self.has(ip) || isLoopbackIPv4(ip) || isUnspecifiedIPv4(ip)) return false
    return sameSubnetIPv4(ip, iface.address, iface.netmask)
  }

  for (const iface of getLanIfaces()) {
    const addr = ipv4ToInt(iface.address)
    const mask = ipv4ToInt(iface.netmask)
    if (!addr || !mask) continue
    const network = (addr & mask) >>> 0
    const bcast = (network | (~mask >>> 0)) >>> 0
    const candidates = [
      (network + 1) >>> 0,
      (addr + 1) >>> 0,
      (addr - 1) >>> 0,
      (network + 2) >>> 0,
      (bcast - 1) >>> 0
    ]
    for (const n of candidates) {
      if (n === network || n === bcast) continue
      const ip = intToIpv4(n)
      if (usable(ip, iface)) return ip
    }
  }

  return self.has('192.168.0.1') ? null : '192.168.0.1'
}

export function buildShareUrls(port: number): { localhost: string; lan: string[]; all: string[] } {
  const localhost = `http://127.0.0.1:${port}`
  const lan = getLanIPv4().map((ip) => `http://${ip}:${port}`)
  return { localhost, lan, all: [localhost, ...lan] }
}
