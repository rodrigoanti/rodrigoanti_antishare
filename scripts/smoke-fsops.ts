/**
 * Smoke: mkdir / rename / remove local + remote, with traversal/root rejection.
 * Usage: npx tsx scripts/smoke-fsops.ts
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirLocal, mkdirInShare, removeLocal, renameLocal } from '../src/main/fsOps'
import { startShareServer } from '../src/main/shareServer'
import { remoteMkdir, remoteRemove, remoteRename } from '../src/main/remote'

const stamp = Date.now()
const root = join(tmpdir(), `antishare-fsops-${stamp}`)
const PORT = Number(process.env.ANTISHARE_TEST_PORT || 18768)

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'note.txt'), 'hello\n')

  try {
    const mk = mkdirLocal(root, { path: '', name: 'docs' })
    assert(mk.ok, `mkdir docs: ${mk.error}`)
    assert(existsSync(join(root, 'docs')), 'docs no creado')

    const again = mkdirLocal(root, { path: '', name: 'docs' })
    assert(!again.ok, 'mkdir existente debía fallar (sin sufijo (1))')
    assert(!existsSync(join(root, 'docs (1)')), 'no debe crear docs (1)')

    const nested = mkdirLocal(root, { path: 'docs', name: 'sub' })
    assert(nested.ok, `mkdir docs/sub: ${nested.error}`)

    const badName = mkdirLocal(root, { path: '', name: 'a/b' })
    assert(!badName.ok, 'nombre con / debía fallar')
    const colon = mkdirLocal(root, { path: '', name: 'a:b' })
    assert(!colon.ok, 'nombre con : debía fallar')
    const empty = mkdirLocal(root, { path: '', name: '  ' })
    assert(!empty.ok, 'nombre vacío debía fallar')

    const travMk = mkdirLocal(root, { path: '../outside', name: 'x' })
    assert(!travMk.ok, `mkdir traversal debía fallar: ${travMk.error}`)

    try {
      mkdirInShare(root, '../../etc', 'passwd')
      throw new Error('mkdirInShare traversal no lanzó')
    } catch (e) {
      assert(String(e).toLowerCase().includes('traversal') || String(e).includes('no existe'), String(e))
    }

    const ren = renameLocal(root, { path: 'docs/sub', newName: 'inner' })
    assert(ren.ok, `rename sub→inner: ${ren.error}`)
    assert(existsSync(join(root, 'docs', 'inner')), 'inner no existe')
    assert(!existsSync(join(root, 'docs', 'sub')), 'sub debía desaparecer')

    const renFile = renameLocal(root, { path: 'note.txt', newName: 'readme.txt' })
    assert(renFile.ok, `rename file: ${renFile.error}`)
    assert(existsSync(join(root, 'readme.txt')), 'readme.txt')

    writeFileSync(join(root, 'clash.txt'), 'x')
    const clash = renameLocal(root, { path: 'readme.txt', newName: 'clash.txt' })
    assert(!clash.ok, 'rename que pisa debía fallar')
    assert(existsSync(join(root, 'readme.txt')), 'origen no debía moverse al pisar')

    const renRoot = renameLocal(root, { path: '', newName: 'other' })
    assert(!renRoot.ok, 'rename root debía fallar')
    const renTrav = renameLocal(root, { path: '../x', newName: 'y' })
    assert(!renTrav.ok, 'rename traversal debía fallar')

    const rmFile = removeLocal(root, { path: 'readme.txt' })
    assert(rmFile.ok, `remove file: ${rmFile.error}`)
    assert(!existsSync(join(root, 'readme.txt')), 'readme debía borrarse')

    const rmDir = removeLocal(root, { path: 'docs' })
    assert(rmDir.ok, `remove docs: ${rmDir.error}`)
    assert(!existsSync(join(root, 'docs')), 'docs debía borrarse recursivo')

    const rmRoot = removeLocal(root, { path: '' })
    assert(!rmRoot.ok, 'remove root debía fallar')
    assert(existsSync(root), 'el share root no debe borrarse')
    const rmDot = removeLocal(root, { path: '.' })
    assert(!rmDot.ok, 'remove . debía fallar')
    const rmTrav = removeLocal(root, { path: '../outside' })
    assert(!rmTrav.ok, 'remove traversal debía fallar')

    const handle = await startShareServer({ folder: root, port: PORT, token: 'tok' })
    const baseUrl = `http://127.0.0.1:${PORT}`
    try {
      const noTok = await remoteMkdir({ baseUrl, name: 'remote-docs' })
      assert(!noTok.ok, 'mkdir remoto sin token debía fallar')

      const rmk = await remoteMkdir({ baseUrl, token: 'tok', path: '', name: 'remote-docs' })
      assert(rmk.ok, `remote mkdir: ${rmk.error}`)
      assert(existsSync(join(root, 'remote-docs')), 'remote-docs')

      const rmk2 = await remoteMkdir({ baseUrl, token: 'tok', path: '', name: 'remote-docs' })
      assert(!rmk2.ok, 'remote mkdir existente debía fallar')
      assert(!existsSync(join(root, 'remote-docs (1)')), 'remoto no debe usar (1)')

      const rren = await remoteRename({
        baseUrl,
        token: 'tok',
        path: 'remote-docs',
        newName: 'peer-folder'
      })
      assert(rren.ok, `remote rename: ${rren.error}`)
      assert(existsSync(join(root, 'peer-folder')), 'peer-folder')

      const rrenRoot = await remoteRename({ baseUrl, token: 'tok', path: '', newName: 'x' })
      assert(!rrenRoot.ok, 'remote rename root debía fallar')

      const rrm = await remoteRemove({ baseUrl, token: 'tok', path: 'peer-folder' })
      assert(rrm.ok, `remote remove: ${rrm.error}`)
      assert(!existsSync(join(root, 'peer-folder')), 'peer-folder borrado')

      const rrmRoot = await remoteRemove({ baseUrl, token: 'tok', path: '' })
      assert(!rrmRoot.ok, 'remote remove root debía fallar')
      assert(existsSync(root) && readdirSync(root), 'root intacto tras remote remove')

      const rtrav = await remoteMkdir({ baseUrl, token: 'tok', path: '../x', name: 'y' })
      assert(!rtrav.ok, `remote mkdir traversal: ${rtrav.error}`)

      console.log('local mkdir/rename/remove + rejects OK')
      console.log('remote HTTP mkdir/rename/remove + token/root/traversal OK')
      console.log('OK')
    } finally {
      await handle.stop()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
