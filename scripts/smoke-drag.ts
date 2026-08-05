/**
 * Smoke: OS drag-out of files and folders (local + remote materialization).
 * Usage: npx tsx scripts/smoke-drag.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join, relative, sep } from 'path'
import { tmpdir } from 'os'
import { startShareServer } from '../src/main/shareServer'
import {
  DRAG_DIR,
  handlePrepareDrag,
  resolveDragTarget,
  resolveLocalDragPath,
  startDragPayload
} from '../src/main/drag'

const root = join(tmpdir(), `antishare-drag-smoke-${Date.now()}`)
const PORT = Number(process.env.ANTISHARE_TEST_PORT || 18766)

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function underRoot(abs: string, expectedRel: string): boolean {
  const realRoot = realpathSync(root)
  const realAbs = realpathSync(abs)
  const rel = relative(realRoot, realAbs).split(sep).join('/')
  return rel === expectedRel
}

function walk(dir: string, rel = ''): string[] {
  const abs = rel ? join(dir, rel) : dir
  const st = statSync(abs)
  if (st.isFile()) return [rel]
  const names = readdirSync(abs).sort()
  const out: string[] = rel ? [`${rel}/`] : []
  for (const name of names) {
    out.push(...walk(dir, rel ? `${rel}/${name}` : name))
  }
  return out
}

function seedTree(): void {
  mkdirSync(join(root, 'empty'), { recursive: true })
  mkdirSync(join(root, 'nested', 'a'), { recursive: true })
  writeFileSync(join(root, 'nested', 'a', 'b.txt'), 'deep-file\n')
  mkdirSync(join(root, 'mixed', 'sub'), { recursive: true })
  mkdirSync(join(root, 'mixed', 'empty2'), { recursive: true })
  writeFileSync(join(root, 'mixed', 'readme.txt'), 'readme\n')
  writeFileSync(join(root, 'mixed', 'sub', 'photo.bin'), Buffer.from([1, 2, 3, 4]))
  writeFileSync(join(root, 'hello.txt'), 'hello-drag\n')
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true })
  seedTree()

  try {
    // Local file: same path, no copy.
    const localFile = await handlePrepareDrag({ kind: 'local', path: 'hello.txt', isDir: false }, root)
    assert(localFile.ok && localFile.filePath && underRoot(localFile.filePath, 'hello.txt'), `local file: ${localFile.error}`)
    assert(statSync(localFile.filePath!).isFile(), 'local file no es archivo')

    // Local empty folder: same path, still empty.
    const localEmpty = await handlePrepareDrag({ kind: 'local', path: 'empty', isDir: true }, root)
    assert(localEmpty.ok && localEmpty.filePath && underRoot(localEmpty.filePath, 'empty'), `local empty: ${localEmpty.error}`)
    assert(statSync(localEmpty.filePath!).isDirectory(), 'local empty no es carpeta')
    assert(readdirSync(localEmpty.filePath!).length === 0, 'local empty no está vacía')

    // Local nested folder.
    const localNested = await handlePrepareDrag({ kind: 'local', path: 'nested', isDir: true }, root)
    assert(localNested.ok && localNested.filePath && underRoot(localNested.filePath, 'nested'), `local nested: ${localNested.error}`)
    assert(
      walk(localNested.filePath!).join(',') === 'a/,a/b.txt',
      `local nested walk: ${walk(localNested.filePath!).join(',')}`
    )

    // Local mixed folder.
    const localMixed = await handlePrepareDrag({ kind: 'local', path: 'mixed', isDir: true }, root)
    assert(localMixed.ok && localMixed.filePath && underRoot(localMixed.filePath, 'mixed'), `local mixed: ${localMixed.error}`)
    assert(
      walk(localMixed.filePath!).join(',') === 'empty2/,readme.txt,sub/,sub/photo.bin',
      `local mixed walk: ${walk(localMixed.filePath!).join(',')}`
    )

    // Traversal rejected.
    const trav = resolveLocalDragPath(root, '../outside')
    assert(!trav.ok && (trav.error || '').toLowerCase().includes('traversal'), `traversal: ${trav.error}`)
    assert(!resolveDragTarget(join(root, 'missing')).ok, 'missing path debía fallar')
    assert(resolveDragTarget(join(root, 'empty')).ok, 'resolveDragTarget carpeta')
    assert(resolveDragTarget(join(root, 'hello.txt')).ok, 'resolveDragTarget archivo')

    const payload = startDragPayload(join(root, 'mixed'))
    assert(payload.file === join(root, 'mixed'), 'startDragPayload.file')
    if (process.platform === 'win32') {
      assert(payload.files?.[0] === payload.file, 'Windows debe pasar files[]')
    }

    const handle = await startShareServer({ folder: root, port: PORT })
    const baseUrl = `http://127.0.0.1:${PORT}`
    try {
      // Remote file still works.
      const remoteFile = await handlePrepareDrag(
        { kind: 'remote', baseUrl, path: 'hello.txt', isDir: false },
        root
      )
      assert(remoteFile.ok && remoteFile.filePath, `remote file: ${remoteFile.error}`)
      assert(statSync(remoteFile.filePath!).isFile(), 'remote file no es archivo')
      assert(readFileSync(remoteFile.filePath!, 'utf8').includes('hello-drag'), 'remote file contenido')
      assert(remoteFile.filePath!.startsWith(DRAG_DIR), 'remote file debe vivir en DRAG_DIR')
      rmSync(remoteFile.filePath!, { force: true })

      // Remote empty folder.
      const remoteEmpty = await handlePrepareDrag(
        { kind: 'remote', baseUrl, path: 'empty', isDir: true },
        root
      )
      assert(remoteEmpty.ok && remoteEmpty.filePath, `remote empty: ${remoteEmpty.error}`)
      assert(statSync(remoteEmpty.filePath!).isDirectory(), 'remote empty no es carpeta')
      assert(basename(remoteEmpty.filePath!) === 'empty', `nombre raíz: ${remoteEmpty.filePath}`)
      assert(readdirSync(remoteEmpty.filePath!).length === 0, 'remote empty no está vacía')
      rmSync(remoteEmpty.filePath!, { recursive: true, force: true })

      // Remote nested.
      const remoteNested = await handlePrepareDrag(
        { kind: 'remote', baseUrl, path: 'nested', isDir: true },
        root
      )
      assert(remoteNested.ok && remoteNested.filePath, `remote nested: ${remoteNested.error}`)
      assert(
        walk(remoteNested.filePath!).join(',') === 'a/,a/b.txt',
        `remote nested walk: ${walk(remoteNested.filePath!).join(',')}`
      )
      assert(readFileSync(join(remoteNested.filePath!, 'a', 'b.txt'), 'utf8').includes('deep-file'))
      rmSync(remoteNested.filePath!, { recursive: true, force: true })

      // Remote mixed.
      const remoteMixed = await handlePrepareDrag(
        { kind: 'remote', baseUrl, path: 'mixed', isDir: true },
        root
      )
      assert(remoteMixed.ok && remoteMixed.filePath, `remote mixed: ${remoteMixed.error}`)
      assert(
        walk(remoteMixed.filePath!).join(',') === 'empty2/,readme.txt,sub/,sub/photo.bin',
        `remote mixed walk: ${walk(remoteMixed.filePath!).join(',')}`
      )
      assert(readFileSync(join(remoteMixed.filePath!, 'readme.txt'), 'utf8').includes('readme'))
      assert(
        Buffer.compare(
          readFileSync(join(remoteMixed.filePath!, 'sub', 'photo.bin')),
          Buffer.from([1, 2, 3, 4])
        ) === 0,
        'photo.bin corrupto'
      )
      rmSync(remoteMixed.filePath!, { recursive: true, force: true })

      // Remote traversal.
      const remoteTrav = await handlePrepareDrag(
        { kind: 'remote', baseUrl, path: '../outside', isDir: true },
        root
      )
      assert(!remoteTrav.ok, `remote traversal debía fallar: ${remoteTrav.error}`)

      console.log('local empty/nested/mixed OK')
      console.log('remote empty/nested/mixed OK')
      console.log('file drag still OK')
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
