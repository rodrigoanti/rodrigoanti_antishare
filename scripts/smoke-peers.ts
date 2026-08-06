/**
 * Peer lifecycle smoke test: expiry, IP change, restart, and two live instances.
 * Usage: npx tsx scripts/smoke-peers.ts
 *
 * PeerTable is driven with explicit timestamps so TTL cases stay deterministic; the
 * two-instance case uses real UDP sockets on throwaway ports.
 */
import { PeerDiscovery } from '../src/main/discovery'
import { PeerTable, buildPeerRecord, isPeerExpired } from '../src/main/peerTable'
import { PEER_STALE_MS, type Peer } from '../src/shared/types'

const IFACES = [{ address: '192.168.100.102', netmask: '255.255.255.0' }]
const TTL = 10_000

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function hostsOf(peer: Peer | undefined): string[] {
  if (!peer) return []
  return Array.from(new Set([peer.host, ...(peer.hosts ?? [])]))
}

function obs(over: Partial<Parameters<PeerTable['ingest']>[0]> = {}) {
  return {
    name: 'MacBook-de-Oscar.local',
    port: 8765,
    tokenRequired: false,
    fromHost: '192.168.100.238',
    announcedHosts: ['192.168.100.238'],
    at: 1_000_000,
    ...over
  }
}

function testDisconnect(): void {
  const table = new PeerTable({ ttlMs: TTL })
  const t0 = 1_000_000
  assert(table.ingest(obs({ at: t0 }), IFACES), 'primer anuncio debía cambiar la lista')
  assert(table.list(t0).length === 1, 'el peer debía aparecer al anunciarse')

  // Keep-alives must not spam the renderer.
  assert(!table.ingest(obs({ at: t0 + 2000 }), IFACES), 'un keep-alive no debe marcar cambio')

  // Still inside the window after a few lost rounds.
  assert(table.list(t0 + 2000 + TTL - 1).length === 1, 'no debía expirar dentro del TTL')

  // Past the window it is gone from peers:list even before prune runs.
  const late = t0 + 2000 + TTL + 1
  assert(table.list(late).length === 0, 'list() debía excluir al peer vencido')
  assert(table.prune(late), 'prune debía reportar el borrado')
  assert(table.size === 0, 'prune debía eliminar al peer vencido')
  assert(!table.prune(late), 'prune sin vencidos no debe reportar cambios')
  console.log('disconnect OK')
}

function testIpChange(): void {
  const table = new PeerTable({ ttlMs: TTL })
  const t0 = 2_000_000
  table.ingest(obs({ at: t0 }), IFACES)

  // Same machine, new DHCP lease: one entry, and the old address is gone for good.
  const changed = table.ingest(
    obs({ at: t0 + 3000, fromHost: '192.168.100.51', announcedHosts: ['192.168.100.51'] }),
    IFACES
  )
  assert(changed, 'el cambio de IP debía marcar cambio')
  const list = table.list(t0 + 3000)
  assert(list.length === 1, `debía quedar 1 peer, quedaron ${list.length}`)
  assert(list[0].host === '192.168.100.51', `host debía ser el nuevo, es ${list[0].host}`)
  assert(list[0].baseUrl === 'http://192.168.100.51:8765', `baseUrl viejo: ${list[0].baseUrl}`)
  assert(
    !hostsOf(list[0]).includes('192.168.100.238'),
    `la IP vieja sobrevivió: ${hostsOf(list[0]).join(', ')}`
  )

  // Repeated announcements must not resurrect it either.
  table.ingest(
    obs({ at: t0 + 5000, fromHost: '192.168.100.51', announcedHosts: ['192.168.100.51'] }),
    IFACES
  )
  assert(
    !hostsOf(table.list(t0 + 5000)[0]).includes('192.168.100.238'),
    'la IP vieja revivió al fusionar hosts'
  )

  // A peer with several NICs keeps every address it actually announces.
  table.ingest(
    obs({
      at: t0 + 7000,
      fromHost: '192.168.100.51',
      announcedHosts: ['192.168.100.51', '10.8.0.4']
    }),
    IFACES
  )
  const multi = hostsOf(table.list(t0 + 7000)[0])
  assert(multi.includes('10.8.0.4'), `faltó la IP anunciada: ${multi.join(', ')}`)
  assert(multi[0] === '192.168.100.51', `el primario debía ser el origen UDP: ${multi[0]}`)
  console.log('ip change OK')
}

