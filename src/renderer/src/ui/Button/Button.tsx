import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'
import { cx } from '../utils/cx'

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'success'
type Size = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  children: ReactNode
  variant?: Variant
  size?: Size
  fullWidth?: boolean
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  leftIcon,
  rightIcon,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.ReactElement {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        styles.button,
        styles[`variant-${variant}`],
        styles[`size-${size}`],
        fullWidth && styles.fullWidth,
        loading && styles.loading
      )}
      {...rest}
    >
      {leftIcon && !loading ? <span className={styles.icon}>{leftIcon}</span> : null}
      <span className={styles.label}>{loading ? '…' : children}</span>
      {!loading && rightIcon ? <span className={styles.icon}>{rightIcon}</span> : null}
    </button>
  )
}
