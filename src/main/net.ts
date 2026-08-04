import { networkInterfaces, type NetworkInterfaceInfo } from 'os'

function ipv4ToInt(ip: string): number {
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

export interface LanIface {
  address: string
  netmask: string
  broadcast: string
}

/** Non-internal IPv4 interfaces with subnet broadcast. */
export function getLanIfaces(): LanIface[] {
  const nets = networkInterfaces()
  const out: LanIface[] = []
  for (const key of Object.keys(nets)) {
    const entries = nets[key] as NetworkInterfaceInfo[] | undefined
    if (!entries) continue
    for (const e of entries) {
      const family = String(e.family)
      if ((family === 'IPv4' || family === '4') && !e.internal) {
        const broadcast = subnetBroadcast(e.address, e.netmask) || e.address.replace(/\.\d+$/, '.255')
        out.push({ address: e.address, netmask: e.netmask, broadcast })
      }
    }
  }
  return out
}

/** Collect non-internal IPv4 addresses (LAN). */
export function getLanIPv4(): string[] {
  return getLanIfaces().map((i) => i.address)
}

export function buildShareUrls(port: number): { localhost: string; lan: string[]; all: string[] } {
  const localhost = `http://127.0.0.1:${port}`
  const lan = getLanIPv4().map((ip) => `http://${ip}:${port}`)
  return { localhost, lan, all: [localhost, ...lan] }
}
