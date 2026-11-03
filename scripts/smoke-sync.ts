/**
 * Smoke: two devices (group manager + group server each) go through the whole group life:
 * discover, wrong/right password, file sync (new, edit, delete, conflict), rename,
 * password change (other member locked until it types the new one), delete for everyone.
 * Usage: npx tsx scripts/smoke-sync.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Peer } from '../src/shared/types'
import { GroupManager } from '../src/main/groupManager'
import { startGroupServer, type GroupServerHandle } from '../src/main/groupServer'

const base = join(tmpdir(), `antishare-groups-${Date.now()}`)
const PORT_A = Number(process.env.ANTISHARE_TEST_PORT || 18770)
const PORT_B = PORT_A + 1

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function waitFor(check: () => boolean, msg: string, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout: ${msg}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null)

interface Device {
  name: string
  port: number
  folder: string
  manager: GroupManager
  server: GroupServerHandle
}

/** What the other device would learn from this one's UDP announcement. */
function asPeer(d: Device): Peer {
  return {
    name: d.name,
    host: '127.0.0.1',
    port: d.port,
    tokenRequired: false,
    lastSeen: Date.now(),
    baseUrl: `http://127.0.0.1:${d.port}`,
    groups: d.manager.announced()
  }
}

async function device(name: string, port: number, other: () => Device): Promise<Device> {
  const folder = join(base, name, 'carpeta')
  mkdirSync(folder, { recursive: true })
  const manager = new GroupManager({
    dataDir: join(base, name, 'data'),
    deviceId: `device-${name}`,
    deviceName: name,
    listPeers: () => [asPeer(other())]
  })
  const server = await startGroupServer({ port, hooks: manager.serverHooks() })
  manager.start()
  return { name, port, folder, manager, server }
}

async function main(): Promise<void> {
  let a!: Device
  let b!: Device
  a = await device('PC-A', PORT_A, () => b)
  b = await device('PC-B', PORT_B, () => a)

  try {
    writeFileSync(join(a.folder, 'hola.txt'), 'desde A\n')
    mkdirSync(join(b.folder, 'docs'))
    writeFileSync(join(b.folder, 'docs', 'nota.md'), 'desde B\n')

    const created = a.manager.create({ name: 'Diseño', password: 'clave-1', folder: a.folder })
    assert(created.ok && created.group, `crear grupo: ${created.error}`)
    const id = created.group!.id

    const seen = b.manager.discovered()
    assert(seen.length === 1 && seen[0].name === 'Diseño' && seen[0].members[0] === 'PC-A', 'B no ve el grupo')
    console.log('ok: B descubre el grupo «Diseño»')

    const wrong = await b.manager.join({ id, password: 'otra-clave', folder: b.folder })
    assert(!wrong.ok && /incorrecta/.test(wrong.error ?? ''), `clave mala debía fallar: ${wrong.error}`)
    const joined = await b.manager.join({ id, password: 'clave-1', folder: b.folder })
    assert(joined.ok, `unirse: ${joined.error}`)
    assert(b.manager.discovered().length === 0, 'el grupo unido no debe seguir en "En la red"')
    console.log('ok: clave incorrecta rechazada, correcta acepta')

    await waitFor(
      () => read(join(b.folder, 'hola.txt')) === 'desde A\n' && read(join(a.folder, 'docs', 'nota.md')) === 'desde B\n',
      'archivos iniciales no se cruzaron'
    )
    console.log('ok: archivos nuevos en ambos sentidos')

    writeFileSync(join(b.folder, 'hola.txt'), 'editado en B\n')
    await waitFor(() => read(join(a.folder, 'hola.txt')) === 'editado en B\n', 'edición no llegó a A')
    console.log('ok: edición propagada')

    unlinkSync(join(a.folder, 'docs', 'nota.md'))
    await waitFor(() => !existsSync(join(b.folder, 'docs', 'nota.md')), 'borrado no llegó a B')
    console.log('ok: borrado propagado')

    // Concurrent edit with both engines paused (folder untouched, engines restarted).
    a.manager.stop()
    b.manager.stop()
    await sleep(300)
    writeFileSync(join(a.folder, 'hola.txt'), 'version A\n')
    await sleep(20)
    writeFileSync(join(b.folder, 'hola.txt'), 'version B\n')
    a.manager.start()
    b.manager.start()
    const conflicts = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes('conflicto'))
    await waitFor(
      () =>
        read(join(a.folder, 'hola.txt')) === read(join(b.folder, 'hola.txt')) &&
        conflicts(a.folder).length === 1 &&
        conflicts(b.folder).length === 1 &&
        read(join(a.folder, conflicts(a.folder)[0])) === read(join(b.folder, conflicts(b.folder)[0])),
      'conflicto no convergió'
    )
    assert(read(join(a.folder, 'hola.txt')) === 'version B\n', 'debía ganar la edición más reciente (B)')
    assert(read(join(a.folder, conflicts(a.folder)[0])) === 'version A\n', 'la copia debía tener la versión de A')
    console.log('ok: conflicto → gana la más reciente, la otra queda como copia')

    const renamed = b.manager.update({ id, name: 'Diseño 2026' })
    assert(renamed.ok, `renombrar: ${renamed.error}`)
    await waitFor(() => a.manager.groups()[0]?.name === 'Diseño 2026', 'el nombre nuevo no llegó a A')
    console.log('ok: renombrar desde cualquier miembro')

    const changed = a.manager.update({ id, password: 'clave-2' })
    assert(changed.ok, `cambiar clave: ${changed.error}`)
    b.manager.onPeersChanged()
    assert(b.manager.groups()[0]?.state === 'locked', 'B debía quedar bloqueado tras el cambio de clave')
    writeFileSync(join(a.folder, 'tras-clave.txt'), 'nueva era\n')
    await sleep(1500)
    assert(!existsSync(join(b.folder, 'tras-clave.txt')), 'B bloqueado no debía recibir archivos')
    const relock = await b.manager.join({ id, password: 'clave-1', folder: b.folder })
    assert(!relock.ok, 'la clave vieja no debía servir')
    const unlock = await b.manager.join({ id, password: 'clave-2', folder: b.folder })
    assert(unlock.ok && unlock.group?.state === 'ok', `desbloquear: ${unlock.error}`)
    await waitFor(() => read(join(b.folder, 'tras-clave.txt')) === 'nueva era\n', 'tras desbloquear no sincronizó')
    console.log('ok: cambio de clave bloquea a los demás hasta escribir la nueva')

    const gone = a.manager.leave({ id, forEveryone: true })
    assert(gone.ok, `eliminar: ${gone.error}`)
    await waitFor(() => b.manager.groups().length === 0, 'B no se enteró de la eliminación')
    assert(existsSync(join(b.folder, 'hola.txt')), 'eliminar el grupo no debe borrar archivos')
    assert(b.manager.discovered().length === 0, 'un grupo eliminado no debe aparecer en la red')
    console.log('ok: eliminar para todos (los archivos quedan en disco)')

    console.log('smoke-sync: OK')
  } finally {
    a.manager.stop()
    b.manager.stop()
    await a.server.stop()
    await b.server.stop()
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('smoke-sync: FAIL', err instanceof Error ? err.message : err)
  process.exit(1)
})
