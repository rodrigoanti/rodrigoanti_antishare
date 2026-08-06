import { useCallback, useId, useMemo, useState, type ReactElement } from 'react'
import type { NetworkCheck, NetworkDiagnoseResult } from '../../../shared/types'
import { getApi, isClearBackendMessage } from '../api'
import { Button } from '../ui'

interface PeerReachabilityAlertProps {
  host: string
  baseUrl: string
  /** Alternate LAN IPv4s for the same peer (`peer.hosts`). */
  hosts?: string[]
  /** This machine's LAN IPs, when known (from share URLs). */
  localHosts?: string[]
  /** Original backend / IPC message. Shown verbatim, never rewritten. */
  detail?: string | null
  peerName?: string
  /** Re-runs the same listing call; connection logic stays in the caller. */
  onRetry?: () => unknown
}

/** Max length for a backend message to fit the compact header. */
const INLINE_NOTE_MAX = 110

function hostnameOnly(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      return new URL(trimmed).hostname.replace(/^\[|\]$/g, '')
    }
  } catch {
    /* fall through */
  }
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end > 0) return trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

function uniqueHostnames(values: Array<string | undefined | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    if (!raw) continue
    const host = hostnameOnly(raw)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

function ipv4Prefix24(ip: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  return `${m[1]}.${m[2]}.${m[3]}`
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function portFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).port
  } catch {
    const m = /:(\d+)(?:\/|$)/.exec(baseUrl)
    return m ? m[1] : ''
  }
}

function checkState(check: NetworkCheck): 'ok' | 'error' | 'warn' | 'info' {
  if (check.ok) return 'ok'
  if (check.severity === 'error') return 'error'
  if (check.severity === 'warn') return 'warn'
  return 'info'
}

export function lanHostsFromShareUrls(urls: string[] | undefined): string[] {
  return uniqueHostnames(urls ?? []).filter((h) => !isLoopbackHost(h))
}

