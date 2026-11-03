/**
 * Group server transport + security smoke test (no Electron window).
 * Usage: npx tsx scripts/smoke-transport.ts
 *
 * Asserts the group server binds IPv4 0.0.0.0, peerHttp reaches it over the real LAN
 * address with the socket bound to the matching NIC, and /g/ routes only answer
 * requests signed with the group key (no traversal, no symlink escape).
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { deriveGroupKey, signGroupRequest, verifyGroupRequest } from '../src/main/groupAuth'
import { startGroupServer, type GroupServerHooks } from '../src/main/groupServer'
import { classifyPeerNetworkError, peerHttp } from '../src/main/peerHttp'
import {
  getLanIfaces,
  getLanIPv4,
  localAddressForPeer,
  pickPeerPrimary,
  rankPeerHosts,
  sameSubnetIPv4
} from '../src/main/net'

const PORT = Number(process.env.ANTISHARE_TEST_PORT || 18765)
const base = join(tmpdir(), `antishare-transport-${Date.now()}`)
const root = join(base, 'grupo')
const outside = join(base, 'fuera.txt')
const GROUP = 'abcdef123456'
const KEY = deriveGroupKey(GROUP, 'clave-1')

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const hooks: GroupServerHooks = {
  hello: () => ({ name: 'smoke', deviceId: 'device-smoke' }),
  authorize: (id, header, method, path) =>
    id === GROUP && verifyGroupRequest(header, KEY, method, path) !== null,
  meta: (id) =>
    id === GROUP
      ? { id, meta: { name: 'Smoke', deleted: false, rev: 1, at: 1, by: 'x' }, keySince: 1 }
      : null,
  index: () => null,
  rootFor: (id) => (id === GROUP ? root : null),
  notify: () => undefined
}

/** GET signed with `key`, exactly as the sync engine does. */
async function signedGet(url: string, key: string = KEY): Promise<number> {
  const u = new URL(url)
  const res = await peerHttp(url, {
    headers: signGroupRequest(key, 'device-test', 'GET', `${u.pathname}${u.search}`),
    timeoutMs: 4000
  })
  return res.status
}

