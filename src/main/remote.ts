import { app } from 'electron'
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
  type RemoteUploadResult
} from '../shared/types'
import { getLanIPv4, hostOnLocalSubnet, getLanIfaces, normalizeHost } from './net'

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
  if (hay.includes('enetunreach') || hay.includes('ehostunreach')) {
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

function isRetryableNetworkError(err: unknown): boolean {
  const hay = errorHaystack(err)
  return (
    hay.includes('fetch failed') ||
    hay.includes('econnreset') ||
    hay.includes('econnrefused') ||
    hay.includes('econnaborted') ||
    hay.includes('epipe') ||
    hay.includes('socket') ||
    hay.includes('network') ||
    hay.includes('und_err') ||
    hay.includes('other side closed') ||
    hay.includes('aborted') ||
    hay.includes('timeout')
  )
}

function parseShareBase(baseUrl: string): { baseUrl: string; host: string; port: number } {
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

/** LAN peer fetch with timeout; one retry on stale keep-alive / reset races. */
async function peerFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<Response> {
  const { timeoutMs = LIST_TIMEOUT_MS, retries = 1, headers, ...rest } = init
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, {
        ...rest,
        cache: 'no-store',
        headers: {
          Connection: 'close',
          ...(headers as Record<string, string> | undefined)
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      lastError = e
      if (attempt >= retries || !isRetryableNetworkError(e)) throw e
      await new Promise((r) => setTimeout(r, 150 + attempt * 200))
    }
  }
  throw lastError
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
  let lastError: unknown
  let lastTarget = parseShareBase(bases[0])

  for (const candidate of bases) {
    const target = parseShareBase(candidate)
    lastTarget = target
    try {
      const url = `${target.baseUrl}/api/list?path=${encodeURIComponent(path)}`
      const res = await peerFetch(url, {
        headers: authHeaders(req.token),
        timeoutMs: LIST_TIMEOUT_MS,
        retries: 0
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
      lastError = e
    }
  }

  const peerIps = bases.map((b) => parseShareBase(b).host).filter(Boolean)
  const localIps = getLanIPv4()
  const localIfaces = getLanIfaces()
  const sameSubnet = peerIps.filter((h) => hostOnLocalSubnet(h, localIfaces))
  const classified = classifyPeerNetworkError(lastError, lastTarget)
  const subnetNote =
    sameSubnet.length === 0 && peerIps.length > 0
      ? ' Ninguna IP del peer está en la misma subred local.'
      : ''
  return {
    ok: false,
    error:
      `${classified} IPs locales: ${localIps.join(', ') || '(ninguna)'}. ` +
      `IPs del peer: ${peerIps.join(', ') || lastTarget.host}.${subnetNote}`
  }
}

export async function remoteDownload(req: RemoteDownloadRequest): Promise<RemoteDownloadResult> {
  try {
    if (!req.path) {
      return { ok: false, error: 'Falta la ruta del archivo a descargar.' }
    }
    const base = req.baseUrl.replace(/\/$/, '')
    const url = `${base}/api/download?path=${encodeURIComponent(req.path)}`
    const res = await peerFetch(url, {
      headers: authHeaders(req.token),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      retries: 1
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      return {
        ok: false,
        error: body.error || `No se pudo descargar el archivo (HTTP ${res.status}).`
      }
    }
    // Explicit destPath (e.g. drag temp) wins; otherwise OS Downloads folder.
    const dest = req.destPath || defaultDownloadsDest(req.path)
    if (!res.body) {
      return { ok: false, error: 'La respuesta de descarga está vacía.' }
    }
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
    await pipeline(nodeStream, createWriteStream(dest))
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
    const fileBuf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const rs = createReadStream(req.filePath)
      rs.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      rs.on('end', () => resolve(Buffer.concat(chunks)))
      rs.on('error', reject)
    })
    const body = Buffer.concat([preamble, fileBuf, epilogue])

    const res = await peerFetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(req.token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body,
      timeoutMs: TRANSFER_TIMEOUT_MS,
      retries: 1
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
