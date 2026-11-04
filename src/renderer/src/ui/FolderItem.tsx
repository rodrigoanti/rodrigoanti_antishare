import { useEffect, useRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { EntryGlyph } from './FolderIcon'
import { cx } from './utils/cx'
import styles from './FolderItem.module.css'

export type FinderViewMode = 'icons' | 'list'

/** Matches copies made by syncEngine: «<nombre> (conflicto de <equipo> <fecha>)<ext>». */
const CONFLICT_NAME = /\(conflicto de [^()]+\)(\.[^.]*)?$/

const CONFLICT_HINT = 'Otro equipo editó este archivo a la vez. Compara las dos versiones y borra la que sobre.'

function ConflictTag(): ReactElement {
  return (
    <span className={styles.conflictTag} title={CONFLICT_HINT}>
      <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.5 15 14H1L8 1.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.8" r="0.9" fill="currentColor" />
      </svg>
      Conflicto
    </span>
  )
}

export interface FolderItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  name: string
  kind?: 'folder' | 'file'
  viewMode: FinderViewMode
  selected?: boolean
  status?: string
  badge?: ReactNode
  meta?: string
  /** List view: modified date cell */
  dateLabel?: string
  /** Tooltip for the date (list) or appended to the name tooltip (icons), e.g. «Modificado por PC-Ana · hace 5 min». */
  dateTitle?: string
  /** List view: size cell */
  sizeLabel?: string
  /** Visual cue while preparing remote drag */
  dragPreparing?: boolean
  /** Highlight when this folder is a valid drop target */
  dropActive?: boolean
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
  dateLabel,
  dateTitle,
  sizeLabel,
  dragPreparing = false,
  dropActive = false,
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
  const iconSize = viewMode === 'list' ? 'sm' : 'lg'
  const conflict = kind === 'file' && CONFLICT_NAME.test(name)

  useEffect(() => {
    if (!renaming) return
    const el = renameRef.current
    if (!el) return
    el.focus()
    // Files: select only the base name so typing keeps the extension (like Finder/Explorer).
    const lastDot = kind === 'file' ? el.value.lastIndexOf('.') : -1
    if (lastDot > 0) el.setSelectionRange(0, lastDot)
    else el.select()
  }, [renaming, kind])

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

  const glyph = <EntryGlyph name={name} kind={kind} size={iconSize} />

  if (viewMode === 'list') {
    if (renaming) {
      return (
        <div className={cx(styles.row, styles.selected)} role="group">
          <span className={styles.rowIcon} aria-hidden="true">
            {glyph}
          </span>
          {renameField}
          <span className={styles.rowStatus}>{status ?? '—'}</span>
          <span className={styles.rowMeta}>{dateLabel ?? '—'}</span>
          <span className={styles.rowSize}>{sizeLabel ?? '—'}</span>
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
          dragPreparing && styles.dragPreparing,
          dropActive && styles.dropActive
        )}
        aria-pressed={selected}
        title={name}
        draggable={canDrag}
        onDragStart={onDragStart}
        {...rest}
      >
        <span className={styles.rowIcon} aria-hidden="true">
          {glyph}
        </span>
        <span className={styles.rowName}>
          <span className={styles.rowNameText}>{name}</span>
          {conflict ? <ConflictTag /> : null}
          {badge ? <span className={styles.rowBadge}>{badge}</span> : null}
        </span>
        <span className={styles.rowStatus}>{status ?? '—'}</span>
        <span className={styles.rowMeta} title={dateTitle}>
          {dateLabel ?? '—'}
        </span>
        <span className={styles.rowSize}>{sizeLabel ?? '—'}</span>
      </button>
    )
  }

  if (renaming) {
    return (
      <div className={cx(styles.iconItem, styles.selected)} role="group">
        <span className={styles.iconArt} aria-hidden="true">
          {glyph}
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
        dragPreparing && styles.dragPreparing,
        dropActive && styles.dropActive
      )}
      aria-pressed={selected}
      title={dateTitle ? `${name}\n${dateTitle}` : name}
      draggable={canDrag}
      onDragStart={onDragStart}
      {...rest}
    >
      <span className={styles.iconArt} aria-hidden="true">
        {glyph}
        {badge ? <span className={styles.iconBadge}>{badge}</span> : null}
      </span>
      <span className={styles.iconLabel}>{name}</span>
      {conflict ? <ConflictTag /> : null}
    </button>
  )
}
