import type { ReactElement } from 'react'
import { cx } from '../utils/cx'
import styles from './LockBadge.module.css'

export function LockBadge({ className }: { className?: string }): ReactElement {
  return (
    <span className={cx(styles.lock, className)} aria-label="Protegida con clave" title="Protegida con clave">
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8 1.5A2.75 2.75 0 0 0 5.25 4.25V6H4.5A1.5 1.5 0 0 0 3 7.5v5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 6h-.75V4.25A2.75 2.75 0 0 0 8 1.5Zm1.25 4.5h-2.5V4.25a1.25 1.25 0 1 1 2.5 0V6Z"
        />
      </svg>
    </span>
  )
}
