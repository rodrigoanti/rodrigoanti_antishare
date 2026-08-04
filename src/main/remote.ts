import { app } from 'electron'
import { createWriteStream, createReadStream, existsSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import type {
  DirEntry,
  RemoteDownloadRequest,
  RemoteDownloadResult,
  RemoteListRequest,
  RemoteListResult,
  RemoteUploadRequest,
  RemoteUploadResult
} from '../shared/types'

const LIST_TIMEOUT_MS = 8_000
const TRANSFER_TIMEOUT_MS = 120_000

function authHeaders(token?: string): Record<string, string> {
  return token ? { 'X-Share-Token': token } : {}
}

function isRetryableNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? err.cause.message.toLowerCase()
      : err instanceof Error && err.cause
        ? String(err.cause).toLowerCase()
        : ''
  const hay = `${msg} ${cause}`
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
  try {
    const base = req.baseUrl.replace(/\/$/, '')
    const path = req.path || ''
    const url = `${base}/api/list?path=${encodeURIComponent(path)}`
    const res = await peerFetch(url, {
      headers: authHeaders(req.token),
      timeoutMs: LIST_TIMEOUT_MS,
      retries: 1
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
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'No se pudo conectar al peer.'
    }
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
      error: e instanceof Error ? e.message : 'Error al guardar la descarga.'
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
      error: e instanceof Error ? e.message : 'Error al subir el archivo.'
    }
  }
}
