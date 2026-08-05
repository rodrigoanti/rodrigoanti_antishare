import { useEffect, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../utils/cx'
import styles from './ContextMenu.module.css'

export interface ContextMenuItem {
  id: string
  label: string
  danger?: boolean
  onSelect: () => void
}

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose
}: {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): ReactElement | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const onPointer = (): void => onClose()
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <ul
      className={styles.menu}
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <li key={item.id} role="none">
          <button
            type="button"
            role="menuitem"
            className={cx(styles.item, item.danger && styles.danger)}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>,
    document.body
  )
}
