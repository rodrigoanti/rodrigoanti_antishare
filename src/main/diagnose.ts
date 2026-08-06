import { createConnection } from 'net'
import {
  DEFAULT_SHARE_PORT,
  DISCOVERY_PORT,
  type NetworkCheck,
  type NetworkDiagnoseResult,
  type ShareStatus
} from '../shared/types'
import type { PeerDiscovery } from './discovery'
import { buildShareUrls, getLanIPv4, localAddressForPeer } from './net'
import { peerHttp } from './remote'
import { loadSettings } from './settings'
import type { ShareServerHandle } from './shareServer'

function check(
  id: string,
  ok: boolean,
  severity: NetworkCheck['severity'],
  messageEs: string,
  hintEs?: string
): NetworkCheck {
  const c: NetworkCheck = { id, ok, severity, messageEs }
  if (hintEs) c.hintEs = hintEs
  return c
}

async function probeHttp(
  url: string,
  token: string | undefined,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const headers: Record<string, string> = {}
    if (token) headers['X-Share-Token'] = token
    const res = await peerHttp(url, { headers, timeoutMs })
    if (res.status === 401 && token) {
      return { ok: false, status: 401, error: 'Token inválido' }
    }
    if (res.status === 401) {
      return { ok: true, status: 401 }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const timedOut =
      msg.includes('Timeout') || msg.includes('aborted') || msg.includes('timeout')
    return { ok: false, error: timedOut ? 'timeout' : msg }
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const localAddress = localAddressForPeer(host)
  return new Promise((resolve) => {
    const socket = createConnection({
      host,
      port,
      ...(localAddress ? { localAddress } : {})
    })
    const done = (ok: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

function buildSummary(checks: NetworkCheck[]): string {
  const fails = checks.filter((c) => !c.ok && c.severity !== 'info')
  const warns = checks.filter((c) => !c.ok && c.severity === 'warn')
  if (fails.some((c) => c.id === 'shareRunning')) {
    return 'El servidor no está compartiendo. Inicia el share para diagnosticar la LAN.'
  }
  if (fails.some((c) => c.id === 'lanIp')) {
    return 'No hay IP LAN. Conéctate a Wi‑Fi o Ethernet e intenta de nuevo.'
  }
  if (fails.some((c) => c.id === 'httpLocal')) {
    return 'HTTP en localhost falló. El share no responde en 127.0.0.1:8765.'
  }
  if (
    checks.find((c) => c.id === 'httpLocal')?.ok &&
    checks.find((c) => c.id === 'httpLan') &&
    !checks.find((c) => c.id === 'httpLan')!.ok
  ) {
    return 'HTTP local OK pero LAN falla → probable bloqueo del Firewall (macOS/Windows) para AntiShare.'
  }
  if (fails.some((c) => c.id === 'udpDiscovery')) {
    return 'UDP discovery no escucha en 8766. Revisa permisos de red o reinicia la app.'
  }
  if (fails.some((c) => c.id.startsWith('peersHttp'))) {
    return 'Hay peers visibles por UDP 8766 pero HTTP/TCP 8765 falla. Revisa firewall inbound, red de invitados y permiso Red local en macOS.'
  }
  if (fails.length === 0 && warns.length === 0) {
    const peers = checks.find((c) => c.id === 'peersSeen')
    if (peers && !peers.ok) {
      return 'Red local OK. Todavía no se ven peers: inicia AntiShare en otra máquina o espera unos segundos.'
    }
    return 'Diagnóstico OK: share, LAN e discovery parecen listos.'
  }
  if (fails.length > 0) {
    return `Hay ${fails.length} problema(s) que bloquean la red. Revisa los checks en rojo.`
  }
  return 'Hay advertencias; la app puede funcionar con limitaciones.'
}

export async function runNetworkDiagnose(opts: {
  share: ShareServerHandle | null
  discovery: PeerDiscovery
}): Promise<NetworkDiagnoseResult> {
  const { share, discovery } = opts
  const settings = loadSettings()
  const token = settings.token
  const running = share != null && share.address !== null
  const status: ShareStatus = running
    ? {
        running: true,
        folder: share!.folder,
        port: DEFAULT_SHARE_PORT,
        urls: buildShareUrls(DEFAULT_SHARE_PORT).all,
        tokenRequired: share!.tokenRequired
      }
    : {
        running: false,
        folder: null,
        port: null,
        urls: [],
        tokenRequired: false
      }

  const checks: NetworkCheck[] = []

  // 1. shareRunning
  checks.push(
    running
      ? check('shareRunning', true, 'info', 'El share está en ejecución.', `Carpeta: ${status.folder}`)
      : check(
          'shareRunning',
          false,
          'error',
          'El servidor no está compartiendo.',
          'Abre Configurar e inicia el share con una carpeta.'
        )
  )

  // 2. lanIp
  const lanIps = getLanIPv4()
  if (lanIps.length === 0) {
    checks.push(
      check(
        'lanIp',
        false,
        'error',
        'No hay IP LAN (Wi‑Fi/Ethernet).',
        'Conéctate a una red local. Sin IP no aparecerás ante otros peers.'
      )
    )
  } else {
    const lanUrls = buildShareUrls(DEFAULT_SHARE_PORT).lan
    checks.push(
      check(
        'lanIp',
        true,
        'info',
        `IP LAN detectada: ${lanIps.join(', ')}.`,
        running && lanUrls.length > 0
          ? `Share alcanzable en: ${lanUrls.join(', ')}.`
          : 'Usa esta IP desde otra máquina en la misma red.'
      )
    )
  }

  // 3. tcpListen
  if (!running) {
    checks.push(
      check(
        'tcpListen',
        false,
        'warn',
        `TCP ${DEFAULT_SHARE_PORT} no está escuchando (share detenido).`,
        'Inicia el share para abrir el puerto.'
      )
    )
  } else {
    const tcpOk = await probeTcp('127.0.0.1', DEFAULT_SHARE_PORT, 1500)
    checks.push(
      tcpOk
        ? check(
            'tcpListen',
            true,
            'info',
            `El puerto TCP ${DEFAULT_SHARE_PORT} acepta conexiones locales.`
          )
        : check(
            'tcpListen',
            false,
            'error',
            `No se pudo conectar a 127.0.0.1:${DEFAULT_SHARE_PORT}.`,
            'Reinicia el share o revisa si otra app ocupa el puerto.'
          )
    )
  }

  // 4. httpLocal
  if (!running) {
    checks.push(
      check('httpLocal', false, 'warn', 'HTTP local no probado (share detenido).')
    )
  } else {
    const local = await probeHttp(
      `http://127.0.0.1:${DEFAULT_SHARE_PORT}/api/list?path=`,
      token,
      3000
    )
    checks.push(
      local.ok
        ? check('httpLocal', true, 'info', 'HTTP local OK (127.0.0.1:8765/api/list).')
        : check(
            'httpLocal',
            false,
            'error',
            `HTTP local falló${local.error ? `: ${local.error}` : '.'}`,
            'El proceso principal no pudo listar la carpeta vía localhost.'
          )
    )
  }

  // 5. httpLan
  const primaryLan = lanIps[0]
  if (!running) {
    checks.push(check('httpLan', false, 'warn', 'HTTP LAN no probado (share detenido).'))
  } else if (!primaryLan) {
    checks.push(
      check('httpLan', false, 'error', 'Sin IP LAN: no se puede probar HTTP por la red.')
    )
  } else {
    const lan = await probeHttp(
      `http://${primaryLan}:${DEFAULT_SHARE_PORT}/api/list?path=`,
      token,
      4000
    )
    const localOk = checks.find((c) => c.id === 'httpLocal')?.ok
    if (lan.ok) {
      checks.push(
        check(
          'httpLan',
          true,
          'info',
          `HTTP LAN OK (${primaryLan}:${DEFAULT_SHARE_PORT}).`
        )
      )
    } else if (lan.error === 'timeout' || !lan.ok) {
      checks.push(
        check(
          'httpLan',
          false,
          'error',
          localOk
            ? `HTTP local OK pero LAN falla (${primaryLan}) → probable bloqueo del Firewall para AntiShare.`
            : `HTTP LAN falló hacia ${primaryLan}:${DEFAULT_SHARE_PORT}${lan.error ? ` (${lan.error})` : ''}.`,
          'En macOS: Ajustes del Sistema → Red → Firewall → permitir AntiShare. No leemos la API del firewall; es un diagnóstico probable.'
        )
      )
    }
  }

  // 6. udpDiscovery
  const udpListening = discovery.isListening()
  const udpBound = discovery.isRecvBound()
  if (udpListening && udpBound) {
    checks.push(
      check(
        'udpDiscovery',
        true,
        'info',
        `UDP discovery escucha en el puerto ${DISCOVERY_PORT}.`
      )
    )
  } else if (udpListening && !udpBound) {
    checks.push(
      check(
        'udpDiscovery',
        false,
        'warn',
        `UDP discovery iniciado pero el socket aún no está bound en ${DISCOVERY_PORT}.`,
        'Espera un segundo y vuelve a diagnosticar.'
      )
    )
  } else {
    checks.push(
      check(
        'udpDiscovery',
        false,
        'error',
        'UDP discovery no escucha.',
        'Reinicia la app. Si persiste, probable bloqueo de red/firewall para UDP 8766.'
      )
    )
  }

  // 7. peersSeen (informational)
  const peers = discovery.list()
  if (peers.length > 0) {
    checks.push(
      check(
        'peersSeen',
        true,
        'info',
        `Se ven ${peers.length} peer(s): ${peers.map((p) => `${p.name} (${p.host})`).join(', ')}.`
      )
    )
  } else {
    checks.push(
      check(
        'peersSeen',
        false,
        'info',
        'Todavía no se detectaron peers en la LAN.',
        'Informativo: inicia AntiShare en otra máquina de la misma red y espera unos segundos.'
      )
    )
  }

  // 8. peersHttp — UDP-visible peers vs TCP/HTTP 8765
  for (const peer of peers) {
    const hosts = [peer.host, ...(peer.hosts ?? [])].filter(
      (h, i, arr) => h && arr.indexOf(h) === i
    )
    for (const host of hosts) {
      const tcpOk = await probeTcp(host, peer.port, 2000)
      const http = await probeHttp(`http://${host}:${peer.port}/api/list?path=`, undefined, 3500)
      const id = `peersHttp:${host}:${peer.port}`
      if (http.ok) {
        checks.push(
          check(
            id,
            true,
            'info',
            `Peer ${peer.name}: UDP visible y HTTP OK en ${host}:${peer.port}.`
          )
        )
        continue
      }
      const detail = [
        tcpOk ? 'TCP ok' : 'TCP falló',
        http.error ? `HTTP ${http.error}` : 'HTTP falló'
      ].join(', ')
      checks.push(
        check(
          id,
          false,
          'error',
          `Peer ${peer.name}: visible por UDP 8766 pero HTTP ${peer.port} falló en ${host} (${detail}).`,
          'Firewall inbound TCP 8765 en esa PC, red de invitados / aislamiento AP, o permiso Red local de macOS. No es un fallo de discovery.'
        )
      )
    }
  }

  return {
    checks,
    summaryEs: buildSummary(checks)
  }
}
