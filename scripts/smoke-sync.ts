/**
 * Smoke: two folders + two share servers + two sync engines converge (create, edit,
 * delete, concurrent edit → conflict copy).
 * Usage: npx tsx scripts/smoke-sync.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Peer } from '../src/shared/types'
import { startShareServer } from '../src/main/shareServer'
import { SyncEngine } from '../src/main/syncEngine'

const stamp = Date.now()
const base = join(tmpdir(), `antishare-sync-${stamp}`)
const PORT_A = Number(process.env.ANTISHARE_TEST_PORT || 18770)
const PORT_B = PORT_A + 1
const TOKEN = 'smoke-key'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function peer(name: string, port: number): Peer {
  return {
    name,
    host: '127.0.0.1',
    port,
    tokenRequired: true,
    lastSeen: Date.now(),
    baseUrl: `http://127.0.0.1:${port}`
  }
}

async function waitFor(check: () => boolean, msg: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout: ${msg}`)
}

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)

async function main(): Promise<void> {
  const rootA = join(base, 'A')
  const rootB = join(base, 'B')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  writeFileSync(join(rootA, 'hola.txt'), 'desde A\n')
  mkdirSync(join(rootB, 'docs'))
  writeFileSync(join(rootB, 'docs', 'nota.md'), 'desde B\n')

  let engineA: SyncEngine | null = null
  let engineB: SyncEngine | null = null
  const srvA = await startShareServer({ folder: rootA, port: PORT_A, token: TOKEN, sync: () => engineA })
  const srvB = await startShareServer({ folder: rootB, port: PORT_B, token: TOKEN, sync: () => engineB })
  engineA = new SyncEngine({
    root: srvA.folder,
    space: 'equipo',
    token: TOKEN,
    indexFile: join(base, 'idx-A.json'),
    deviceId: 'device-a',
    deviceName: 'PC-A',
    listPeers: () => [peer('B', PORT_B)]
  })
  engineB = new SyncEngine({
    root: srvB.folder,
    space: 'equipo',
    token: TOKEN,
    indexFile: join(base, 'idx-B.json'),
    deviceId: 'device-b',
    deviceName: 'PC-B',
    listPeers: () => [peer('A', PORT_A)]
  })

  try {
    engineA.start()
    engineB.start()

    await waitFor(
      () => read(join(rootB, 'hola.txt')) === 'desde A\n' && read(join(rootA, 'docs', 'nota.md')) === 'desde B\n',
      'archivos iniciales no se cruzaron'
    )
    console.log('ok: archivos nuevos en ambos sentidos')

    writeFileSync(join(rootB, 'hola.txt'), 'editado en B\n')
    await waitFor(() => read(join(rootA, 'hola.txt')) === 'editado en B\n', 'edición no llegó a A')
    console.log('ok: edición propagada')

    unlinkSync(join(rootA, 'docs', 'nota.md'))
    await waitFor(() => !existsSync(join(rootB, 'docs', 'nota.md')), 'borrado no llegó a B')
    console.log('ok: borrado propagado')

    // Concurrent edit: stop both, edit both, restart.
    engineA.stop()
    engineB.stop()
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(rootA, 'hola.txt'), 'version A\n')
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(rootB, 'hola.txt'), 'version B\n')
    engineA = new SyncEngine({
      root: srvA.folder, space: 'equipo', token: TOKEN, indexFile: join(base, 'idx-A.json'),
      deviceId: 'device-a', deviceName: 'PC-A', listPeers: () => [peer('B', PORT_B)]
    })
    engineB = new SyncEngine({
      root: srvB.folder, space: 'equipo', token: TOKEN, indexFile: join(base, 'idx-B.json'),
      deviceId: 'device-b', deviceName: 'PC-B', listPeers: () => [peer('A', PORT_A)]
    })
    engineA.start()
    engineB.start()

    const conflicts = (root: string): string[] => readdirSync(root).filter((n) => n.includes('conflicto'))
    await waitFor(
      () =>
        read(join(rootA, 'hola.txt')) === read(join(rootB, 'hola.txt')) &&
        conflicts(rootA).length === 1 &&
        conflicts(rootB).length === 1 &&
        read(join(rootA, conflicts(rootA)[0])) === read(join(rootB, conflicts(rootB)[0])),
      'conflicto no convergió'
    )
    const winner = read(join(rootA, 'hola.txt'))
    const copy = read(join(rootA, conflicts(rootA)[0]))
    assert(winner === 'version B\n', 'debía ganar la edición más reciente (B)')
    assert(copy === 'version A\n', 'la copia de conflicto debía tener la versión de A')
    console.log(`ok: conflicto resuelto → principal "${winner?.trim()}", copia "${copy?.trim()}"`)
    console.log('smoke-sync: OK')
  } finally {
    engineA?.stop()
    engineB?.stop()
    await srvA.stop()
    await srvB.stop()
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('smoke-sync: FAIL', err instanceof Error ? err.message : err)
  process.exit(1)
})