function testRestart(): void {
  const table = new PeerTable({ ttlMs: TTL })
  const t0 = 3_000_000
  table.ingest(obs({ at: t0, announcedHosts: ['192.168.100.238', '10.8.0.9'] }), IFACES)
  const gone = t0 + TTL + 1
  table.prune(gone)
  assert(table.size === 0, 'el peer debía desaparecer al apagarse')

  // Reappears on a new address: rediscovered clean, no leftovers from the old record.
  const back = gone + 60_000
  assert(
    table.ingest(
      obs({ at: back, fromHost: '192.168.100.77', announcedHosts: ['192.168.100.77'] }),
      IFACES
    ),
    'el reingreso debía marcar cambio'
  )
  const list = table.list(back)
  assert(list.length === 1, 'debía redescubrirse una sola vez')
  assert(hostsOf(list[0]).join(',') === '192.168.100.77', `hosts sucios: ${hostsOf(list[0])}`)
  assert(list[0].lastSeen === back, 'lastSeen debía ser el del reingreso')
  console.log('restart OK')
}

function testManualAndGuards(): void {
  const table = new PeerTable({ ttlMs: TTL })
  const t0 = 4_000_000
  table.setManual({
    name: '192.168.1.5:8765',
    host: '192.168.1.5',
    port: 8765,
    tokenRequired: false,
    lastSeen: t0,
    baseUrl: 'http://192.168.1.5:8765',
    hosts: ['192.168.1.5'],
    manual: true
  })
  assert(table.list(t0 + TTL * 10).length === 1, 'un peer manual no debe expirar')
  assert(
    table.ingest(obs({ at: t0, fromHost: '192.168.1.5', announcedHosts: ['192.168.1.5'] }), IFACES),
    'un anuncio sobre un manual debía actualizarlo'
  )
  assert(table.list(t0)[0].manual === true, 'debía conservar la marca manual')
  assert(table.removeManual('192.168.1.5', 8765), 'removeManual debía borrarlo')
  assert(table.size === 0, 'removeManual dejó residuos')

  // Never build a record out of loopback-only announcements.
  assert(
    buildPeerRecord(
      { name: 'x', port: 8765, tokenRequired: false, fromHost: '127.0.0.1' },
      IFACES
    ) === null,
    'no debe crearse un peer sin dirección utilizable'
  )
  const rec = buildPeerRecord(
    { name: 'x', port: 8765, tokenRequired: false, fromHost: '192.168.100.9', at: 5 },
    IFACES
  )
  assert(rec !== null && rec.baseUrl === 'http://192.168.100.9:8765', 'baseUrl mal armado')
  assert(!isPeerExpired({ ...rec!, manual: true }, 1e12, TTL), 'manual no expira')
  assert(isPeerExpired(rec!, 5 + TTL + 1, TTL), 'isPeerExpired no respeta el TTL')
  console.log('manual + guards OK')
}

async function testTwoLiveInstances(): Promise<void> {
  const a = new PeerDiscovery()
  const b = new PeerDiscovery()
  const portA = 28801
  const portB = 28802
  a.startListening()
  b.startListening()
  a.setAnnounce({ name: 'inst-a', port: portA, tokenRequired: false, isServing: () => true })
  b.setAnnounce({ name: 'inst-b', port: portB, tokenRequired: false, isServing: () => true })

  try {
    await wait(5000)
    const aSawB = a.list().some((p) => p.port === portB)
    const bSawA = b.list().some((p) => p.port === portA)
    assert(aSawB && bSawA, `dos instancias activas deben verse (a→b ${aSawB}, b→a ${bSawA})`)
    assert(!a.list().some((p) => p.port === portA), 'A no debe listarse a sí misma')
    console.log('two live instances OK')

    // B stops sharing: A must drop it once the TTL passes.
    b.clearAnnounce()
    await wait(PEER_STALE_MS + 4000)
    assert(
      !a.list().some((p) => p.port === portB),
      `A siguió mostrando a B tras el TTL: ${JSON.stringify(a.list())}`
    )
    console.log('stale peer dropped OK')

    // A share that is not listening must never be announced.
    const c = new PeerDiscovery()
    c.startListening()
    c.setAnnounce({ name: 'inst-c', port: 28803, tokenRequired: false, isServing: () => false })
    await wait(4000)
    assert(!a.list().some((p) => p.port === 28803), 'se anunció un share que no escucha')
    c.stopListening()
    console.log('announce guard OK')
  } finally {
    a.stopListening()
    b.stopListening()
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  assert(PEER_STALE_MS === TTL, `PEER_STALE_MS cambió a ${PEER_STALE_MS}; ajusta la prueba`)
  testDisconnect()
  testIpChange()
  testRestart()
  testManualAndGuards()
  await testTwoLiveInstances()
  console.log('OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
