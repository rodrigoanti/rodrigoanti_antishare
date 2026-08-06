import { app } from 'electron'
import { request as httpRequest } from 'http'
import type { IncomingMessage } from 'http'
import { createWriteStream, createReadStream, existsSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import {
  DEFAULT_SHARE_PORT,
  type DirEntry,
  type RemoteDownloadRequest,
  type RemoteDownloadResult,
  type RemoteListRequest,
  type RemoteListResult,
  type RemoteUploadRequest,
  type RemoteUploadResult,
  type FsOpResult,
  type RemoteFsMkdirRequest,
  type RemoteFsRenameRequest,
  type RemoteFsMoveRequest,
  type RemoteFsRemoveRequest
} from '../shared/types'
import {
  getLanIPv4,
  getLanIfaces,
  hostOnLocalSubnet,
  localAddressForPeer,
  normalizeHost
} from './net'

const LIST_TIMEOUT_MS = 8_000
const TRANSFER_TIMEOUT_MS = 120_000

function authHeaders(token?: string): Record<string, string> {
  return token ? { 'X-Share-Token': token } : {}
}

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

/** Compact per-host reason used when several peer IPs were tried. */
export function shortNetworkReason(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (typeof code === 'string' && code) return code
  const hay = errorHaystack(err)
  if (hay.includes('timeout') || hay.includes('timed out') || hay.includes('abort')) {
    return 'timeout'
  }
  if (!hay) return 'error desconocido'
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, 60)
}

type ShareTarget = { baseUrl: string; host: string; port: number }

function parseShareBase(baseUrl: string): ShareTarget {
  const trimmed = (baseUrl || '').replace(/\/+$/, '')
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    const host = normalizeHost(u.hostname)
    const port = u.port ? Number(u.port) : DEFAULT_SHARE_PORT
    return { baseUrl: `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`, host, port }
  } catch {
    return { baseUrl: trimmed, host: normalizeHost(trimmed), port: DEFAULT_SHARE_PORT }
  }
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
  const timeoutMs = init.timeoutMs ?? LIST_TIMEOUT_MS
  const url = new URL(urlStr)
  const localAddress = localAddressForPeer(url.hostname)
  return nodeHttpOnce(url, { ...init, timeoutMs, localAddress })
}

