import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  statSync
} from 'fs'
import { join, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import Busboy from 'busboy'
import type { DirEntry } from '../shared/types'
import { buildShareUrls } from './net'
import { isInsideRoot, resolveSafe } from './pathSafe'
import {
  httpStatusForFsError,
  mkdirInShare,
  removeInShare,
  renameInShare
} from './fsOps'

export { resolveSafe } from './pathSafe'

export interface ShareServerOptions {
  folder: string
  port: number
  token?: string
}

export interface ShareServerHandle {
  port: number
  urls: string[]
  folder: string
  tokenRequired: boolean
  /** Effective socket the server bound to (family/address/port), for diagnostics. */
  address: AddressInfo | null
  stop: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  })
  res.end(data)
}

function sendText(res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** List directory under share root with symlink-safe resolveSafe. */
export function listShareFolder(root: string, relPath: string = ''): DirEntry[] {
  return listDir(root, relPath)
}

function listDir(root: string, relPath: string): DirEntry[] {
  const abs = resolveSafe(root, relPath)
  const st = statSync(abs)
  if (!st.isDirectory()) {
    throw new Error('Not a directory')
  }
  const rootReal = realpathSync(root)
  const names = readdirSync(abs)
  return names.map((name) => {
    const full = join(abs, name)
    const lst = lstatSync(full)
    const entryRel = relPath && relPath !== '.' ? `${relPath.replace(/\/$/, '')}/${name}` : name
    const base = {
      name,
      path: entryRel.replace(/\\/g, '/'),
      mtime: lst.mtimeMs
    }

    if (lst.isSymbolicLink()) {
      try {
        const real = realpathSync(full)
        if (!isInsideRoot(rootReal, real)) {
          return { ...base, isDir: false, size: 0 }
        }
        const s = statSync(real)
        return {
          ...base,
          isDir: s.isDirectory(),
          size: s.isFile() ? s.size : 0,
          mtime: s.mtimeMs
        }
      } catch {
        return { ...base, isDir: false, size: 0 }
      }
    }

    return {
      ...base,
      isDir: lst.isDirectory(),
      size: lst.isFile() ? lst.size : 0
    } satisfies DirEntry
  })
}

function checkToken(req: IncomingMessage, token?: string): boolean {
  if (!token) return true
  const header = req.headers['x-share-token']
  return typeof header === 'string' && header === token
}

function htmlIndex(entries: DirEntry[], currentPath: string): string {
  const rows = entries
    .map((e) => {
      const href = e.isDir
        ? `/?path=${encodeURIComponent(e.path)}`
        : `/api/download?path=${encodeURIComponent(e.path)}`
      return `<li><a href="${href}">${e.isDir ? '📁' : '📄'} ${escapeHtml(e.name)}</a></li>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AntiShare</title>
<style>body{font-family:system-ui;margin:2rem}a{text-decoration:none}</style>
</head><body>
<h1>AntiShare</h1>
<p>path: <code>${escapeHtml(currentPath || '/')}</code></p>
<ul>${rows || '<li>(empty)</li>'}</ul>
<p><a href="/api/list?path=${encodeURIComponent(currentPath)}">JSON list</a></p>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function parseQuery(url: string): URL {
  return new URL(url, 'http://localhost')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON inválido')
  }
  return parsed as Record<string, unknown>
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  return typeof v === 'string' ? v : ''
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  root: string
): Promise<void> {
  const q = parseQuery(req.url || '/')
  const destRel = q.searchParams.get('path') || ''
  const destDir = resolveSafe(root, destRel)

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  } else if (!statSync(destDir).isDirectory()) {
    sendJson(res, 400, { error: 'Destination is not a directory' })
    return
  }

  // Re-validate after mkdir so a raced symlink cannot escape.
  resolveSafe(root, destRel)

  await new Promise<void>((resolvePromise, reject) => {
    const bb = Busboy({ headers: req.headers })
    const writes: Promise<void>[] = []
    let errored = false

    bb.on('file', (_name, file, info) => {
      const filename = info.filename || 'upload.bin'
      const safeName = filename.replace(/[/\\]/g, '_')
      let outPath: string
      try {
        const fileRel = destRel && destRel !== '.' ? join(destRel, safeName) : safeName
        outPath = resolveSafe(root, fileRel)
      } catch {
        file.resume()
        errored = true
        sendJson(res, 403, { error: 'Path traversal blocked' })
        return
      }
      const ws = createWriteStream(outPath)
      writes.push(
        new Promise<void>((resWrite, rejWrite) => {
          file.pipe(ws)
          ws.on('finish', () => resWrite())
          ws.on('error', rejWrite)
          file.on('error', rejWrite)
        })
      )
    })

    bb.on('error', reject)
    bb.on('finish', () => {
      void Promise.all(writes)
        .then(() => {
          if (!errored) {
            sendJson(res, 200, { ok: true, saved: writes.length })
            resolvePromise()
          }
        })
        .catch(reject)
    })

    req.pipe(bb)
  })
}

export async function startShareServer(opts: ShareServerOptions): Promise<ShareServerHandle> {
  const rootResolved = resolve(opts.folder)
  if (!existsSync(rootResolved) || !statSync(rootResolved).isDirectory()) {
    throw new Error(`Share folder does not exist: ${rootResolved}`)
  }
  const root = realpathSync(rootResolved)

  const server: Server = createServer(async (req, res) => {
    try {
      if (!checkToken(req, opts.token)) {
        sendJson(res, 401, { error: 'Invalid or missing X-Share-Token' })
        return
      }

      const method = req.method || 'GET'
      const u = parseQuery(req.url || '/')
      const pathname = u.pathname

      if (method === 'GET' && pathname === '/') {
        const pathParam = u.searchParams.get('path') || ''
        const format = u.searchParams.get('format')
        try {
          const entries = listDir(root, pathParam)
          if (format === 'json' || (req.headers.accept || '').includes('application/json')) {
            sendJson(res, 200, entries)
          } else {
            sendText(res, 200, htmlIndex(entries, pathParam), 'text/html; charset=utf-8')
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          sendJson(res, msg.includes('traversal') ? 403 : 400, { error: msg })
        }
        return
      }

      if (method === 'GET' && pathname === '/api/list') {
        const pathParam = u.searchParams.get('path') || ''
        try {
          const entries = listDir(root, pathParam)
          sendJson(res, 200, entries)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          sendJson(res, msg.includes('traversal') ? 403 : 400, { error: msg })
        }
        return
      }

      if (method === 'GET' && pathname === '/api/download') {
        const pathParam = u.searchParams.get('path')
        if (!pathParam) {
          sendJson(res, 400, { error: 'Missing path' })
          return
        }
        try {
          const abs = resolveSafe(root, pathParam)
          const st = statSync(abs)
          if (!st.isFile()) {
            sendJson(res, 400, { error: 'Not a file' })
            return
          }
          const name = abs.split(sep).pop() || 'download'
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`
          })
          await pipeline(createReadStream(abs), res)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) {
            sendJson(res, msg.includes('traversal') ? 403 : 404, { error: msg })
          }
        }
        return
      }

      if (method === 'POST' && pathname === '/api/upload') {
        try {
          await handleUpload(req, res, root)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) {
            sendJson(res, msg.includes('traversal') ? 403 : 500, { error: msg })
          }
        }
        return
      }

      if (method === 'POST' && pathname === '/api/mkdir') {
        try {
          const body = await readJsonBody(req)
          mkdirInShare(root, strField(body, 'path'), strField(body, 'name'))
          sendJson(res, 200, { ok: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) sendJson(res, httpStatusForFsError(e), { error: msg })
        }
        return
      }

      if (method === 'POST' && pathname === '/api/rename') {
        try {
          const body = await readJsonBody(req)
          renameInShare(root, strField(body, 'path'), strField(body, 'newName'))
          sendJson(res, 200, { ok: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) sendJson(res, httpStatusForFsError(e), { error: msg })
        }
        return
      }

      if (method === 'POST' && pathname === '/api/remove') {
        try {
          const body = await readJsonBody(req)
          removeInShare(root, strField(body, 'path'))
          sendJson(res, 200, { ok: true })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) sendJson(res, httpStatusForFsError(e), { error: msg })
        }
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!res.headersSent) sendJson(res, 500, { error: msg })
    }
  })

  // Default keepAliveTimeout is 5s; AntiShare clients poll ~every 5s and Node fetch
  // (undici) will reuse sockets the server already closed → intermittent "fetch failed"
  // until process restart. Keep idle sockets longer than the UI poll interval.
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `El puerto ${opts.port} ya está en uso. Cerrá la otra instancia de AntiShare (u otra app) que lo esté usando e intentá de nuevo.`
          )
        )
        return
      }
      reject(err)
    })
    server.listen(opts.port, '0.0.0.0', () => resolveListen())
  })

  const bound = server.address()
  const boundInfo = bound && typeof bound === 'object' ? bound : null
  const effectivePort = boundInfo?.port ?? opts.port

  return {
    port: effectivePort,
    get urls() {
      return buildShareUrls(effectivePort).all
    },
    get address() {
      const a = server.address()
      return a && typeof a === 'object' ? a : null
    },
    folder: root,
    tokenRequired: Boolean(opts.token),
    stop: () =>
      new Promise((resolveStop, reject) => {
        // Drop idle keep-alive sockets so close() resolves immediately (prod keepAliveTimeout stays).
        const closeAll = (
          server as Server & { closeAllConnections?: () => void }
        ).closeAllConnections
        if (typeof closeAll === 'function') closeAll.call(server)
        server.close((err) => (err ? reject(err) : resolveStop()))
      })
  }
}
