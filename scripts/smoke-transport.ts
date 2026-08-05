/**
 * Peer transport smoke test (no Electron window).
 * Usage: npx tsx scripts/smoke-transport.ts
 *
 * Asserts the share server binds IPv4 0.0.0.0 and that peerHttp reaches /api/list
 * over the real LAN address with the socket bound to the matching NIC.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { startShareServer } from '../src/main/shareServer'
import {
  classifyPeerNetworkError,
  peerHttp,
  remoteList,
  shortNetworkReason
} from '../src/main/remote'
import {
  getLanIfaces,
  getLanIPv4,
  localAddressForPeer,
  pickPeerPrimary,
  rankPeerHosts,
  sameSubnetIPv4
} from '../src/main/net'
import type { DirEntry } from '../src/shared/types'

const PORT = Number(process.env.ANTISHARE_TEST_PORT || 18765)
const root = join(tmpdir(), `antishare-transport-${Date.now()}`)

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function listVia(baseUrl: string): Promise<DirEntry[]> {
  const res = await peerHttp(`${baseUrl}/api/list?path=`, { timeoutMs: 4000 })
  assert(res.ok, `HTTP ${res.status} en ${baseUrl}/api/list`)
  return (await res.json()) as DirEntry[]
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'hello.txt'), 'hello-transport\n')

  const handle = await startShareServer({ folder: root, port: PORT })
  const addr = handle.address as AddressInfo | null

  // 1. Server must listen on IPv4 0.0.0.0 (all NICs), not just loopback.
  assert(addr !== null, 'el servidor no expuso address()')
  assert(addr!.family === 'IPv4', `familia esperada IPv4, got ${addr!.family}`)
  assert(addr!.address === '0.0.0.0', `bind esperado 0.0.0.0, got ${addr!.address}`)
  assert(addr!.port === PORT, `puerto efectivo ${addr!.port} != ${PORT}`)
  console.log('listen', addr)

  try {
    // 2. Loopback path.
    const local = await listVia(`http://127.0.0.1:${PORT}`)
    assert(
      local.some((e) => e.name === 'hello.txt'),
      'loopback /api/list no devolvió hello.txt'
    )
    console.log('loopback OK', local.map((e) => e.name))

    // 3. Real LAN path: same route a peer would take, socket bound to that NIC.
    const lanIps = getLanIPv4()
    if (lanIps.length === 0) {
      console.warn('WARN: sin IP LAN; se omite la prueba por interfaz LAN')
    } else {
      for (const ip of lanIps) {
        const bound = localAddressForPeer(ip)
        assert(bound === ip, `localAddress para ${ip} fue ${bound ?? '(none)'}`)
        const entries = await listVia(`http://${ip}:${PORT}`)
        assert(
          entries.some((e) => e.name === 'hello.txt'),
          `LAN /api/list en ${ip} no devolvió hello.txt`
        )
        console.log(`LAN OK ${ip} (localAddress=${bound})`, entries.map((e) => e.name))
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

    // 6. remoteList must walk altBaseUrls when the primary refuses the connection.
    const deadBase = `http://127.0.0.1:${PORT + 1}`
    const goodBase = `http://127.0.0.1:${PORT}`
    const viaAlt = await remoteList({ baseUrl: deadBase, altBaseUrls: [goodBase], path: '' })
    assert(viaAlt.ok, `remoteList no usó el host alternativo: ${viaAlt.ok ? '' : viaAlt.error}`)
    assert(
      (viaAlt.entries ?? []).some((e) => e.name === 'hello.txt'),
      'remoteList por host alternativo no devolvió hello.txt'
    )
    console.log('alt host fallback OK')

    // 7. Total failure must name every attempt instead of one collapsed message.
    const failed = await remoteList({ baseUrl: deadBase, altBaseUrls: [deadBase + '0'], path: '' })
    assert(!failed.ok, 'remoteList debía fallar contra puertos cerrados')
    const err = failed.error ?? ''
    assert(err.includes('Intentos:'), `falta el detalle por host: ${err}`)
    assert(err.includes('ECONNREFUSED'), `falta el código real de red: ${err}`)
    assert(err.includes(`127.0.0.1:${PORT + 1}`), `falta el host primario en el detalle: ${err}`)
    console.log('error reporting OK')

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
    assert(shortNetworkReason(unreach) === 'EHOSTUNREACH', 'shortNetworkReason no expone el código')
    console.log('classification OK')

    console.log('OK')
  } finally {
    await handle.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
