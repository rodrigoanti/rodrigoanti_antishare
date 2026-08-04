/**
 * Smoke test for share HTTP server (no Electron).
 * Usage: npx tsx scripts/smoke-share.ts
 */
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { startShareServer, resolveSafe } from '../src/main/shareServer'

const root = join(tmpdir(), `antishare-smoke-${Date.now()}`)
const outsideFile = join(tmpdir(), `antishare-outside-${Date.now()}.txt`)
const outsideDir = join(tmpdir(), `antishare-outside-dir-${Date.now()}`)

mkdirSync(root, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
writeFileSync(join(root, 'hello.txt'), 'hello-antishare\n')
writeFileSync(outsideFile, 'SECRET_OUTSIDE\n')

// Symlink escape targets
symlinkSync('/etc/passwd', join(root, 'escape-passwd'))
symlinkSync(outsideFile, join(root, 'escape-file'))
symlinkSync(outsideDir, join(root, 'escape-dir'))

async function main(): Promise<void> {
  const handle = await startShareServer({ folder: root, port: 18765 })
  const base = 'http://127.0.0.1:18765'
  console.log('urls', handle.urls)

  // list root (symlink names may appear; opening them must fail)
  const listRes = await fetch(`${base}/api/list?path=`)
  const list = await listRes.json()
  console.log('list', listRes.status, Array.isArray(list) ? list.map((e: { name: string }) => e.name) : list)

  // download normal file
  const dl = await fetch(`${base}/api/download?path=hello.txt`)
  const text = await dl.text()
  console.log('download', dl.status, text.trim())
  if (dl.status !== 200 || !text.includes('hello-antishare')) {
    throw new Error('normal download failed')
  }

  // upload normal
  const boundary = '----SmokeBoundary'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="up.txt"\r\nContent-Type: text/plain\r\n\r\nuploaded\n\r\n--${boundary}--\r\n`
    )
  ])
  const up = await fetch(`${base}/api/upload?path=`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  })
  console.log('upload', up.status, await up.json())
  if (!existsSync(join(root, 'up.txt'))) throw new Error('upload missing')

  // classic .. traversal
  const trav = await fetch(`${base}/api/list?path=../../etc`)
  console.log('traversal', trav.status, await trav.json())
  if (trav.status !== 403) throw new Error('expected 403 for .. traversal')
  try {
    resolveSafe(root, '../../etc/passwd')
    throw new Error('resolveSafe FAIL: should throw')
  } catch (e) {
    console.log('resolveSafe blocked', (e as Error).message)
  }

  // symlink → /etc/passwd: download + list must fail
  const symDl = await fetch(`${base}/api/download?path=escape-passwd`)
  const symDlBody = await symDl.json().catch(() => ({}))
  console.log('symlink download', symDl.status, symDlBody)
  if (symDl.status !== 403 && symDl.status !== 404) {
    throw new Error(`symlink download should be blocked, got ${symDl.status}`)
  }
  if (typeof symDlBody === 'string' && String(symDlBody).includes('root:')) {
    throw new Error('symlink download leaked /etc/passwd')
  }

  const symList = await fetch(`${base}/api/list?path=escape-passwd`)
  console.log('symlink list', symList.status, await symList.json())
  if (symList.status !== 403 && symList.status !== 404 && symList.status !== 400) {
    throw new Error(`symlink list should fail, got ${symList.status}`)
  }

  try {
    resolveSafe(root, 'escape-passwd')
    throw new Error('resolveSafe symlink FAIL: should throw')
  } catch (e) {
    console.log('resolveSafe symlink blocked', (e as Error).message)
  }

  // upload via outbound dir symlink must not write outside
  const planted = join(outsideDir, 'pwned.txt')
  if (existsSync(planted)) rmSync(planted)
  const upBoundary = '----SmokeSymlink'
  const upBody = Buffer.from(
    `--${upBoundary}\r\nContent-Disposition: form-data; name="file"; filename="pwned.txt"\r\nContent-Type: text/plain\r\n\r\npwned\n\r\n--${upBoundary}--\r\n`
  )
  const upEsc = await fetch(`${base}/api/upload?path=escape-dir`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${upBoundary}` },
    body: upBody
  })
  const upEscJson = await upEsc.json().catch(() => ({}))
  console.log('symlink upload', upEsc.status, upEscJson)
  if (existsSync(planted)) {
    throw new Error('upload wrote outside share root via symlink')
  }
  if (upEsc.status === 200) {
    throw new Error('upload via outbound symlink should not succeed')
  }

  // escape-file download blocked
  const escFile = await fetch(`${base}/api/download?path=escape-file`)
  console.log('escape-file download', escFile.status, await escFile.json().catch(() => ({})))
  if (escFile.status === 200) throw new Error('escape-file download should be blocked')

  await handle.stop()
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideFile, { force: true })
  rmSync(outsideDir, { recursive: true, force: true })
  console.log('OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
