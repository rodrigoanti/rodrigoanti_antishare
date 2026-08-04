import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './SidePanel.module.css'
import { cx } from '../utils/cx'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface SidePanelProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  side?: 'left' | 'right'
  footerLayout?: 'row' | 'column'
}

export function SidePanel({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'sm',
  side = 'right',
  footerLayout = 'row'
}: SidePanelProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()

  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }

      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) return

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement

      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'

    const panel = panelRef.current
    const focusTarget = panel?.querySelector<HTMLElement>(FOCUSABLE)
    focusTarget?.focus()

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      previousFocusRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className={cx(styles.overlay, styles[`side-${side}`])}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={cx(styles.panel, styles[`size-${size}`])}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Cerrar">
              ✕
            </button>
          </header>
        ) : null}
        <div className={styles.body}>{children}</div>
        {footer ? (
          <footer
            className={cx(
              styles.footer,
              footerLayout === 'column' ? styles['footer-column'] : styles['footer-row']
            )}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
