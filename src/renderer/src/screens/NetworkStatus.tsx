import { useState, type ReactElement } from 'react'
import type { NetworkCheck, NetworkDiagnoseResult } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Alert, Button } from '../ui'

function checkVariant(check: NetworkCheck): 'success' | 'danger' | 'warning' | 'info' {
  if (check.ok) return 'success'
  if (check.severity === 'warn') return 'warning'
  if (check.severity === 'error') return 'danger'
  return 'info'
}

export function NetworkStatus(): ReactElement {
  const api = getApi()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<NetworkDiagnoseResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runDiagnose(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await api.diagnoseNetwork()
      setResult(next)
    } catch (e) {
      setResult(null)
      setError(
        mapIpcError(e instanceof Error ? e.message : String(e), 'No se pudo comprobar la red.')
      )
    }
    setBusy(false)
  }

  return (
    <section className="network-status" aria-labelledby="network-status-title">
      <div className="network-status-head">
        <h3 id="network-status-title">Estado de red</h3>
        <Button variant="secondary" size="sm" onClick={() => void runDiagnose()} loading={busy}>
          Comprobar acceso
        </Button>
      </div>

      {error && (
        <Alert variant="danger" title="Error">
          {error}
        </Alert>
      )}

      {result && (
        <div className="network-status-body">
          <Alert
            variant={result.checks.some((c) => !c.ok && c.severity === 'error') ? 'warning' : 'success'}
            title="Resumen"
          >
            {result.summaryEs}
          </Alert>

          <ul className="network-checks" aria-label="Comprobaciones de red">
            {result.checks.map((check) => (
              <li key={check.id} className={`network-check network-check-${checkVariant(check)}`}>
                <span className="network-check-mark" aria-hidden="true">
                  {check.ok ? '✓' : '✗'}
                </span>
                <div className="network-check-copy">
                  <span className="network-check-msg">{check.messageEs}</span>
                  {!check.ok && check.hintEs ? (
                    <span className="network-check-hint">{check.hintEs}</span>
                  ) : null}
                  {check.ok && check.hintEs ? (
                    <span className="network-check-hint muted">{check.hintEs}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!result && !error && !busy && (
        <p className="network-status-idle muted">
          Comprueba si el share, la IP LAN, HTTP y el descubrimiento UDP están listos.
        </p>
      )}
    </section>
  )
}
