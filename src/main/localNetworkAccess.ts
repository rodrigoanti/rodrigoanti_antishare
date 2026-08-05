import { createSocket } from 'dgram'
import { lookup } from 'dns'
import { hostname } from 'os'
import { net } from 'electron'
import { pickLanProbeTarget } from './net'

let probed = false

/**
 * One-shot LAN probe after a visible window so macOS Sequoia+ can show Local Network TCC.
 * Target is another subnet host (never self/loopback). No retries, no background traffic.
 */
export function requestLocalNetworkAccess(): void {
  if (process.platform !== 'darwin') return
  if (probed) return
  probed = true

  const target = pickLanProbeTarget()
  if (target) {
    try {
      const socket = createSocket({ type: 'udp4' })
      const done = (): void => {
        try {
          socket.close()
        } catch {
          /* ignore */
        }
      }
      socket.once('error', () => done())
      socket.connect(9, target, () => {
        const ping = Buffer.alloc(1)
        try {
          socket.send(ping, () => done())
        } catch {
          done()
        }
      })
    } catch {
      /* best-effort */
    }

    try {
      void net.fetch(`http://${target}:9/`, { signal: AbortSignal.timeout(800) }).catch(() => undefined)
    } catch {
      /* best-effort */
    }
  }

  try {
    lookup(`${hostname()}.local`, () => undefined)
  } catch {
    /* best-effort */
  }
}
