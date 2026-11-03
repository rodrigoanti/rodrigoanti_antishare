import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createReadStream, statSync } from 'fs'
import { pipeline } from 'stream/promises'
import type { GroupMetaResponse, SyncIndexResponse } from '../shared/types'
import { GROUP_AUTH_HEADER } from './groupAuth'
import { resolveSafe } from './pathSafe'

/** What the server needs from the group manager; every /g/ route is signed per group. */
export interface GroupServerHooks {
  hello: () => { name: string; deviceId: string }
  /** True when the request is signed with this group's current key. */
  authorize: (
    groupId: string,
    header: string | string[] | undefined,
    method: string,
    pathAndQuery: string
  ) => boolean
  meta: (groupId: string) => GroupMetaResponse | null
  index: (groupId: string) => SyncIndexResponse | null
  rootFor: (groupId: string) => string | null
  notify: (groupId: string, deviceId: string) => void
}

export interface GroupServerHandle {
  port: number
  address: AddressInfo | null
  stop: () => Promise<void>
}

const GROUP_ROUTE = /^\/g\/([0-9a-f]{6,64})\/(meta|index|download|notify)$/

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  })
  res.end(data)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
    size += buf.length
    if (size > 64 * 1024) throw new Error('Body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export async function startGroupServer(opts: {
  port: number
  hooks: GroupServerHooks
}): Promise<GroupServerHandle> {
  const { hooks } = opts

  const server: Server = createServer(async (req, res) => {
    try {
      const method = req.method || 'GET'
      const rawPath = req.url || '/'
      const u = new URL(rawPath, 'http://localhost')

      // Unauthenticated liveness probe (diagnostics, manual peers). Reveals no group data.
      if (method === 'GET' && u.pathname === '/api/hello') {
        sendJson(res, 200, { app: 'antishare', ...hooks.hello() })
        return
      }

      const m = GROUP_ROUTE.exec(u.pathname)
      if (!m) {
        sendJson(res, 404, { error: 'Not found' })
        return
      }
      const [, groupId, action] = m
      if (!hooks.authorize(groupId, req.headers[GROUP_AUTH_HEADER], method, rawPath)) {
        sendJson(res, 401, { error: 'Clave del grupo inválida' })
        return
      }

      if (method === 'GET' && action === 'meta') {
        const meta = hooks.meta(groupId)
        if (!meta) sendJson(res, 404, { error: 'Grupo desconocido' })
        else sendJson(res, 200, meta)
        return
      }

      if (method === 'GET' && action === 'index') {
        const index = hooks.index(groupId)
        if (!index) sendJson(res, 404, { error: 'El grupo no está sincronizando' })
        else sendJson(res, 200, index)
        return
      }

      if (method === 'GET' && action === 'download') {
        const root = hooks.rootFor(groupId)
        const rel = u.searchParams.get('path')
        if (!root || !rel) {
          sendJson(res, 404, { error: 'No disponible' })
          return
        }
        try {
          const abs = resolveSafe(root, rel)
          const st = statSync(abs)
          if (!st.isFile()) {
            sendJson(res, 400, { error: 'Not a file' })
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size
          })
          await pipeline(createReadStream(abs), res)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!res.headersSent) sendJson(res, msg.includes('traversal') ? 403 : 404, { error: msg })
        }
        return
      }

      if (method === 'POST' && action === 'notify') {
        const body = await readJson(req)
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
        hooks.notify(groupId, deviceId)
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 405, { error: 'Method not allowed' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!res.headersSent) sendJson(res, 500, { error: msg })
    }
  })

  // Peers reuse sockets between rounds; keep idle ones longer than a sync round.
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `El puerto ${opts.port} ya está en uso. Cierra la otra instancia de AntiShare (u otra app) que lo esté usando.`
          )
        )
        return
      }
      reject(err)
    })
    server.listen(opts.port, '0.0.0.0', () => resolveListen())
  })

  const bound = server.address()
  const port = bound && typeof bound === 'object' ? bound.port : opts.port

  return {
    port,
    get address() {
      const a = server.address()
      return a && typeof a === 'object' ? a : null
    },
    stop: () =>
      new Promise((resolveStop, reject) => {
        const closeAll = (server as Server & { closeAllConnections?: () => void })
          .closeAllConnections
        if (typeof closeAll === 'function') closeAll.call(server)
        server.close((err) => (err ? reject(err) : resolveStop()))
      })
  }
}
