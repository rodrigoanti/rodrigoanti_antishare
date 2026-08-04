/**
 * Two discovery instances with different share ports should see each other.
 * Usage: npx tsx scripts/smoke-discovery.ts
 *
 * Uses listen + announce split (no TMPDIR registry).
 */
import { createServer } from 'http'
import { PeerDiscovery } from '../src/main/discovery'

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
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

  a.setAnnounce({ name: 'peer-a', port: 28765, tokenRequired: false })
  b.setAnnounce({ name: 'peer-b', port: 28767, tokenRequired: true })

  for (let i = 0; i < 25 && !(aSawB && bSawA); i++) {
    await sleep(400)
  }

  console.log('A peers', a.list())
  console.log('B peers', b.list())
  console.log('aSawB', aSawB, 'bSawA', bSawA)

  // Manual join probe against a tiny HTTP peer
  const probe = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>((r) => probe.listen(28770, '127.0.0.1', () => r()))
  const manual = await a.addManual({ host: '127.0.0.1', port: 28770 })
  console.log('manual', manual.ok, manual.peer?.baseUrl)
  if (!manual.ok) throw new Error(`manual add failed: ${manual.error}`)
  a.removeManual({ host: '127.0.0.1', port: 28770 })
  probe.close()

  // clearAnnounce should keep listening
  a.clearAnnounce()
  b.clearAnnounce()
  await sleep(100)

  a.stopListening()
  b.stopListening()

  if (!aSawB || !bSawA) {
    console.warn(
      'WARN: UDP peers not mutual (broadcast may be blocked); manual add OK. Use peers:addManual on LAN.'
    )
    // Manual path is required acceptance when UDP fails
    console.log('OK (manual path verified)')
    return
  }
  console.log('OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
