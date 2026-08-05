import type { ReactElement } from 'react'
import { isClearBackendMessage } from '../api'
import { Alert } from '../ui'

interface PeerReachabilityAlertProps {
  host: string
  baseUrl: string
  /** Alternate LAN IPv4s for the same peer (`peer.hosts`). */
  hosts?: string[]
  /** This machine's LAN IPs, when known (from share URLs). */
  localHosts?: string[]
  /** Original backend / IPC message, shown when already clear. */
  detail?: string | null
}

function hostnameOnly(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      return new URL(trimmed).hostname.replace(/^\[|\]$/g, '')
    }
  } catch {
    /* fall through */
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end > 0) return trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

function uniqueHostnames(values: Array<string | undefined | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    if (!raw) continue
    const host = hostnameOnly(raw)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

function ipv4Prefix24(ip: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}`
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function lanHostsFromShareUrls(urls: string[] | undefined): string[] {
  return uniqueHostnames(urls ?? []).filter((h) => !isLoopbackHost(h))
}

export function PeerReachabilityAlert({
  host,
  baseUrl,
  hosts,
  localHosts,
  detail
}: PeerReachabilityAlertProps): ReactElement {
  const origin = baseUrl.replace(/\/+$/, '')
  const curl = `curl ${origin}/api/list`
  const backendNote = detail && isClearBackendMessage(detail) ? detail.trim() : null
  const peerIps = uniqueHostnames([host, origin, ...(hosts ?? [])])
  const localIps = uniqueHostnames(localHosts ?? []).filter((h) => !isLoopbackHost(h))
  const localNets = new Set(localIps.map(ipv4Prefix24).filter((n): n is string => Boolean(n)))
  const otherSubnetIps =
    localNets.size > 0
      ? peerIps.filter((ip) => {
          const net = ipv4Prefix24(ip)
          return net != null && !localNets.has(net)
        })
      : []

  return (
    <div className="peer-reach-alert">
      <Alert variant="warning" title="Visible en la lista, inalcanzable por TCP 8765">
        <p>
          {backendNote ??
            'El equipo se vio por discovery (UDP 8766), pero no responde HTTP en el puerto 8765. No significa que esté apagado.'}
        </p>
        <p className="peer-reach-target">
          Intento actual: <span className="mono">{hostnameOnly(host) || host}</span>
          <span aria-hidden="true"> · </span>
          <span className="mono">{origin}</span>
        </p>
        <p className="peer-host-label" id="peer-hosts-label">
          IPs conocidas de este peer
        </p>
        <ul className="peer-host-list" aria-labelledby="peer-hosts-label">
          {peerIps.map((ip) => (
            <li key={ip}>
              <span className="mono">{ip}</span>
              {otherSubnetIps.includes(ip) ? (
                <span className="peer-host-note"> — distinta a tu segmento</span>
              ) : null}
            </li>
          ))}
        </ul>
        {localIps.length > 0 && otherSubnetIps.length > 0 ? (
          <p>
            Tu red: <span className="mono">{localIps.join(', ')}</span>. Peer fuera de segmento:{' '}
            <span className="mono">{otherSubnetIps.join(', ')}</span>.
          </p>
        ) : null}
        <ul className="error-hints">
          <li>Misma Wi‑Fi (no red invitada ni aislamiento de clientes).</li>
          <li>Firewall: permitir AntiShare en TCP 8765 y UDP 8766.</li>
          <li>En macOS, permiso de Red local para AntiShare.</li>
          <li>
            Probá: <span className="mono">{curl}</span>
          </li>
        </ul>
      </Alert>
    </div>
  )
}
