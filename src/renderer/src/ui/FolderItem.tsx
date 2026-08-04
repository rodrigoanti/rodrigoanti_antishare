import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
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
  ...rest
}: FolderItemProps): ReactElement {
  const canDrag = kind === 'file' && draggable !== false

  if (viewMode === 'list') {
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
