import { useEffect, useState, type ReactElement } from 'react'
import type { GroupView, SyncStatus } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Button, Input, Modal, PasswordInput, toast } from '../ui'
import { NetworkStatus } from './NetworkStatus'

const MIN_PASSWORD = 4

const SYNC_LABEL: Record<SyncStatus['state'], string> = {
  idle: 'Al día',
  scanning: 'Revisando cambios…',
  syncing: 'Sincronizando…',
  error: 'Error de sincronización'
}

/** One line for the footer and the panel: state first, details after. */
export function syncSummary(group: GroupView): { label: string; tone: 'ok' | 'busy' | 'warn' } {
  if (group.state === 'locked') return { label: 'Clave cambiada', tone: 'warn' }
  if (!group.sync) return { label: 'Sin carpeta', tone: 'warn' }
  const { state } = group.sync
  if (state === 'error') return { label: SYNC_LABEL.error, tone: 'warn' }
  const { pending = 0, done = 0 } = group.sync
  if (state === 'syncing' && pending > 0) {
    const n = Math.min(done + 1, pending)
    return { label: `Recibiendo ${n} de ${plural(pending, 'archivo', 'archivos')}`, tone: 'busy' }
  }
  return { label: SYNC_LABEL[state], tone: state === 'idle' ? 'ok' : 'busy' }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** How often relative times are refreshed while on screen. */
const RELATIVE_TICK_MS = 30_000

/** «justo ahora», «hace N min», «hace N h» or the date for anything older than a day. */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return 'justo ahora'
  if (diff < HOUR) return `hace ${Math.floor(diff / MINUTE)} min`
  if (diff < 24 * HOUR) return `hace ${Math.floor(diff / HOUR)} h`
  return new Date(ts).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
}

/** «Última sincronización: hace 3 min», or a clear note when it never happened. */
export function lastSyncLabel(sync: SyncStatus | null | undefined, now: number = Date.now()): string {
  if (!sync?.lastSyncAt) return 'Aún no se ha sincronizado'
  return `Última sincronización: ${formatRelative(sync.lastSyncAt, now)}`
}