/** Pick a free path in dir: name, name (1).ext, name (2).ext, … (win32 + posix safe). */
export function uniqueDownloadPath(dir: string, fileName: string): string {
  // Normalize Windows backslashes before basename so C:\a\b.txt → b.txt on all hosts
  const normalized = String(fileName || '').replace(/\\/g, '/')
  const safe = basename(normalized).replace(/[/\\]/g, '_').trim() || 'download.bin'
  const ext = extname(safe)
  const stem = basename(safe, ext) || 'download'
  let candidate = join(dir, safe)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`)
    n++
  }
  return candidate
}

function defaultDownloadsDest(remotePath: string): string {
  const downloads = app.getPath('downloads')
  const name = basename(String(remotePath || '').replace(/\\/g, '/')) || 'download.bin'
  return uniqueDownloadPath(downloads, name)
}

export async function remoteList(req: RemoteListRequest): Promise<RemoteListResult> {
  const bases = [req.baseUrl, ...(req.altBaseUrls ?? [])]
    .map((b) => (b || '').replace(/\/+$/, ''))
    .filter((b, i, arr) => b && arr.indexOf(b) === i)
  if (bases.length === 0) {
    return { ok: false, error: 'Falta la URL del peer.' }
  }

  const path = req.path || ''
  const failures: Array<{ target: ShareTarget; err: unknown }> = []

  for (const candidate of bases) {
    const target = parseShareBase(candidate)
    try {
      const url = `${target.baseUrl}/api/list?path=${encodeURIComponent(path)}`
      const res = await peerHttp(url, {
        headers: authHeaders(req.token),
        timeoutMs: LIST_TIMEOUT_MS
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        return {
          ok: false,
          error: body.error || `No se pudo listar el peer (HTTP ${res.status}).`
        }
      }
      const entries = (await res.json()) as DirEntry[]
      return { ok: true, entries }
    } catch (e) {
      failures.push({ target, err: e })
    }
  }

  const primaryFailure = failures[0]
  const peerIps = bases.map((b) => parseShareBase(b).host).filter(Boolean)
  const localIps = getLanIPv4()
  const localIfaces = getLanIfaces()
  const sameSubnet = peerIps.filter((h) => hostOnLocalSubnet(h, localIfaces))
  const classified = classifyPeerNetworkError(
    primaryFailure?.err,
    primaryFailure?.target ?? parseShareBase(bases[0])
  )
  const subnetNote =
    sameSubnet.length === 0 && peerIps.length > 0
      ? ' Ninguna IP del peer está en la misma subred local.'
      : ''
  // Report every attempt: with several peer IPs the failure reason differs per host,
  // and collapsing to a single message hides which address actually broke.
  const attempts = failures
    .map((f) => `${f.target.host}:${f.target.port} → ${shortNetworkReason(f.err)}`)
    .join('; ')
  return {
    ok: false,
    error:
      `${classified} Intentos: ${attempts || '(ninguno)'}. ` +
      `IPs locales: ${localIps.join(', ') || '(ninguna)'}. ` +
      `IPs del peer: ${peerIps.join(', ') || '(desconocidas)'}.${subnetNote}`
  }
}

export async function remoteDownload(req: RemoteDownloadRequest): Promise<RemoteDownloadResult> {
  try {
    if (!req.path) {
      return { ok: false, error: 'Falta la ruta del archivo a descargar.' }
    }
    const base = req.baseUrl.replace(/\/$/, '')
    const url = `${base}/api/download?path=${encodeURIComponent(req.path)}`
    const res = await peerHttp(url, {
      headers: authHeaders(req.token),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      stream: true
    })
    if (!res.ok) {
      let detail = ''
      try {
        const chunks: Buffer[] = []
        for await (const c of res.bodyStream) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string }
        detail = parsed.error || ''
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: detail || `No se pudo descargar el archivo (HTTP ${res.status}).`
      }
    }
    const dest = req.destPath || defaultDownloadsDest(req.path)
    await pipeline(res.bodyStream, createWriteStream(dest))
    return { ok: true, destPath: dest }
  } catch (e) {
    return {
      ok: false,
      error: classifyPeerNetworkError(e, parseShareBase(req.baseUrl))
    }
  }
}

export async function remoteUpload(req: RemoteUploadRequest): Promise<RemoteUploadResult> {
  try {
    const st = statSync(req.filePath)
    if (!st.isFile()) return { ok: false, error: 'La ruta local no es un archivo.' }

    const base = req.baseUrl.replace(/\/$/, '')
    const destPath = req.path || ''
    const url = `${base}/api/upload?path=${encodeURIComponent(destPath)}`
    const fileName = basename(req.filePath)
    const boundary = `----AntiShare${Date.now()}`
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      'utf8'
    )
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const contentLength = preamble.length + st.size + epilogue.length

    async function* multipartBody(): AsyncGenerator<Buffer> {
      yield preamble
      const rs = createReadStream(req.filePath)
      for await (const chunk of rs) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      }
      yield epilogue
    }

    const res = await peerHttp(url, {
      method: 'POST',
      headers: {
        ...authHeaders(req.token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(contentLength)
      },
      body: Readable.from(multipartBody()),
      timeoutMs: TRANSFER_TIMEOUT_MS
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      return {
        ok: false,
        error: data.error || `No se pudo subir el archivo (HTTP ${res.status}).`
      }
    }
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: classifyPeerNetworkError(e, parseShareBase(req.baseUrl))
    }
  }
}

async function remoteFsPost(
  baseUrl: string,
  token: string | undefined,
  endpoint: '/api/mkdir' | '/api/rename' | '/api/move' | '/api/remove',
  body: Record<string, string>
): Promise<FsOpResult> {
  try {
    const base = baseUrl.replace(/\/$/, '')
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const res = await peerHttp(`${base}${endpoint}`, {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(payload.length)
      },
      body: payload,
      timeoutMs: LIST_TIMEOUT_MS
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      return { ok: false, error: data.error || `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: classifyPeerNetworkError(e, parseShareBase(baseUrl)) }
  }
}

export async function remoteMkdir(req: RemoteFsMkdirRequest): Promise<FsOpResult> {
  return remoteFsPost(req.baseUrl, req.token, '/api/mkdir', {
    path: req.path || '',
    name: req.name
  })
}

export async function remoteRename(req: RemoteFsRenameRequest): Promise<FsOpResult> {
  return remoteFsPost(req.baseUrl, req.token, '/api/rename', {
    path: req.path,
    newName: req.newName
  })
}

export async function remoteMove(req: RemoteFsMoveRequest): Promise<FsOpResult> {
  return remoteFsPost(req.baseUrl, req.token, '/api/move', {
    path: req.path,
    destPath: req.destPath || ''
  })
}

export async function remoteRemove(req: RemoteFsRemoveRequest): Promise<FsOpResult> {
  return remoteFsPost(req.baseUrl, req.token, '/api/remove', { path: req.path })
}
