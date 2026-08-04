import type { ReactElement, ReactNode } from 'react'
import styles from './Alert.module.css'
import { cx } from '../utils/cx'

export interface AlertProps {
  children: ReactNode
  variant?: 'info' | 'success' | 'danger' | 'warning'
  title?: string
}

export function Alert({ children, variant = 'info', title }: AlertProps): ReactElement {
  return (
    <div className={cx(styles.alert, styles[`variant-${variant}`])} role="alert">
      {title ? <strong className={styles.title}>{title}</strong> : null}
      <div className={styles.body}>{children}</div>
    </div>
  )
}