/** Current time, refreshed every 30 s while the caller is mounted. */
export function useNow(intervalMs: number = RELATIVE_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

type Confirm = 'leave' | 'delete' | null

export function GroupPanel({
  group,
  onLeft
}: {
  group: GroupView
  /** The group is gone from this device (left or deleted for everyone). */
  onLeft: () => void
}): ReactElement {
  const api = getApi()
  const [name, setName] = useState(group.name)
  const [password, setPassword] = useState('')
  // Bumped after saving so the field remounts with the password hidden again.
  const [passwordKey, setPasswordKey] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const now = useNow()

  // Follow renames made by other members while the panel stays open.
  useEffect(() => setName(group.name), [group.id, group.name])

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string): Promise<boolean> {
    setBusy(key)
    try {
      const result = await fn()
      if (!result.ok) {
        toast.error(mapIpcError(result.error, 'No se pudo guardar.'))
        return false
      }
      toast.success(done)
      return true
    } finally {
      setBusy(null)
    }
  }

  async function saveName(): Promise<void> {
    const next = name.trim()
    if (!next || next === group.name) return
    await run('name', () => api.updateGroup({ id: group.id, name: next }), 'Nombre actualizado')
  }

  async function savePassword(): Promise<void> {
    if (password.length < MIN_PASSWORD) {
      toast.error(`La clave debe tener al menos ${MIN_PASSWORD} caracteres.`)
      return
    }
    const ok = await run(
      'password',
      () => api.updateGroup({ id: group.id, password }),
      'Clave cambiada. Los demás equipos deberán escribirla.'
    )
    if (ok) {
      setPassword('')
      setPasswordKey((k) => k + 1)
    }
  }

  async function changeFolder(): Promise<void> {
    const folder = await api.selectFolder()
    if (!folder) return
    await run('folder', () => api.updateGroup({ id: group.id, folder }), 'Carpeta cambiada')
  }

  async function leave(forEveryone: boolean): Promise<void> {
    const ok = await run(
      forEveryone ? 'delete' : 'leave',
      () => api.leaveGroup({ id: group.id, forEveryone }),
      forEveryone ? 'Grupo eliminado para todos' : 'Saliste del grupo'
    )
    setConfirm(null)
    if (ok) onLeft()
  }

  const summary = syncSummary(group)
  const sync = group.sync

  return (
    <div className="settings-body group-panel">
      <section className="group-panel-section" aria-labelledby="gp-state">
        <h3 id="gp-state" className="group-panel-title">
          Estado
        </h3>
        <div className="status-bar" role="status" aria-live="polite">
          <span className={`status-dot sync-${summary.tone}`} aria-hidden="true" />
          <span className="status-label">{summary.label}</span>
          {sync ? (
            <span className="url-group-hint">
              {plural(sync.files, 'archivo', 'archivos')}
              {sync.conflicts > 0 ? ` · ${plural(sync.conflicts, 'conflicto', 'conflictos')}` : ''}
            </span>
          ) : null}
        </div>
        {sync ? <p className="url-group-hint">{lastSyncLabel(sync, now)}</p> : null}
        {sync && sync.conflicts > 0 ? (
          <p className="url-group-hint group-panel-conflict">
            Otro equipo editó un archivo a la vez. Compara las dos versiones y borra la que sobre; las copias
            llevan «(conflicto de…)» en el nombre.
          </p>
        ) : null}
        {sync?.error ? <p className="form-error">{sync.error}</p> : null}
        <p className="url-group-hint">
          {group.members.length > 0
            ? `Conectados: ${group.members.join(', ')}`
            : 'Ningún otro miembro conectado ahora.'}
        </p>
      </section>

      <section className="group-panel-section" aria-labelledby="gp-folder">
        <h3 id="gp-folder" className="group-panel-title">
          Carpeta en este equipo
        </h3>
        <p className="mono group-panel-path">{group.folder ?? 'Ninguna'}</p>
        <div className="row">
          {group.folder ? (
            <Button variant="secondary" size="sm" onClick={() => void api.showItemInFolder(group.folder!)}>
              Mostrar
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void changeFolder()}
            loading={busy === 'folder'}
            disabled={busy !== null}
          >
            Cambiar…
          </Button>
        </div>
      </section>

      <section className="group-panel-section" aria-labelledby="gp-name">
        <h3 id="gp-name" className="group-panel-title">
          Nombre
        </h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void saveName()
          }}
        >
          <Input
            id="gp-name-input"
            aria-labelledby="gp-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="md"
            loading={busy === 'name'}
            disabled={busy !== null || !name.trim() || name.trim() === group.name}
          >
            Guardar
          </Button>
        </form>
      </section>

      <section className="group-panel-section" aria-labelledby="gp-password">
        <h3 id="gp-password" className="group-panel-title">
          Clave
        </h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void savePassword()
          }}
        >
          <PasswordInput
            key={passwordKey}
            id="gp-password-input"
            aria-labelledby="gp-password"
            autoComplete="new-password"
            value={password}
            placeholder="Nueva clave"
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="md"
            loading={busy === 'password'}
            disabled={busy !== null || !password}
          >
            Cambiar
          </Button>
        </form>
        <p className="url-group-hint">Cada equipo del grupo tendrá que escribir la clave nueva.</p>
      </section>

      <section className="group-panel-section group-panel-danger" aria-labelledby="gp-exit">
        <h3 id="gp-exit" className="group-panel-title">
          Salir
        </h3>
        <div className="row">
          <Button variant="outline" size="sm" onClick={() => setConfirm('leave')} disabled={busy !== null}>
            Salir del grupo
          </Button>
          <Button variant="danger" size="sm" onClick={() => setConfirm('delete')} disabled={busy !== null}>
            Eliminar para todos
          </Button>
        </div>
        <p className="url-group-hint">Los archivos se quedan en tu carpeta en ambos casos.</p>
      </section>

      <Modal
        open={confirm !== null}
        onClose={() => busy === null && setConfirm(null)}
        title={confirm === 'delete' ? 'Eliminar grupo' : 'Salir del grupo'}
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setConfirm(null)} disabled={busy !== null}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              size="md"
              loading={busy === 'leave' || busy === 'delete'}
              onClick={() => void leave(confirm === 'delete')}
            >
              {confirm === 'delete' ? 'Eliminar para todos' : 'Salir'}
            </Button>
          </>
        }
      >
        <p className="panel-sub" style={{ margin: 0 }}>
          {confirm === 'delete'
            ? `«${group.name}» desaparecerá de todos los equipos y dejará de sincronizarse. Nadie pierde archivos.`
            : `Este equipo deja de sincronizar «${group.name}». Los demás siguen igual.`}
        </p>
      </Modal>
    </div>
  )
}

/** Panel shown from the welcome screen: network checks only. */
export function NetworkPanel(): ReactElement {
  return (
    <div className="settings-body">
      <NetworkStatus />
    </div>
  )
}
