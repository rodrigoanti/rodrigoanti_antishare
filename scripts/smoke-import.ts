/**
 * Smoke: OS drop-import of files and folders into local + remote shares.
 * Usage: npx tsx scripts/smoke-import.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { importLocalPaths, importRemotePaths } from '../src/main/importFiles'
import { listShareFolder, startShareServer } from '../src/main/shareServer'
import { remoteUpload } from '../src/main/remote'

const stamp = Date.now()
const shareRoot = join(tmpdir(), `antishare-import-share-${stamp}`)
const outside = join(tmpdir(), `antishare-import-src-${stamp}`)
const PORT = Number(process.env.ANTISHARE_TEST_PORT || 18767)

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function seed(): void {
  mkdirSync(shareRoot, { recursive: true })
  mkdirSync(join(outside, 'nested', 'a'), { recursive: true })
  mkdirSync(join(outside, 'empty'), { recursive: true })
  writeFileSync(join(outside, 'hello.txt'), 'import-hello\n')
  writeFileSync(join(outside, 'nested', 'a', 'b.txt'), 'deep\n')
  writeFileSync(join(outside, 'nested', 'readme.txt'), 'top\n')
}

async function main(): Promise<void> {
  seed()
  try {
    const file = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'hello.txt')],
      destPath: ''
    })
    assert(file.ok && file.imported === 1, `local file: ${file.error}`)
    assert(
      readFileSync(join(shareRoot, 'hello.txt'), 'utf8').includes('import-hello'),
      'local file contenido'
    )

    const nested = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'nested')],
      destPath: ''
    })
    assert(nested.ok && (nested.imported ?? 0) >= 1, `local nested: ${nested.error}`)
    assert(readFileSync(join(shareRoot, 'nested', 'a', 'b.txt'), 'utf8').includes('deep'))
    assert(readFileSync(join(shareRoot, 'nested', 'readme.txt'), 'utf8').includes('top'))

    const empty = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'empty')],
      destPath: ''
    })
    assert(empty.ok, `local empty: ${empty.error}`)
    assert(statSync(join(shareRoot, 'empty')).isDirectory(), 'local empty no es carpeta')
    assert(readdirSync(join(shareRoot, 'empty')).length === 0, 'local empty no está vacía')

    const batch = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'hello.txt'), join(outside, 'empty')],
      destPath: ''
    })
    assert(batch.ok && batch.imported === 2, `local batch: ${batch.error}`)
    assert(existsSync(join(shareRoot, 'hello (1).txt')), 'colisión de nombre no uniquificó')

    const trav = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'hello.txt')],
      destPath: '../outside'
    })
    assert(!trav.ok, `traversal dest debía fallar: ${trav.error}`)

    const rel = await importLocalPaths(shareRoot, { sources: ['relative.txt'] })
    assert(!rel.ok, 'origen relativo debía fallar')

    const missing = await importLocalPaths(shareRoot, { sources: [join(outside, 'nope.bin')] })
    assert(!missing.ok, 'origen inexistente debía fallar')

    const self = await importLocalPaths(shareRoot, { sources: [shareRoot] })
    assert(!self.ok, `importar el share en sí mismo debía fallar: ${self.error}`)

    const alreadyThere = await importLocalPaths(shareRoot, {
      sources: [join(shareRoot, 'nested')],
      destPath: ''
    })
    assert(!alreadyThere.ok, `re-drop nested en raíz debía fallar: ${alreadyThere.error}`)
    assert(
      /ya está en este destino/i.test(alreadyThere.error ?? ''),
      `mensaje same-parent: ${alreadyThere.error}`
    )

    const fileAlreadyThere = await importLocalPaths(shareRoot, {
      sources: [join(shareRoot, 'hello.txt')],
      destPath: ''
    })
    assert(!fileAlreadyThere.ok, `re-drop archivo en raíz debía fallar: ${fileAlreadyThere.error}`)
    assert(
      /ya está en este destino/i.test(fileAlreadyThere.error ?? ''),
      `mensaje file same-parent: ${fileAlreadyThere.error}`
    )

    const nestSelf = await importLocalPaths(shareRoot, {
      sources: [join(shareRoot, 'nested')],
      destPath: 'nested'
    })
    assert(!nestSelf.ok, `nest-into-self debía fallar: ${nestSelf.error}`)
    assert(
      /dentro de sí misma/i.test(nestSelf.error ?? ''),
      `mensaje nest-into-self: ${nestSelf.error}`
    )

    const outsideOk = await importLocalPaths(shareRoot, {
      sources: [join(outside, 'hello.txt')],
      destPath: 'nested'
    })
    assert(outsideOk.ok && outsideOk.imported === 1, `copy externo a nested: ${outsideOk.error}`)
    assert(
      readFileSync(join(shareRoot, 'nested', 'hello.txt'), 'utf8').includes('import-hello'),
      'copy externo no llegó a nested'
    )

    const handle = await startShareServer({ folder: shareRoot, port: PORT })
    const baseUrl = `http://127.0.0.1:${PORT}`
    try {
      const single = await remoteUpload({
        baseUrl,
        path: '',
        filePath: join(outside, 'hello.txt')
      })
      assert(single.ok, `remoteUpload archivo: ${single.error}`)

      const remoteFile = await importRemotePaths({
        baseUrl,
        sources: [join(outside, 'hello.txt')],
        destPath: 'inbox'
      })
      assert(remoteFile.ok, `remote file: ${remoteFile.error}`)
      assert(
        readFileSync(join(shareRoot, 'inbox', 'hello.txt'), 'utf8').includes('import-hello'),
        'remote file no llegó'
      )

      const remoteNested = await importRemotePaths({
        baseUrl,
        sources: [join(outside, 'nested')],
        destPath: 'inbox'
      })
      assert(remoteNested.ok, `remote nested: ${remoteNested.error}`)
      assert(
        readFileSync(join(shareRoot, 'inbox', 'nested', 'a', 'b.txt'), 'utf8').includes('deep'),
        'remote nested b.txt'
      )

      const remoteEmpty = await importRemotePaths({
        baseUrl,
        sources: [join(outside, 'empty')],
        destPath: 'inbox'
      })
      assert(remoteEmpty.ok, `remote empty: ${remoteEmpty.error}`)
      assert(statSync(join(shareRoot, 'inbox', 'empty')).isDirectory(), 'remote empty dir')
      assert(readdirSync(join(shareRoot, 'inbox', 'empty')).length === 0, 'remote empty no vacía')

      const listed = listShareFolder(shareRoot, 'inbox')
      const names = listed.map((e) => e.name).sort()
      assert(names.includes('nested') && names.includes('empty') && names.includes('hello.txt'), `inbox: ${names}`)

      const badRemote = await importRemotePaths({
        baseUrl,
        sources: ['not-absolute'],
        destPath: ''
      })
      assert(!badRemote.ok, 'remote origen inválido debía fallar')

      console.log('local file/nested/empty/batch/reject OK')
      console.log('remote file/nested/empty + remoteUpload single OK')
      console.log('OK')
    } finally {
      await handle.stop()
    }
  } finally {
    rmSync(shareRoot, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
