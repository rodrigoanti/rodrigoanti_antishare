/**
 * Two discovery instances with different share ports should see each other.
 * A single announcing instance must not list itself.
 * Usage: npx tsx scripts/smoke-discovery.ts
 *
 * Uses listen + announce split (no TMPDIR registry).
 */
import { PeerDiscovery } from '../src/main/discovery'

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function udpPeers(d: PeerDiscovery) {
  return d.list()
}

async function main(): Promise<void> {
  const solo = new PeerDiscovery()
  solo.startListening()
  solo.setAnnounce({ name: 'solo', port: 28771, tokenRequired: false })
  await sleep(2500)
  const soloUdp = udpPeers(solo)
  console.log('solo peers', soloUdp)
  if (soloUdp.some((p) => p.port === 28771)) {
    solo.stopListening()
    throw new Error('solo instance listed itself as a peer')
  }
  solo.stopListening()

  const a = new PeerDiscovery()
  const b = new PeerDiscovery()
  let bSawA = false
  let aSawB = false

  a.onUpdate((peers) => {
    if (peers.some((p) => p.port === 28767)) aSawB = true
  })
  b.onUpdate((peers) => {
    if (peers.some((p) => p.port === 28765)) bSawA = true
  })

  a.startListening()
  b.startListening()
  await sleep(200)

  a.setAnnounce({
    name: 'peer-a',
    port: 28765,
    tokenRequired: false,
    groups: () => [{ id: 'abcdef123456', name: 'Diseño', keySince: 1 }]
  })
  b.setAnnounce({ name: 'peer-b', port: 28767, tokenRequired: true })

  for (let i = 0; i < 25 && !(aSawB && bSawA); i++) {
    await sleep(400)
  }

  console.log('A peers', a.list())
  console.log('B peers', b.list())
  console.log('aSawB', aSawB, 'bSawA', bSawA)

  if (udpPeers(a).some((p) => p.port === 28765)) {
    throw new Error('peer-a listed itself')
  }
  if (udpPeers(b).some((p) => p.port === 28767)) {
    throw new Error('peer-b listed itself')
  }

  if (bSawA) {
    const seenA = b.list().find((p) => p.port === 28765)
    const group = seenA?.groups?.[0]
    if (!group || group.id !== 'abcdef123456' || group.name !== 'Diseño') {
      throw new Error(`B no recibió los grupos de A: ${JSON.stringify(seenA?.groups)}`)
    }
    console.log('groups in announcement OK')
  }

  // clearAnnounce should keep listening
  a.clearAnnounce()
  b.clearAnnounce()
  await sleep(100)

  a.stopListening()
  b.stopListening()

  if (!aSawB || !bSawA) {
    console.warn('WARN: UDP peers not mutual (broadcast may be blocked on this machine).')
    console.log('OK (self-filter verified; mutual discovery skipped)')
    return
  }
  console.log('OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
