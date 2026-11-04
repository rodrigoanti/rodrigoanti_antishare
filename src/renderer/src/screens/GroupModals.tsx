import { useEffect, useRef, useState, type FormEvent, type ReactElement, type RefObject } from 'react'
import type { GroupView } from '../../../shared/types'
import { getApi, mapIpcError } from '../api'
import { Button, Input, Modal, PasswordInput, toast } from '../ui'

const MIN_PASSWORD = 4

/** Read-only path + "Elegir…": the same folder picker in every group form. */
export function FolderField({
  id,
  value,
  onChange,
  disabled
}: {
  id: string
  value: string
  onChange: (folder: string) => void
  disabled?: boolean
}): ReactElement {
  async function pick(): Promise<void> {
    const folder = await getApi().selectFolder()
    if (folder) onChange(folder)
  }
  return (
    <div className="field">
      <label htmlFor={id}>Carpeta en este equipo</label>
      <div className="row">
        <Input id={id} value={value} readOnly placeholder="Ninguna elegida" />
        <Button variant="secondary" size="md" onClick={() => void pick()} disabled={disabled}>
          Elegir…
        </Button>
      </div>
      <p className="url-group-hint">Si ya tiene archivos, se suman al grupo.</p>
    </div>
  )
}

function useAutofocus(open: boolean): RefObject<HTMLInputElement | null> {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => ref.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open])
  return ref
}

export function CreateGroupModal({
  open,
  initialFolder,
  onClose,
  onCreated
}: {
  open: boolean
  initialFolder?: string
  onClose: () => void
  onCreated: (group: GroupView) => void
}): ReactElement {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useAutofocus(open)

  useEffect(() => {
    if (!open) return
    setName('')
    setPassword('')
    setFolder(initialFolder ?? '')
    setError(null)
  }, [open, initialFolder])

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Ponle un nombre al grupo.')
    if (password.length < MIN_PASSWORD) {
      return setError(`La clave debe tener al menos ${MIN_PASSWORD} caracteres.`)
    }
    if (!folder) return setError('Elige qué carpeta de este equipo se sincroniza.')
    setBusy(true)
    const result = await getApi().createGroup({ name: name.trim(), password, folder })
    setBusy(false)
    if (!result.ok || !result.group) {
      setError(mapIpcError(result.error, 'No se pudo crear el grupo.'))
      return
    }
    toast.success(`Grupo «${result.group.name}» creado`)
    onCreated(result.group)
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Crear grupo"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} loading={busy}>
            Crear
          </Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="group-name">Nombre</label>
          <Input
            ref={nameRef}
            id="group-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej. Diseño"
          />
        </div>
        <div className="field">
          <label htmlFor="group-password">Clave</label>
          <PasswordInput
            id="group-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`Mínimo ${MIN_PASSWORD} caracteres`}
          />
          <p className="url-group-hint">Los demás equipos la usarán para unirse.</p>
        </div>
        <FolderField id="group-folder" value={folder} onChange={setFolder} disabled={busy} />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

/** Join a group found on the network, or re-enter the password of a locked one. */
export function JoinGroupModal({
  target,
  onClose,
  onJoined
}: {
  target: { id: string; name: string; members: string[]; folder?: string | null; locked?: boolean } | null
  onClose: () => void
  onJoined: (group: GroupView) => void
}): ReactElement {
  const [password, setPassword] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useAutofocus(Boolean(target))
  const locked = Boolean(target?.locked)

  useEffect(() => {
    if (!target) return
    setPassword('')
    setFolder(target.folder ?? '')
    setError(null)
  }, [target])

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    if (!target || busy) return
    if (!password) return setError('Escribe la clave del grupo.')
    if (!folder) return setError('Elige qué carpeta de este equipo se sincroniza.')
    setBusy(true)
    const result = await getApi().joinGroup({ id: target.id, password, folder })
    setBusy(false)
    if (!result.ok || !result.group) {
      setError(mapIpcError(result.error, 'No se pudo entrar al grupo.'))
      return
    }
    toast.success(locked ? 'Clave actualizada' : `Te uniste a «${result.group.name}»`)
    onJoined(result.group)
  }

  const members = target?.members ?? []

  return (
    <Modal
      open={Boolean(target)}
      onClose={() => !busy && onClose()}
      title={locked ? `Nueva clave de «${target?.name ?? ''}»` : `Unirse a «${target?.name ?? ''}»`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()} loading={busy}>
            {locked ? 'Desbloquear' : 'Unirse'}
          </Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => void submit(e)}>
        <p className="panel-sub" style={{ margin: 0 }}>
          {locked
            ? 'Otro miembro cambió la clave. Escríbela para seguir sincronizando.'
            : members.length > 0
              ? `Conectados ahora: ${members.join(', ')}.`
              : 'No hay miembros conectados en este momento.'}
        </p>
        <div className="field">
          <label htmlFor="join-password">Clave del grupo</label>
          <PasswordInput
            ref={passwordRef}
            id="join-password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {!locked ? (
          <FolderField id="join-folder" value={folder} onChange={setFolder} disabled={busy} />
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