async function hello(baseUrl: string): Promise<void> {
  const res = await peerHttp(`${baseUrl}/api/hello`, { timeoutMs: 4000 })
  assert(res.ok, `HTTP ${res.status} en ${baseUrl}/api/hello`)
  const body = (await res.json()) as { app?: string }
  assert(body.app === 'antishare', `hello inesperado en ${baseUrl}`)
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'hello.txt'), 'hello-transport\n')
  writeFileSync(outside, 'SECRETO\n')
  symlinkSync(outside, join(root, 'escape'))

  const handle = await startGroupServer({ port: PORT, hooks })
  const addr = handle.address as AddressInfo | null

  // 1. Server must listen on IPv4 0.0.0.0 (all NICs), not just loopback.
  assert(addr !== null, 'el servidor no expuso address()')
  assert(addr!.family === 'IPv4', `familia esperada IPv4, got ${addr!.family}`)
  assert(addr!.address === '0.0.0.0', `bind esperado 0.0.0.0, got ${addr!.address}`)
  assert(addr!.port === PORT, `puerto efectivo ${addr!.port} != ${PORT}`)
  console.log('listen', addr)

  try {
    const local = `http://127.0.0.1:${PORT}`
    // 2. Loopback path.
    await hello(local)
    console.log('loopback OK')

    // 3. Real LAN path: same route a peer would take, socket bound to that NIC.
    const lanIps = getLanIPv4()
    if (lanIps.length === 0) {
      console.warn('WARN: sin IP LAN; se omite la prueba por interfaz LAN')
    } else {
      for (const ip of lanIps) {
        const bound = localAddressForPeer(ip)
        assert(bound === ip, `localAddress para ${ip} fue ${bound ?? '(none)'}`)
        await hello(`http://${ip}:${PORT}`)
        console.log(`LAN OK ${ip} (localAddress=${bound})`)
      }
    }

    // 4. Host selection must trust the UDP source over a look-alike announced IP.
    const ifaces = [{ address: '192.168.100.102', netmask: '255.255.255.0' }]
    const primary = pickPeerPrimary(['192.168.100.238'], '10.7.0.9', ifaces)
    assert(primary === '10.7.0.9', `primary debía ser la IP origen UDP, got ${primary}`)
    const ranked = rankPeerHosts(['192.168.100.238'], '10.7.0.9', ifaces)
    assert(ranked[0] === '10.7.0.9', `ranked[0] debía ser origen UDP, got ${ranked[0]}`)
    assert(ranked.includes('192.168.100.238'), 'la IP anunciada debe quedar como alternativa')
    assert(
      pickPeerPrimary(['192.168.100.238', '10.7.0.9'], '127.0.0.1', ifaces) === '192.168.100.238',
      'sin origen UDP usable debe ganar la IP de la subred local'
    )
    assert(!sameSubnetIPv4('10.7.0.9', '192.168.100.102', '255.255.255.0'), 'sameSubnetIPv4 roto')
    console.log('host selection OK', { primary, ranked })

    // 5. localAddress must stay unset for hosts outside every local subnet.
    assert(
      localAddressForPeer('203.0.113.7') === undefined,
      'no debe bindear localAddress fuera de la subred local'
    )
    assert(getLanIfaces().every((i) => i.address && i.netmask), 'iface LAN sin address/netmask')

    // 6. Group routes: only requests signed with the current key get through.
    const dl = `${local}/g/${GROUP}/download?path=hello.txt`
    assert((await peerHttp(dl, { timeoutMs: 4000 })).status === 401, 'sin firma debía dar 401')
    assert((await signedGet(dl, deriveGroupKey(GROUP, 'otra'))) === 401, 'clave equivocada debía dar 401')
    assert((await signedGet(dl)) === 200, 'firma correcta debía descargar')
    assert((await signedGet(`${local}/g/abcdef999999/meta`)) === 401, 'grupo ajeno debía dar 401')
    const stale = signGroupRequest(KEY, 'device-test', 'GET', `/g/${GROUP}/meta`)
    const [dev, , sig] = stale['X-Group-Auth'].split('.')
    const old = await peerHttp(`${local}/g/${GROUP}/meta`, {
      headers: { 'X-Group-Auth': `${dev}.${Date.now() - 10 * 60_000}.${sig}` },
      timeoutMs: 4000
    })
    assert(old.status === 401, 'una firma vencida debía dar 401')
    const signedForOther = signGroupRequest(KEY, 'device-test', 'GET', `/g/${GROUP}/meta`)
    const replay = await peerHttp(dl, { headers: signedForOther, timeoutMs: 4000 })
    assert(replay.status === 401, 'una firma de otra ruta no debe servir')
    console.log('group auth OK')

    // 7. Signed requests still cannot leave the group folder.
    const trav = await signedGet(`${local}/g/${GROUP}/download?path=${encodeURIComponent('../fuera.txt')}`)
    assert(trav === 403, `traversal debía dar 403, dio ${trav}`)
    const esc = await signedGet(`${local}/g/${GROUP}/download?path=escape`)
    assert(esc === 403 || esc === 404, `symlink hacia afuera debía bloquearse, dio ${esc}`)
    console.log('traversal + symlink escape blocked OK')

    // 8. EHOSTUNREACH (no ARP reply) must not be reported as a generic route problem.
    const unreach = Object.assign(new Error('connect EHOSTUNREACH 192.168.100.238:8765'), {
      code: 'EHOSTUNREACH'
    })
    const msg = classifyPeerNetworkError(unreach, {
      host: '192.168.100.238',
      port: 8765,
      baseUrl: 'http://192.168.100.238:8765'
    })
    assert(msg.includes('EHOSTUNREACH') && msg.includes('ARP'), `clasificación pobre: ${msg}`)
    console.log('classification OK')

    console.log('OK')
  } finally {
    await handle.stop()
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
