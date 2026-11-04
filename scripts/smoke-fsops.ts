/**
 * Smoke: mkdir / rename / remove inside a group folder, with traversal/root rejection.
 * Usage: npx tsx scripts/smoke-fsops.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirLocal, mkdirInShare, removeLocal, renameLocal } from '../src/main/fsOps'

const stamp = Date.now()
const root = join(tmpdir(), `antishare-fsops-${stamp}`)

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

    const rmFile = await removeLocal(root, { path: 'readme.txt' })
    assert(rmFile.ok, `remove file: ${rmFile.error}`)
    assert(!existsSync(join(root, 'readme.txt')), 'readme debía borrarse')

    const rmDir = await removeLocal(root, { path: 'docs' })
    assert(rmDir.ok, `remove docs: ${rmDir.error}`)
    assert(!existsSync(join(root, 'docs')), 'docs debía borrarse recursivo')

    const rmRoot = await removeLocal(root, { path: '' })
    assert(!rmRoot.ok, 'remove root debía fallar')
    assert(existsSync(root), 'el share root no debe borrarse')
    const rmDot = await removeLocal(root, { path: '.' })
    assert(!rmDot.ok, 'remove . debía fallar')
    const rmTrav = await removeLocal(root, { path: '../outside' })
    assert(!rmTrav.ok, 'remove traversal debía fallar')

    console.log('local mkdir/rename/remove + rejects OK')
    console.log('OK')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
