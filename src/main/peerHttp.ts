import { request as httpRequest } from 'http'
import type { IncomingMessage } from 'http'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { getLanIfaces, hostOnLocalSubnet, localAddressForPeer } from './net'

const DEFAULT_TIMEOUT_MS = 8_000

function errorHaystack(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      const code = (cur as NodeJS.ErrnoException).code
      if (code) parts.push(code)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(' ').toLowerCase()
}

export function classifyPeerNetworkError(
  err: unknown,
  target: { host: string; port: number; baseUrl: string }
): string {
  const hay = errorHaystack(err)
  const where = `${target.host}:${target.port}`
  const hint =
    `El peer se ve por discovery (UDP 8766) pero no responde en TCP ${target.port}. ` +
    `Probá: firewall inbound TCP ${target.port} en esa PC; no uses red de invitados / aislamiento AP; ` +
    `en macOS, permití AntiShare en Red local.`

  if (
    hay.includes('timeout') ||
    hay.includes('timed out') ||
    hay.includes('aborted') ||
    hay.includes('aborterror')
  ) {
    return `Tiempo agotado al abrir ${target.baseUrl} (${where}). ${hint}`
  }
  if (hay.includes('econnrefused')) {
    return `Conexión rechazada en ${where} (ECONNREFUSED). Nadie acepta TCP ${target.port} o el firewall lo corta. ${hint}`
  }
  if (hay.includes('ehostunreach')) {
    return (
      `El host ${where} no responde a nivel de red (EHOSTUNREACH): la LAN no devuelve respuesta ARP ` +
      `para esa IP. Si el peer se ve por discovery, el Wi‑Fi está aislando clientes entre sí (AP/red ` +
      `de invitados) o cada equipo está en una red distinta; si no se ve, esa IP ya no está activa. ${hint}`
    )
  }
  if (hay.includes('enetunreach')) {
    if (hostOnLocalSubnet(target.host, getLanIfaces())) {
      return (
        `La red no alcanza ${where} (ENETUNREACH) aunque está en tu misma subred. ` +
        `Probable VPN/ruta por defecto tomando el tráfico o aislamiento AP. ${hint}`
      )
    }
    return `La red no alcanza ${where} (ENETUNREACH). Distinta subred o Wi‑Fi invitado. ${hint}`
  }
  if (hay.includes('enotfound') || hay.includes('eai_again')) {
    return `No se resolvió el host ${target.host}. ${hint}`
  }
  if (hay.includes('fetch failed') || hay.includes('network') || hay.includes('und_err')) {
    return `Fallo de red hacia ${target.baseUrl} (fetch failed). ${hint}`
  }
  const msg = err instanceof Error ? err.message : String(err)
  return `${msg} (${where}). ${hint}`
}

export type PeerHttpResult = {
  status: number
  ok: boolean
  json: () => Promise<unknown>
  bodyStream: Readable
}

function nodeHttpOnce(
  url: URL,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string | Readable
    timeoutMs: number
    localAddress?: string
    stream?: boolean
  }
): Promise<PeerHttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        family: 4,
        path: `${url.pathname}${url.search}`,
        method: init.method || 'GET',
        headers: {
          Connection: 'close',
          ...(init.headers || {})
        },
        localAddress: init.localAddress,
        agent: false,
        timeout: init.timeoutMs
      },
      (res: IncomingMessage) => {
        if (init.stream) {
          resolve({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            json: async () => {
              throw new Error('json() not available on streamed response')
            },
            bodyStream: res
          })
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({
            status: res.statusCode || 0,
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            json: async () => (buf.length ? JSON.parse(buf.toString('utf8')) : {}),
            bodyStream: Readable.from(buf)
          })
        })
        res.on('error', reject)
      }
    )
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', reject)

    const body = init.body
    if (body && typeof body === 'object' && typeof (body as Readable).pipe === 'function') {
      void pipeline(body as Readable, req).catch(reject)
      return
    }
    if (body) req.write(body as Buffer | string)
    req.end()
  })
}

/** Peer HTTP bound to the LAN NIC that shares the peer subnet when possible. */
export async function peerHttp(
  urlStr: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string | Readable
    timeoutMs?: number
    stream?: boolean
  } = {}
): Promise<PeerHttpResult> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = new URL(urlStr)
  const localAddress = localAddressForPeer(url.hostname)
  return nodeHttpOnce(url, { ...init, timeoutMs, localAddress })
}
