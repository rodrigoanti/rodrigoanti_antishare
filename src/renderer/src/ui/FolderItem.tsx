import { useEffect, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { FileIcon, FolderIcon } from './FolderIcon'
import { cx } from './utils/cx'
import styles from './FolderItem.module.css'

export type FinderViewMode = 'icons' | 'list'

export interface FolderItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  name: string
  kind?: 'folder' | 'file'
  viewMode: FinderViewMode
  selected?: boolean
  status?: string
  badge?: ReactNode
  meta?: string
  sizeLabel?: string
  /** Visual cue while preparing remote drag */
  dragPreparing?: boolean
  renaming?: boolean
  renameValue?: string
  onRenameChange?: (value: string) => void
  onRenameCommit?: () => void
  onRenameCancel?: () => void
}

export function FolderItem({
  name,
  kind = 'folder',
  viewMode,
  selected = false,
  status,
  badge,
  meta,
  sizeLabel,
  dragPreparing = false,
  draggable,
  onDragStart,
  renaming = false,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  ...rest
}: FolderItemProps): ReactElement {
  const canDrag = onDragStart != null && draggable !== false && !renaming
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!renaming) return
    const el = renameRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [renaming])

  const renameField = (
    <input
      ref={renameRef}
      className={styles.renameInput}
      value={renameValue ?? name}
      aria-label="Nuevo nombre"
      onChange={(e) => onRenameChange?.(e.target.value)}
      onBlur={() => onRenameCommit?.()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          onRenameCommit?.()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onRenameCancel?.()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )

  if (viewMode === 'list') {
    if (renaming) {
      return (
        <div className={cx(styles.row, styles.selected)} role="group">
          <span className={styles.rowIcon} aria-hidden="true">
            {kind === 'folder' ? <FolderIcon width={28} height={23} /> : <FileIcon width={22} height={28} />}
          </span>
          {renameField}
          <span className={styles.rowStatus}>{status ?? '—'}</span>
          <span className={styles.rowMeta}>{meta ?? sizeLabel ?? '—'}</span>
          <span className={styles.rowBadge} />
        </div>
      )
    }
    return (
      <button
        type="button"
        className={cx(
          styles.row,
          selected && styles.selected,
          canDrag && styles.draggable,
          dragPreparing && styles.dragPreparing
        )}
        aria-pressed={selected}
        draggable={canDrag}
        onDragStart={onDragStart}
        {...rest}
      >
        <span className={styles.rowIcon} aria-hidden="true">
          {kind === 'folder' ? <FolderIcon width={28} height={23} /> : <FileIcon width={22} height={28} />}
        </span>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowStatus}>{status ?? '—'}</span>
        <span className={styles.rowMeta}>{meta ?? sizeLabel ?? '—'}</span>
        {badge ? <span className={styles.rowBadge}>{badge}</span> : <span className={styles.rowBadge} />}
      </button>
    )
  }

  if (renaming) {
    return (
      <div className={cx(styles.iconItem, styles.selected)} role="group">
        <span className={styles.iconArt} aria-hidden="true">
          {kind === 'folder' ? <FolderIcon /> : <FileIcon />}
        </span>
        {renameField}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={cx(
        styles.iconItem,
        selected && styles.selected,
        canDrag && styles.draggable,
        dragPreparing && styles.dragPreparing
      )}
      aria-pressed={selected}
      draggable={canDrag}
      onDragStart={onDragStart}
      {...rest}
    >
      <span className={styles.iconArt} aria-hidden="true">
        {kind === 'folder' ? <FolderIcon /> : <FileIcon />}
        {badge ? <span className={styles.iconBadge}>{badge}</span> : null}
      </span>
      <span className={styles.iconLabel}>{name}</span>
      {status ? <span className={styles.iconStatus}>{status}</span> : null}
    </button>
  )
}