export function PeerReachabilityAlert({
  host,
  baseUrl,
  hosts,
  localHosts,
  detail,
  peerName,
  onRetry
}: PeerReachabilityAlertProps): ReactElement {
  const api = getApi()
  const titleId = useId()
  const [retrying, setRetrying] = useState(false)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<NetworkDiagnoseResult | null>(null)
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [live, setLive] = useState('')

  const origin = baseUrl.replace(/\/+$/, '')
  const port = portFromBaseUrl(origin)
  const targetHost = hostnameOnly(host) || hostnameOnly(origin) || host
  const target = port ? `${targetHost}:${port}` : targetHost
  const curl = `curl ${origin}/api/list`
  const backendText = detail?.trim() || ''
  const inlineNote =
    backendText && isClearBackendMessage(backendText) && backendText.length <= INLINE_NOTE_MAX
      ? backendText
      : null

  const peerIps = useMemo(
    () => uniqueHostnames([host, origin, ...(hosts ?? [])]),
    [host, origin, hosts]
  )
  const localIps = useMemo(
    () => uniqueHostnames(localHosts ?? []).filter((h) => !isLoopbackHost(h)),
    [localHosts]
  )
  const otherSubnetIps = useMemo(() => {
    const nets = new Set(localIps.map(ipv4Prefix24).filter((n): n is string => Boolean(n)))
    if (nets.size === 0) return new Set<string>()
    return new Set(
      peerIps.filter((ip) => {
        const net = ipv4Prefix24(ip)
        return net != null && !nets.has(net)
      })
    )
  }, [localIps, peerIps])

  const report = useCallback((): string => {
    const lines = [
      'AntiShare — diagnóstico de conexión',
      `Equipo: ${peerName ?? targetHost}`,
      `Dirección intentada: ${origin}`,
      `IPs conocidas del peer: ${peerIps.join(', ') || '—'}`,
      `IPs de esta máquina: ${localIps.join(', ') || '—'}`,
      `Mensaje del backend: ${backendText || '—'}`
    ]
    if (diagnosis) {
      lines.push('Comprobaciones de red:')
      for (const check of diagnosis.checks) {
        lines.push(
          `  [${check.ok ? 'ok' : 'falla'}] ${check.messageEs}${check.hintEs ? ` — ${check.hintEs}` : ''}`
        )
      }
      lines.push(`Resumen: ${diagnosis.summaryEs}`)
    }
    lines.push(`Comando de verificación: ${curl}`)
    return lines.join('\n')
  }, [backendText, curl, diagnosis, localIps, origin, peerIps, peerName, targetHost])

  async function handleRetry(): Promise<void> {
    if (!onRetry) return
    setRetrying(true)
    setLive('Reintentando la conexión…')
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  async function handleDiagnose(): Promise<void> {
    setDiagnosing(true)
    setDiagnoseError(null)
    setLive('Comprobando la red…')
    try {
      const next = await api.diagnoseNetwork()
      setDiagnosis(next)
      setLive(next.summaryEs)
    } catch (e) {
      setDiagnosis(null)
      setDiagnoseError(e instanceof Error ? e.message : String(e))
      setLive('No se pudo completar la comprobación de red.')
    } finally {
      setDiagnosing(false)
    }
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(report())
      setCopied(true)
      setLive('Diagnóstico copiado al portapapeles.')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
      setLive('No se pudo copiar el diagnóstico.')
    }
  }

  return (
    <section className="conn-error" aria-labelledby={titleId}>
      <div className="conn-error-top">
        <div className="conn-error-headline" role="alert">
          <h2 id={titleId} className="conn-error-title">
            <span className="conn-error-dot" aria-hidden="true" />
            {peerName ? `«${peerName}» no responde` : 'El equipo no responde'}
          </h2>
          <p className="conn-error-meta">
            Intentado: <span className="mono">{target}</span>
            <span className="conn-error-sep" aria-hidden="true">
              ·
            </span>
            visible en la lista por discovery
          </p>
          {inlineNote ? <p className="conn-error-note">{inlineNote}</p> : null}
        </div>
        <div className="conn-error-actions">
          {onRetry ? (
            <Button variant="primary" size="sm" loading={retrying} onClick={() => void handleRetry()}>
              Reintentar
            </Button>
          ) : null}
          <Button
            variant={onRetry ? 'secondary' : 'primary'}
            size="sm"
            loading={diagnosing}
            onClick={() => void handleDiagnose()}
          >
            Diagnosticar
          </Button>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      {diagnosis ? (
        <ol className="conn-steps" aria-label="Comprobaciones de red">
          {diagnosis.checks.map((check) => (
            <li key={check.id} className={`conn-step conn-step-${checkState(check)}`}>
              <span className="conn-step-mark" aria-hidden="true">
                {check.ok ? '✓' : '✗'}
              </span>
              <span className="conn-step-copy">
                <span className="conn-step-msg">
                  <span className="sr-only">{check.ok ? 'Correcto: ' : 'Falla: '}</span>
                  {check.messageEs}
                </span>
                {check.hintEs ? <span className="conn-step-hint">{check.hintEs}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {diagnosis ? <p className="conn-error-summary">{diagnosis.summaryEs}</p> : null}

      {diagnoseError ? (
        <p className="conn-error-summary" role="alert">
          No se pudo completar la comprobación. <span className="mono">{diagnoseError}</span>
        </p>
      ) : null}

      <details className="conn-fold">
        <summary>IPs conocidas</summary>
        <div className="conn-fold-body">
          <p className="conn-fold-label">Este equipo remoto anunció</p>
          <ul className="conn-ip-list">
            {peerIps.map((ip) => (
              <li key={ip}>
                <span className="mono">{ip}</span>
                {otherSubnetIps.has(ip) ? (
                  <span className="conn-tag">distinta de tu segmento /24</span>
                ) : null}
              </li>
            ))}
          </ul>
          {localIps.length > 0 ? (
            <>
              <p className="conn-fold-label">Esta máquina</p>
              <ul className="conn-ip-list">
                {localIps.map((ip) => (
                  <li key={ip}>
                    <span className="mono">{ip}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </details>

      <details className="conn-fold">
        <summary>Detalles técnicos</summary>
        <div className="conn-fold-body">
          <dl className="conn-facts">
            <dt>Dirección</dt>
            <dd className="mono">{origin}</dd>
            {port ? (
              <>
                <dt>Puerto TCP</dt>
                <dd className="mono">{port}</dd>
              </>
            ) : null}
            <dt>Mensaje del backend</dt>
            <dd className="mono conn-facts-raw">{backendText || 'Sin detalle.'}</dd>
            <dt>Verificar a mano</dt>
            <dd className="mono">{curl}</dd>
          </dl>
        </div>
      </details>

      <details className="conn-fold">
        <summary>Qué puedes revisar</summary>
        <div className="conn-fold-body">
          <ol className="conn-tips">
            <li>Que en la otra PC el share esté iniciado.</li>
            <li>
              Correr <span className="mono">{curl}</span> en una terminal de esta máquina.
            </li>
            <li>Si ese comando responde y AntiShare no, el problema es de la app.</li>
            <li>Si tampoco responde, algo entre las dos máquinas corta la conexión.</li>
          </ol>
        </div>
      </details>

      <div className="conn-error-foot">
        <Button variant="ghost" size="sm" onClick={() => void handleCopy()}>
          {copied ? 'Copiado' : 'Copiar diagnóstico'}
        </Button>
      </div>
    </section>
  )
}
