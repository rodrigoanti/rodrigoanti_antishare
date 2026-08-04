import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { Peer } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Button, Input, MachineCard, Modal } from '../ui'

interface MachinesProps {
  onOpenPeer: (peer: Peer, token?: string) => void
}

function isFresh(peer: Peer): boolean {
  if (!peer.lastSeen) return true
  return Date.now() - peer.lastSeen < 12_000
}

export function Machines({ onOpenPeer }: MachinesProps): ReactElement {
  const api = getApi()
  const [peers, setPeers] = useState<Peer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingPeer, setPendingPeer] = useState<Peer | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const tokenInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!pendingPeer) return
    const id = window.setTimeout(() => {
      requestAnimationFrame(() => {
        const el = tokenInputRef.current
        if (!el) return
        el.focus()
        el.select()
      })
    }, 0)
    return () => window.clearTimeout(id)
  }, [pendingPeer])

  useEffect(() => {
    let alive = true

    async function load(): Promise<void> {
      try {
        const list = await api.listPeers()
        if (alive) {
          setPeers(list)
          setError(null)
          setLoading(false)
        }
      } catch (e) {
        if (alive) {
          setError(mapIpcError(e instanceof Error ? e.message : String(e), 'No se pudo listar máquinas.'))
          setLoading(false)
        }
      }
    }

    void load()
    const unsub = api.onPeersUpdate((next) => {
      setPeers(next)
      setLoading(false)
      setError(null)
    })

    return () => {
      alive = false
      unsub()
    }
  }, [api])

  function handleOpen(peer: Peer): void {
    if (peer.tokenRequired) {
      setPendingPeer(peer)
      setTokenDraft('')
      setTokenError(null)
      return
    }
    onOpenPeer(peer)
  }

  function closeTokenModal(): void {
    setPendingPeer(null)
    setTokenDraft('')
    setTokenError(null)
  }

  function confirmToken(e: FormEvent): void {
    e.preventDefault()
    if (!pendingPeer) return
    const value = tokenDraft.trim()
    if (!value) {
      setTokenError('Ingresá la clave para continuar.')
      return
    }
    const peer = pendingPeer
    closeTokenModal()
    onOpenPeer(peer, value)
  }

  return (
    <section className="panel home-panel" aria-labelledby="machines-title">
      <div className="panel-head">
        <h2 id="machines-title">Máquinas</h2>
      </div>

      {loading && <div className="state-box">Buscando en la red…</div>}

      {!loading && peers.length === 0 && !error && (
        <div className="state-box empty">
          Nadie más en la red por ahora. Cuando otra máquina comparta, aparece acá.
        </div>
      )}

      {error && (
        <div className="state-box error" role="alert">
          {error}
        </div>
      )}

      {peers.length > 0 && (
        <ul className="machine-grid" aria-label="Máquinas en la LAN">
          {peers.map((peer) => {
            const online = isFresh(peer)
            const key = peer.baseUrl
            return (
              <li key={key}>
                <MachineCard
                  name={peer.name}
                  online={online}
                  tokenRequired={peer.tokenRequired}
                  title="Clic para abrir la carpeta"
                  onClick={() => handleOpen(peer)}
                />
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={Boolean(pendingPeer)}
        onClose={closeTokenModal}
        title="Clave requerida"
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={closeTokenModal}>
              Cancelar
            </Button>
            <Button variant="primary" size="md" type="submit" form="peer-token-form">
              Abrir
            </Button>
          </>
        }
      >
        <form id="peer-token-form" className="form-grid" onSubmit={confirmToken}>
          <p className="panel-sub" style={{ margin: 0 }}>
            {pendingPeer
              ? `«${pendingPeer.name}» pide una clave para ver su carpeta.`
              : null}
          </p>
          <div className="field">
            <label htmlFor="peer-token">Clave / token</label>
            <Input
              ref={tokenInputRef}
              id="peer-token"
              type="password"
              autoComplete="off"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Ingresá la clave"
            />
          </div>
          {tokenError && (
            <div className="state-box error" role="alert">
              {tokenError}
            </div>
          )}
        </form>
      </Modal>
    </section>
  )
}

/** @deprecated Use Machines — kept for older imports. */
export const Peers = Machines
